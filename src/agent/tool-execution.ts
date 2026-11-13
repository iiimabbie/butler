import { executeAgentReach } from '../tools/agent-reach-tools.js';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { codeExecuteDefinition, executeCode } from '../subagent/code-mode.js';
import { isRecord, validateToolArgs } from '../tools/tool-schema.js';
import { memoryTagsDefinition, listMemoryTagsTool } from '../memory/memory-tools.js';
import { knowledgePageCreateDefinition, knowledgePageCreateTool } from '../memory/knowledge-tools.js';
import { DiscordReactionInputError, errorMessage, ToolUsageError, WebFetchExtractionError, WebPoolError } from '../tools/tool-errors.js';
import type { Store, ToolRecord } from '../store.js';
import type { GoogleToolRuntime } from '../tools/google-tools.js';
import { formatRecall } from '../memory/hindsight.js';
import { logError, logInfo, logWarn } from '../log.js';
import { emitProgress } from './progress.js';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../timezone.js';
import { formatTranscript, validateTranscriptDate } from './journal-transcript.js';
import { runSubagent, subagentDefinitions, validateSubagentModel } from '../subagent/subagent.js';
import type { AgentConfig } from './agent.js';
import type { FunctionCall } from './model-request.js';

const pageProperties = (maxLimit: number) => ({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: maxLimit } });
const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

export const tools = [
  codeExecuteDefinition,
  memoryTagsDefinition,
  knowledgePageCreateDefinition,
  {
    type: 'function', name: 'history_list', description: 'List stored tool-call records for a session, newest first; Omit session_id or pass an empty string ("") to use the current session; a non-empty string selects that session. Use this to locate earlier operations and their record IDs. offset counts records (default 0); limit defaults to 20, maximum 100. Each result contains a 500-character preview; use the page next_offset for more records and history_get with the record id for the remaining result.',
    parameters: objectSchema({ ...pageProperties(100), session_id: { type: 'string' } }, []),
  },
  {
    type: 'function', name: 'history_get', description: 'Read a stored tool-call record by id, including its arguments, execution status, timestamps and paginated result text. offset counts result characters (default 0); limit defaults to 4000, maximum 100000. Continue with result.next_offset. discord_attach_to_reply, image_generate and image_save records also include delivery status. A historical operation result records the outcome at that time, not the current state of the external resource.',
    parameters: objectSchema({ id: { type: 'string', minLength: 1 }, ...pageProperties(100_000) }, ['id']),
  },
  {
    type: 'function', name: 'history_search', description: 'Search stored tool-call records across sessions by tool name, arguments or result text using SQLite LIKE matching (% matches any sequence; _ matches one character). This searches operation records, not conversation messages or semantic memory. Results are newest first; offset counts records (default 0), limit defaults to 20, maximum 100. Results include 500-character previews; use the page next_offset for more records and history_get for complete result content.',
    parameters: objectSchema({ query: { type: 'string', minLength: 1 }, ...pageProperties(100) }, ['query']),
  },
  { type: 'function', name: 'journal_transcript_by_date', description: 'Read Butler-recorded pure Discord conversation text for a complete YYYY-MM-DD date across all current and archived sessions in channels that currently allow memory writes, including human and third-party bot messages and Butler text actually delivered to Discord. The date uses the configured schedule timezone. This reads conversation, not tool calls/results or long-term memory; internal scheduled inputs are excluded. Results can change as later messages arrive. offset is a character offset (default 0), limit defaults to 4000 and maximum 100000; continue from next_offset until null. Records include only content Butler has captured.', parameters: objectSchema({ date: { type: 'string', description: '完整日期 YYYY-MM-DD' }, ...pageProperties(100_000) }, ['date']) },
  { type: 'function', name: 'memory_recall', description: 'Retrieve relevant memories from shared long-term conversation history across sessions. Use to remember past conversations, preferences, relationships, decisions, experiences, and ongoing activities. Include relevant people, topics, Discord account IDs, or time context in the query when useful. Returns matching memory records rather than a complete conversation log. Use remembered information naturally without unnecessary evidence disclaimers. An empty result does not establish that something never happened.', parameters: objectSchema({ query: { type: 'string', minLength: 1 } }, ['query']) },
  { type: 'function', name: 'memory_reflect', description: 'Synthesize useful answers from shared long-term memories, including personal preferences, relationships, past decisions, changing circumstances, and connections across conversations. Ask a specific question identifying relevant people, topics, and dates when useful. Returns a generated synthesis with supporting memory references. Answer naturally and prioritize useful information over repetitive evidence qualifications. Preserve meaningful uncertainty, corrections, and contradictions without inventing missing facts. Use memory_recall when individual memory records are needed.', parameters: objectSchema({ query: { type: 'string', minLength: 1 } }, ['query']) },
];

// Tools whose arguments this module validates against their own schema; the other tool modules validate their own.
const validatedSchemas = new Map<string, { properties: Record<string, unknown>; required: string[] }>(
  [...tools.filter(tool => /^(history_|journal_|memory_re)/.test(tool.name)), ...subagentDefinitions].map(tool => [tool.name, tool.parameters as { properties: Record<string, unknown>; required: string[] }]),
);

function subagentExecutor(store: Store, session: string, id: string, config: AgentConfig, model: string): (signal: AbortSignal, runId: string, taskText: string, resume: boolean) => Promise<string> {
  return (signal, runId, _taskText, resume) => {
    if (!config.subagent || !config.subagentCoordinator) throw new Error('Subagent is unavailable in the current runtime');
    // A model switch queued during a run applies when the inbox resumes the thread.
    if (resume) model = store.getSubagentWindow(id, session)?.model ?? model;
    return runSubagent({
      baseUrl: config.baseUrl, apiKey: config.apiKey, store, parentSession: session, signal, model,
      loadMessages: () => config.subagentCoordinator!.loadMessages(id, runId),
      consumeMessages: ids => config.subagentCoordinator!.consumeMessages(id, runId, ids),
      onActivity: patch => config.subagentCoordinator!.updateActivity(id, runId, patch),
    }, id);
  };
}

export async function executeCall(store: Store, session: string, call: FunctionCall, config: AgentConfig, googleRuntime: GoogleToolRuntime | undefined, availableToolNames: ReadonlySet<string>, queueInput: (item: unknown) => void): Promise<unknown> {
  logInfo('tool_call', { tool: call.name, source: 'agent', sessionId: session, callId: call.call_id });
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (!isRecord(parsed)) throw new Error('Tool arguments must be a JSON object');
    args = parsed;
  } catch (error) {
    const id = store.beginTool(session, call.name, { raw_arguments: call.arguments });
    emitProgress(config, { type: 'tool_start', callId: call.call_id, toolName: call.name });
    const result = { error: errorMessage(error) };
    store.finishTool(id, 'failed', result);
    emitProgress(config, { type: 'tool_end', callId: call.call_id, toolName: call.name, status: 'failed', error: errorMessage(error) });
    return { tool_history_id: id, ...result };
  }

  const subagentManagementNames = new Set(['subagent_run', 'subagent_list', 'subagent_status', 'subagent_send', 'subagent_stop']);
  if (subagentManagementNames.has(call.name) && config.subagent?.toolsEnabled === false) {
    const internalHandoffAllowed = config.subagentEvent && ['subagent_send', 'subagent_stop'].includes(call.name);
    if (!internalHandoffAllowed) throw new ToolUsageError('Subagent management tools are disabled');
  }
  const id = store.beginTool(session, call.name, args);
  const label = typeof args.label === 'string' ? args.label.trim() : '';
  const { label: _label, ...runtimeArgs } = args;
  emitProgress(config, { type: 'tool_start', callId: call.call_id, toolName: call.name, args: runtimeArgs, ...(label ? { description: label } : {}) });
  let result: unknown;
  try {
    const schema = validatedSchemas.get(call.name);
    if (schema) validateToolArgs(schema.properties, schema.required, runtimeArgs);
    if (call.name === 'code_execute') {
      result = await executeCode(runtimeArgs, {
        available: name => availableToolNames.has(name), callId: call.call_id,
        execute: (name, args, callId) => executeCall(store, session, { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }, config, googleRuntime, availableToolNames, queueInput),
      });
    } else if (call.name === 'subagent_run') {
      if (!config.subagent || !config.subagentCoordinator) throw new ToolUsageError('Subagent is unavailable');
      const task = { task: runtimeArgs.task as string, context: runtimeArgs.context as string, constraints: runtimeArgs.constraints as string, expected_output: runtimeArgs.expected_output as string };
      const model = await validateSubagentModel(runtimeArgs.model as string, config.baseUrl, config.apiKey, config.subagent.allowClaude);
      const cwd = runtimeArgs.cwd as string;
      if (!isAbsolute(cwd)) throw new ToolUsageError('Subagent cwd must be an absolute path to an existing directory');
      try { if (!statSync(cwd).isDirectory()) throw new Error('Not a directory'); }
      catch { throw new ToolUsageError('Subagent cwd must be an absolute path to an existing directory'); }
      const windowId = store.createSubagentWindow(session, model, cwd, task);
      result = config.subagentCoordinator.start({ id: windowId, parentSession: session, task: task.task, origin: config.subagentOrigin, execute: subagentExecutor(store, session, windowId, config, model) });
    } else if (call.name === 'subagent_list') {
      if (!config.subagentCoordinator) throw new ToolUsageError('Subagent is unavailable');
      result = { items: config.subagentCoordinator.list(session, (runtimeArgs.offset ?? 0) as number, (runtimeArgs.limit ?? 20) as number) };
    } else if (call.name === 'subagent_status') {
      if (!config.subagentCoordinator) throw new ToolUsageError('Subagent is unavailable');
      result = config.subagentCoordinator.status(runtimeArgs.subagent_id as string, session, (runtimeArgs.offset ?? 0) as number, (runtimeArgs.limit ?? 20) as number) ?? { error: 'Unknown subagent window for this parent session' };
    } else if (call.name === 'subagent_stop') {
      if (!config.subagent || !config.subagentCoordinator) throw new ToolUsageError('Subagent is unavailable');
      result = config.subagentCoordinator.stop(runtimeArgs.subagent_id as string, session, runtimeArgs.reason as string);
    } else if (call.name === 'subagent_send') {
      if (!config.subagent || !config.subagentCoordinator) throw new ToolUsageError('Subagent is unavailable');
      const subagentId = runtimeArgs.subagent_id as string;
      const window = store.getSubagentWindow(subagentId, session);
      if (!window) throw new ToolUsageError('Unknown subagent window for this parent session; use subagent_list to find the actual ID.');
      const model = await validateSubagentModel((runtimeArgs.model as string | undefined) ?? window.model, config.baseUrl, config.apiKey, config.subagent.allowClaude);
      store.setSubagentModel(window.id, model);
      const resume = subagentExecutor(store, session, subagentId, config, model);
      result = config.subagentCoordinator.message(subagentId, session, runtimeArgs.message as string, resume);
    } else if (call.name === 'memory_tags_list') {
      if (!config.hindsight) throw new ToolUsageError('Shared memory is unavailable');
      result = await listMemoryTagsTool(config.hindsight, runtimeArgs);
    } else if (call.name === 'knowledge_page_create') {
      if (!config.hindsight) throw new ToolUsageError('Shared memory is unavailable');
      result = await knowledgePageCreateTool(config.hindsight, runtimeArgs, config.memoryWriteAllowed);
    } else if (call.name === 'memory_recall' || call.name === 'memory_reflect') {
      if (!config.hindsight) throw new ToolUsageError('Shared memory is unavailable');
      const query = runtimeArgs.query as string;
      result = call.name === 'memory_recall'
        ? formatRecall(await config.hindsight.recall(query))
        : await config.hindsight.reflect(query);
    } else if (call.name.startsWith('hledger_')) {
      if (!config.hledgerTools) throw new ToolUsageError('hledger tools are unavailable');
      result = await config.hledgerTools.execute(call.name, runtimeArgs);
    } else if (call.name.startsWith('weather_')) {
      if (!config.weatherTools) throw new ToolUsageError('Weather tools are unavailable in this entry point');
      result = await config.weatherTools.execute(call.name, runtimeArgs);
    } else if (call.name.startsWith('web_')) {
      if (!config.webTools) throw new ToolUsageError('Web tools are unavailable in this entry point');
      result = await config.webTools.execute(call.name, runtimeArgs);
    } else if (call.name === 'agent_reach') {
      if (!config.localTools) throw new ToolUsageError('Agent Reach is unavailable in this entry point');
      result = await executeAgentReach(runtimeArgs);
    } else if (call.name.startsWith('local_') || call.name === 'butler_deploy') {
      if (!config.localTools) throw new ToolUsageError('Local tools are unavailable in this entry point');
      result = await config.localTools.execute(call.name, runtimeArgs, { channelId: config.discordContext?.channelId ?? (config.subagentEvent ? config.discordTools?.context.channelId : undefined), queueInput });
    } else if (call.name.startsWith('discord_')) {
      if (!config.discordTools) throw new ToolUsageError('Discord tools are unavailable in this entry point');
      result = await config.discordTools.execute(call.name, runtimeArgs);
      if (call.name === 'discord_attach_to_reply') config.discordTools.context.attachmentToolCallIds?.push(id);
    } else if (call.name.startsWith('google_')) {
      if (!googleRuntime) throw new ToolUsageError('Google tools are unavailable until Google is connected');
      result = await googleRuntime.execute(call.name, runtimeArgs);
    } else if (call.name.startsWith('skills_')) {
      if (!config.skillsTools) throw new ToolUsageError('Skills tools are unavailable in this entry point');
      result = await config.skillsTools.execute(call.name, runtimeArgs);
    } else if (call.name.startsWith('schedule_')) {
      if (!config.scheduleTools) throw new ToolUsageError('Schedule tools are unavailable in this entry point');
      result = await config.scheduleTools.execute(call.name, runtimeArgs);
    } else if (call.name === 'image_generate' || call.name === 'image_save') {
      if (!config.imageTools) throw new ToolUsageError('Image tools are unavailable in this entry point');
      result = await config.imageTools.execute(call.name, runtimeArgs);
      config.discordTools?.context.attachmentToolCallIds?.push(id);
    } else {
      result = runTool(store, session, call.name, runtimeArgs, config.transcriptTimezone ?? DEFAULT_SCHEDULE_TIMEZONE);
    }
  } catch (error) {
    if ((error as { auditPersistenceFailure?: boolean })?.auditPersistenceFailure) throw error;
    if (error instanceof DiscordReactionInputError) logError(`Tool reaction input rejected tool=${call.name} session=${session} audit=${id}`, error, { notify: false });
    else if (error instanceof WebPoolError && !error.notify) logWarn(`Web request ended tool=${call.name}`, undefined, { category: error.message });
    else if (error instanceof WebFetchExtractionError) logError(`Tool execution fallback available tool=${call.name} session=${session} audit=${id}`, error, { notify: false });
    else if (!(error instanceof ToolUsageError)) logError(`Tool execution failed tool=${call.name} session=${session} audit=${id}`, error, { notify: true, deduplicationKey: `Tool execution failed tool=${call.name} session=${session}` });
    result = { error: errorMessage(error) };
    try { store.finishTool(id, 'failed', result); } catch (persistError) { throw Object.assign(persistError instanceof Error ? persistError : new Error(String(persistError)), { auditPersistenceFailure: true }); }
    emitProgress(config, { type: 'tool_end', callId: call.call_id, toolName: call.name, status: 'failed', error: errorMessage(error) });
    const subagentId = call.name === 'subagent_run' ? (error as { subagent_id?: string })?.subagent_id : undefined;
    return { tool_history_id: id, ...(result as Record<string, unknown>), ...(subagentId !== undefined ? { subagent_id: subagentId } : {}) };
  }
  // Persistence failures are intentionally outside the tool execution catch. Do not replay a completed tool.
  try { store.finishTool(id, 'completed', result); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { auditPersistenceFailure: true }); }
  const displayedError = hasToolError(result) ? errorMessage(result.error) : undefined;
  emitProgress(config, { type: 'tool_end', callId: call.call_id, toolName: call.name, status: displayedError ? 'failed' : 'completed', ...(displayedError ? { error: displayedError } : {}) });
  return { tool_history_id: id, ...asOutput(result) };
}

function runTool(store: Store, session: string, name: string, args: Record<string, unknown>, transcriptTimezone: string): unknown {
  if (name === 'journal_transcript_by_date') {
    const date = validateTranscriptDate(args.date);
    const { offset, limit } = pageArgs(args, 4000);
    return formatTranscript(store, date, transcriptTimezone, offset, limit);
  }
  if (name === 'history_list') {
    const sessionId = (args.session_id as string | undefined) || session;
    const { offset, limit } = pageArgs(args);
    return toolPage(store.history(sessionId, offset, limit + 1), offset, limit);
  }
  if (name === 'history_search') {
    const { offset, limit } = pageArgs(args);
    return toolPage(store.search(args.query as string, offset, limit + 1), offset, limit);
  }
  if (name === 'history_get') {
    const id = args.id as string;
    const record = store.toolById(id);
    if (!record) throw new ToolUsageError(`No tool history record ${id}`);
    const { offset, limit } = pageArgs(args, 4000);
    return { ...record, result: resultPage(record.result, offset, limit), ...(['discord_attach_to_reply', 'image_generate', 'image_save'].includes(record.name) ? { delivery: store.attachmentDelivery(id) } : {}) };
  }
  throw new ToolUsageError(`Unknown tool: ${name}`);
}

function toolPage(rows: ToolRecord[], offset: number, limit: number) {
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(({ result, ...record }) => ({
      ...record,
      result: resultPage(result, 0, 500),
      has_more: result !== null && result.length > 500,
    })),
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  };
}

function resultPage(result: string | null, offset: number, limit: number) {
  if (result === null) return { text: null, total_length: 0, offset, next_offset: null };
  return {
    text: result.slice(offset, offset + limit),
    total_length: result.length,
    offset,
    next_offset: offset + limit < result.length ? offset + limit : null,
  };
}

function pageArgs(args: Record<string, unknown>, defaultLimit = 20): { offset: number; limit: number } {
  return { offset: (args.offset ?? 0) as number, limit: (args.limit ?? defaultLimit) as number };
}

function asOutput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

/** Tools such as Agent Reach return `error: null` on success; only a non-null error marks a failure. */
export function hasToolError(output: unknown): output is Record<string, unknown> & { error: unknown } {
  return isRecord(output) && output.error !== undefined && output.error !== null;
}
