import { preserveOptionalToolArguments } from './tool-schema.js';
import type { Store } from './store.js';
import { logInfo } from './log.js';

export type SubagentConfig = { model: string; maxTurns?: number; timeoutMs?: number; toolsEnabled?: boolean };
export type SubagentToolRuntime = { definitions: Array<{ type: string; name: string; [key: string]: unknown }>; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
export type SubagentRunConfig = {
  baseUrl: string; apiKey?: string; fetcher?: typeof fetch; store: Store; parentSession: string;
  localTools?: SubagentToolRuntime; webTools?: SubagentToolRuntime; signal?: AbortSignal; resume?: boolean;
  stopRequest?: () => { reason: string; requestedAt: string } | undefined;
  takeMessages?: (input: unknown[]) => string[];
  parentMessage?: (message: string, wait: boolean, callId: string) => Promise<string | undefined>;
  onActivity?: (patch: { turns?: number; currentTool?: string; currentCallId?: string; activity?: string }) => void;
  executeTool: (windowId: string, model: string, name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
};

export const subagentSystem = `You are an independent subagent. You have your own persistent task window and tool history. Report only to the parent agent; do not address the end user. You have no Hindsight or workspace personality/memory. Use host tools only within the assigned task. Ask the parent using subagent_parent_message with wait_for_reply=true when essential information or a decision is missing; never guess an unanswered issue. Do not exceed task scope.

## Investigation and implementation stages
Follow the stage assigned by the parent. For code-investigation tasks, only inspect and report evidence, including file paths, line numbers, relevant excerpts, observed behavior, and uncertainties; do not edit, deploy, or decide architecture. Then report to the parent and wait for a follow-up through the persistent task window; do not block on a question merely to await the next stage. For implementation tasks, follow only the parent's detailed specification; ask the parent about essential missing information or decisions instead of deciding them yourself. Reuse the existing task history and do not repeat investigation of unchanged facts.

## Cooperative stopping
When the parent asks you to stop, immediately stop expanding the task. Do not start new edits, commands, deployments, or background work. Let the current tool finish, then summarize completed work, file changes, unverified results, remaining work, and every still-running or unknown background task ID for explicit parent handoff. Never claim those tasks stopped without evidence. In closeout mode use only the provided read-only tools and non-blocking parent reports; finish with a final handoff, do not wait for more instructions.

## Host tool working directories
local_read, local_search, local_write, and local_edit resolve relative paths from the Butler project root, NOT the assigned task repository. They never inherit local_shell.cwd or a previous shell's cd. When working in another repository, use absolute paths for all file tools (for example, /home/iiimabbie/workspace/pet-agent/src/store.ts), and set local_shell.cwd explicitly for each shell call. Before editing, verify the resolved target and read its current contents; keep exact-match protection and do not weaken it to work around a mismatch.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a \`.codegraph/\` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): \`codegraph_explore\` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): \`codegraph explore "<symbol names or question>"\` prints the same output.
<!-- CODEGRAPH_END -->`;

const string = { type: 'string', minLength: 1 };
const page = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
export const subagentDefinitions = [
  { type: 'function', name: 'subagent_run', description: 'Start a background delegated task and return its subagent_id immediately. Suitable for code investigation (including a single code fact) and complex multi-step work; ordinary single-fact lookups are not suitable. This is a lower-tier model with no chat background: provide a complete self-contained brief for the assigned stage with objective, source material/paths, concrete steps, constraints, acceptance criteria and expected output. An investigation brief must identify the code questions and required evidence, not prescribe an implementation. Do not repeat completed investigation; when sufficient evidence already exists, proceed directly with a complete implementation brief. For an independent new task, omit subagent_id; the tool generates and returns it. Never invent an ID or use "auto". For follow-up on the same work, use the subagent_id actually returned by the tool. Reuse that ID for a complete revised brief after a task has ended; use subagent_send for running-task supplements, answers, or follow-up. An existing ID resumes its persistent window only within the same parent session. Do not poll; wait for automatic notification. Never fabricate pending results. Parent verifies reports and retains architecture and final decisions.', parameters: { type: 'object', properties: { task: string, context: string, constraints: string, expected_output: string, subagent_id: { ...string, description: 'Omit for an independent new task; use the subagent_id actually returned by the tool for the same existing work.' } }, required: ['task', 'context', 'constraints', 'expected_output'], additionalProperties: false } },
  { type: 'function', name: 'subagent_list', description: 'List tasks belonging to this parent session, with status and recent activity. Use when asked about progress or when a decision requires it; do not poll for completion.', parameters: { type: 'object', properties: page, required: [], additionalProperties: false } },
  { type: 'function', name: 'subagent_status', description: 'Read real status, pending question, current tool and paginated result for this parent session. Result offset is a character offset; limit is the number of 1000-character blocks. No percentage is estimated. Do not poll; completion is notified automatically.', parameters: { type: 'object', properties: { subagent_id: string, ...page }, required: ['subagent_id'], additionalProperties: false } },
  { type: 'function', name: 'subagent_stop', description: 'Request cooperative stop for a task in this parent session. Does not cancel model HTTP or an in-flight tool. Blocks new work, allows bounded read-only closeout and reports stopped or background-task handoff via automatic notification. Terminal tasks are not resumed; accepted/stopping is not proof of completion. Use this instead of sending a stop instruction through subagent_send.', parameters: { type: 'object', properties: { subagent_id: string, reason: string }, required: ['subagent_id', 'reason'], additionalProperties: false } },
  { type: 'function', name: 'subagent_send', description: 'Use subagent_stop for stop requests, not this tool. Send detailed supplemental instructions to a running task, answer its exact pending question_id, or continue a finished/interrupted task using its existing ID and history. Keep the same worker for the same work. After an investigation report, continue with that same ID and provide the complete implementation specification; if evidence is insufficient, give a precise follow-up investigation instead. Do not ask the child to choose an architecture or make decisions reserved for the parent. A question mismatch returns the current question without accepting your message. Returns immediately after persistence; does not wait for the child. Never send vague context the worker cannot know.', parameters: { type: 'object', properties: { subagent_id: string, message: string, question_id: string }, required: ['subagent_id', 'message'], additionalProperties: false } },
];
const closeoutTools = new Set(['local_read', 'local_search', 'local_process_output']);
const CLOSEOUT_TURNS = 4;
const parentMessageDefinition = { type: 'function', name: 'subagent_parent_message', description: 'Child-only communication with the parent. Report meaningful progress with wait_for_reply=false. If blocked, missing essential information or needing a decision, send a concrete question with true and wait for the parent response; do not guess or address the end user. Explain the blocker, what you already checked, and exactly what answer you need.', parameters: { type: 'object', properties: { message: string, wait_for_reply: { type: 'boolean' } }, required: ['message', 'wait_for_reply'], additionalProperties: false } };
const busy = new Set<string>();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ERROR_BODY_LIMIT = 8 * 1024;
function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength && /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}
function safeParameter(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.-]+(?:\[[0-9]+\][A-Za-z0-9_.-]*)*$/.test(value) ? value : undefined;
}
async function readErrorMetadata(response: Response): Promise<void> {
  let text = '';
  let responseBytes = 0;
  let truncated = false;
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = ERROR_BODY_LIMIT + 1 - responseBytes;
        const part = value.subarray(0, Math.max(0, remaining));
        responseBytes += part.byteLength;
        text += decoder.decode(part, { stream: true });
        if (value.byteLength > part.byteLength || responseBytes > ERROR_BODY_LIMIT) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      text += decoder.decode();
    }
  } catch { /* metadata collection must not replace the fixed HTTP failure */ }
  let parsed: unknown;
  let validJson = false;
  if (!truncated) {
    try { parsed = JSON.parse(text); validJson = true; } catch { /* non-JSON error response */ }
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const upstreamRequestId = safeIdentifier(response.headers.get('x-request-id') ?? response.headers.get('request-id'), 128);
  try {
    logInfo('subagent_http_error', {
      status: response.status,
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      responseBytes,
      truncated,
      validJson,
      ...(error && safeIdentifier(error.code, 64) ? { errorCode: safeIdentifier(error.code, 64) } : {}),
      ...(error && safeIdentifier(error.type, 64) ? { errorType: safeIdentifier(error.type, 64) } : {}),
      ...(error && safeParameter(error.param) ? { errorParam: safeParameter(error.param) } : {}),
    });
  } catch { /* logging must not mask the original HTTP error */ }
}
const refusal = (output: Record<string, unknown>[]) => output.some(item => item.type === 'refusal' || item.status === 'incomplete' || (item.type === 'message' && Array.isArray(item.content) && item.content.some(block => isRecord(block) && block.type === 'refusal')));
function validateOutput(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new Error('Subagent response output must contain only objects');
  for (const item of value as Record<string, unknown>[]) {
    if (item.type === 'function_call' && (typeof item.name !== 'string' || !item.name.trim() || typeof item.call_id !== 'string' || !item.call_id.trim() || typeof item.arguments !== 'string')) throw new Error('Subagent function call is malformed');
    if (item.type === 'message' && (!Array.isArray(item.content) || item.content.some(block => !isRecord(block) || (block.type === 'output_text' && typeof block.text !== 'string')))) throw new Error('Subagent message content is malformed');
  }
  return value as Record<string, unknown>[];
}

export async function runSubagent(config: SubagentConfig, options: SubagentRunConfig, task: { task: string; context: string; constraints: string; expected_output: string; subagent_id?: string }): Promise<{ subagent_id: string; model: string; text: string; turns: number; stop_status?: 'stopped' | 'handoff'; background_tasks?: string[] }> {
  if ([task.task, task.context, task.constraints, task.expected_output].some(value => typeof value !== 'string' || !value.trim())) throw new Error('All task fields must be nonempty strings');
  const id = task.subagent_id ?? options.store.createSubagentWindow(options.parentSession, config.model, [{ role: 'developer', content: subagentSystem }]);
  if (busy.has(id)) throw Object.assign(new Error('This subagent window is already running'), { subagent_id: id });
  const window = options.store.getSubagentWindow(id, options.parentSession);
  if (!window) throw Object.assign(new Error('Unknown subagent window for this parent session; use subagent_list to find the actual ID in this parent session, or use subagent_run and omit subagent_id for an independent new task'), { subagent_id: id });
  busy.add(id);
  try {
    const model = window.model;
    const allowedTools = [...(options.localTools?.definitions ?? []).filter(tool => tool.name.startsWith('local_')), ...(options.webTools?.definitions ?? []).filter(tool => tool.name.startsWith('web_'))];
    const allow = new Set(allowedTools.map(tool => tool.name));
    const tools = [...allowedTools, parentMessageDefinition].map(preserveOptionalToolArguments);
    // Stop controls belong to a run, not to the persistent task window.
    let input = (JSON.parse(window.input_json) as unknown[]).filter(item => !(isRecord(item) && item.role === 'developer' && typeof item.content === 'string' && item.content.startsWith('COOPERATIVE STOP requested by parent')));
    if (isRecord(input[0]) && input[0].role === 'developer') input[0] = { role: 'developer', content: subagentSystem };
    const completed = new Set(input.filter(isRecord).filter(item => item.type === 'function_call_output').map(item => item.call_id));
    for (const call of input.filter(isRecord).filter(item => item.type === 'function_call' && !completed.has(item.call_id))) {
      input.push({ type: 'function_call_output', call_id: call.call_id, output: '先前執行中斷，結果未知；先檢查現況，不得自動重跑' });
    }
    if (!options.resume) input.push({ role: 'user', content: `Task: ${task.task}\n\nContext and source material: ${task.context}\n\nConstraints: ${task.constraints}\n\nExpected output and acceptance criteria: ${task.expected_output}` });
    options.store.saveSubagentWindow(id, input);
    const fetcher = options.fetcher ?? fetch;
    const background = new Map<string, string>();
    const callNames = new Map(input.filter(isRecord).filter(item => item.type === 'function_call').map(item => [item.call_id, item.name]));
    let unknownProcessWork = false;
    const track = (name: unknown, result: unknown) => {
      if (name === 'local_shell' && !(isRecord(result) && result.skipped === true) && !(isRecord(result) && typeof result.task_id === 'string')) unknownProcessWork = true;
      if ((name === 'local_shell' || ((name === 'local_process_output' || name === 'local_process_stop') && isRecord(result) && typeof result.task_id === 'string' && background.has(result.task_id))) && isRecord(result) && typeof result.task_id === 'string') background.set(result.task_id, typeof result.status === 'string' ? result.status : 'unknown');
    };
    for (const item of input.filter(isRecord).filter(item => item.type === 'function_call_output')) {
      try { track(callNames.get(item.call_id), JSON.parse(String(item.output))); } catch { if (callNames.get(item.call_id) === 'local_shell') unknownProcessWork = true; }
    }
    let stopping = false;
    let closeoutTurns = 0;
    const syncStop = () => {
      const request = options.stopRequest?.();
      if (request && !stopping) {
        stopping = true;
        input.push({ role: 'developer', content: `COOPERATIVE STOP requested by parent at ${request.requestedAt}: ${request.reason}\nDo not start new work. Only read-only closeout tools are available. Do not wait for a parent answer. Report completed work, file changes, unverified results, unfinished work, and background task IDs for explicit handoff. Final text is required. Owned background tasks: ${JSON.stringify([...background])}` });
        options.store.saveSubagentWindow(id, input);
      }
    };
    const handoff = () => {
      const pending = [...background].filter(([, status]) => !['completed', 'failed'].includes(status)).map(([id]) => id);
      return { stop_status: pending.length || unknownProcessWork ? 'handoff' as const : 'stopped' as const, background_tasks: pending };
    };
    for (let turn = 1; turn <= (config.maxTurns ?? 30) || stopping; turn++) {
      options.signal?.throwIfAborted();
      if (options.takeMessages?.(input).length) input = JSON.parse(options.store.getSubagentWindow(id, options.parentSession)!.input_json) as unknown[];
      syncStop();
      if (stopping && closeoutTurns++ >= CLOSEOUT_TURNS) return { subagent_id: id, model, text: 'Closeout turn limit reached; inspect persistent tool history before resuming. New work was blocked after the stop request.', turns: turn - 1, stop_status: 'handoff', background_tasks: handoff().background_tasks };
      const requestStopping = stopping;
      options.onActivity?.({ turns: turn, currentTool: undefined, currentCallId: undefined, activity: 'Calling model' });
      const timeout = AbortSignal.timeout(config.timeoutMs ?? 120000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetcher(`${options.baseUrl.replace(/\/$/, '')}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) }, body: JSON.stringify({ model, input, tools: stopping ? tools.filter(tool => closeoutTools.has(tool.name) || tool.name === 'subagent_parent_message') : tools, store: false }), signal });
      if (!response.ok) {
        await readErrorMetadata(response);
        throw new Error(`Subagent Responses request failed with HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || body.status !== 'completed' || (body.output_text !== undefined && typeof body.output_text !== 'string')) throw new Error('Subagent response is incomplete or malformed');
      const output = validateOutput(body.output);
      input.push(...output);
      options.store.saveSubagentWindow(id, input);
      if (refusal(output)) throw new Error('Subagent returned refusal or incomplete output');
      syncStop();
      const calls = output.filter(item => item.type === 'function_call');
      for (const call of calls) {
        logInfo('tool_call', { tool: typeof call.name === 'string' ? call.name : 'unknown', source: 'subagent', sessionId: id, ...(typeof call.call_id === 'string' ? { callId: call.call_id } : {}) });
        if (typeof call.name !== 'string' || (call.name !== 'subagent_parent_message' && !allow.has(call.name)) || typeof call.arguments !== 'string' || typeof call.call_id !== 'string') throw new Error(`Subagent tool is not allowed or malformed: ${String(call.name)}`);
        syncStop();
        options.signal?.throwIfAborted();
        options.onActivity?.({ currentTool: call.name, currentCallId: call.call_id, activity: `Executing ${call.name}` });
        let result: unknown;
        try {
          const args: unknown = JSON.parse(call.arguments);
          if (!isRecord(args)) throw new Error('Tool arguments must be a JSON object');
          if (stopping && !closeoutTools.has(call.name) && call.name !== 'subagent_parent_message') {
            result = { skipped: true, reason: 'Parent requested cooperative stop; new work is blocked. Produce a safe handoff.' };
          } else if (stopping && call.name === 'local_process_output' && (typeof args.task_id !== 'string' || !background.has(args.task_id))) {
            result = { skipped: true, reason: 'Closeout may inspect only background tasks owned by this window.' };
          } else if (call.name === 'subagent_parent_message') {
            if (typeof args.message !== 'string' || !args.message.trim() || typeof args.wait_for_reply !== 'boolean' || Object.keys(args).some(key => !['message', 'wait_for_reply'].includes(key)) || !options.parentMessage) throw new Error('Parent communication is unavailable or malformed');
            result = await options.parentMessage(args.message, stopping ? false : args.wait_for_reply, call.call_id);
          } else result = await options.executeTool(id, model, call.name, args, call.call_id);
        } catch (error) {
          if (options.signal?.aborted || (error as { auditPersistenceFailure?: boolean })?.auditPersistenceFailure) throw error;
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        track(call.name, result);
        const persisted = JSON.parse(options.store.getSubagentWindow(id, options.parentSession)!.input_json) as unknown[];
        if (persisted.some(item => isRecord(item) && item.type === 'function_call_output' && item.call_id === call.call_id)) input = persisted;
        else {
          input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result ?? { delivered: true }) });
          options.store.saveSubagentWindow(id, input);
        }
      }
      syncStop();
      if (calls.length || (stopping && !requestStopping)) continue;
      const text = typeof body.output_text === 'string' ? body.output_text : output.filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []).filter(isRecord).filter(item => item.type === 'output_text').map(item => item.text as string).join('');
      if (!text.trim()) throw new Error('Subagent returned refusal, incomplete, or empty output');
      options.onActivity?.({ turns: turn, currentTool: undefined, currentCallId: undefined, activity: 'Completed response' });
      return { subagent_id: id, model, text, turns: turn, ...(stopping ? handoff() : {}) };
    }
    throw new Error(`Subagent reached the maximum of ${config.maxTurns ?? 30} turns`);
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { subagent_id: id }); }
  finally { busy.delete(id); }
}
