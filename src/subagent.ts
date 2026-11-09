import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import type { Store } from './store.js';
import { logInfo } from './log.js';
import { ToolUsageError } from './tool-errors.js';
import { projectPath } from './paths.js';
import { isRecord } from './tool-schema.js';

export type SubagentRunConfig = {
  baseUrl: string; apiKey?: string; store: Store; parentSession: string; signal?: AbortSignal;
  model: string;
  loadMessages: () => Array<{ id: string; message: string }>;
  consumeMessages: (ids: string[]) => void;
  onActivity: (patch: { turns?: number; currentTool?: string; currentCallId?: string; activity?: string }) => void;
};

const subagentSystem =`You are a worker for Butler, an AI agent. Report only to Butler; never address the end user. You have no personality and no memory beyond this session. Work only within the assigned task and scope.
If essential information or a decision is missing, stop and end your reply with a concrete question that explains what you checked and exactly what answer you need. Butler continues this same session with the answer. Never guess an unanswered issue.
Never deploy, restart, stop, or enable services, and never run git commit, push, branch changes, or resets unless the task explicitly says to. Butler verifies your report and decides architecture.
For investigation tasks, inspect and report evidence (file paths, line numbers, excerpts, observed behavior, uncertainties) without editing. For implementation tasks, follow the given specification.
Final reply: what you did, files changed, verification run and its result, anything unverified or unfinished, and any background processes still running.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a \`.codegraph/\` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): \`codegraph_explore\` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): \`codegraph explore "<symbol names or question>"\` prints the same output.
<!-- CODEGRAPH_END -->`;

const string = { type: 'string', minLength: 1 };
const page = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
export const subagentDefinitions = [
  { type: 'function', name: 'subagent_run', description: 'Start a background task on a Codex CLI worker and return its subagent_id immediately; the result arrives automatically as an internal event, so do not poll. The worker runs with full host access in cwd (an absolute directory), has no chat background, cannot use Butler tools (Discord, memory, Google, ledger) and cannot start its own sub-agents. Each call starts an independent task; use subagent_send to continue one. model may be any ID the configured LLM endpoint lists, from any provider (Claude, Gemini, Grok, GLM, Kimi, DeepSeek, GPT and others); Opus, Sol, Astra and Argon models are not accepted, and an unknown or rejected ID returns the available list. Choose the model yourself: pick the cheapest listed model you judge capable of the task, using what you know about each model family (mini, flash, lite and nano variants are cheap). Escalate to a stronger model only after a cheaper model falls short. When an unknown ID returns the list, apply the same rule to that list instead of picking the strongest entry. Workers run at high reasoning effort. Handle single lookups and small edits directly instead.', parameters: { type: 'object', properties: { task: string, context: string, constraints: string, expected_output: string, model: string, cwd: string }, required: ['task', 'context', 'constraints', 'expected_output', 'model', 'cwd'], additionalProperties: false } },
  { type: 'function', name: 'subagent_list', description: 'List tasks in this parent session with status and recent activity.', parameters: { type: 'object', properties: page, required: [], additionalProperties: false } },
  { type: 'function', name: 'subagent_status', description: "Read a task's status, current activity and paginated result in this parent session. offset is a character offset; limit is the number of 1000-character blocks.", parameters: { type: 'object', properties: { subagent_id: string, ...page }, required: ['subagent_id'], additionalProperties: false } },
  { type: 'function', name: 'subagent_stop', description: 'Stop a running task in this parent session by terminating its worker process. Work may be partially applied; use subagent_send on the same ID to resume it and ask for a status report.', parameters: { type: 'object', properties: { subagent_id: string, reason: string }, required: ['subagent_id', 'reason'], additionalProperties: false } },
  { type: 'function', name: 'subagent_send', description: 'Send a message to a task in this parent session. A running task receives it after its current run ends; a finished, stopped or interrupted task resumes its session immediately. model optionally switches the model for this and later runs. Returns immediately; the result arrives automatically.', parameters: { type: 'object', properties: { subagent_id: string, message: string, model: string }, required: ['subagent_id', 'message'], additionalProperties: false } },
];

let modelCache: { baseUrl: string; at: number; ids: string[] } | undefined;
async function subagentModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  if (modelCache?.baseUrl === baseUrl && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.ids;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Subagent model list request failed with HTTP ${response.status}`);
  const body: unknown = await response.json();
  const ids = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord).map(item => item.id).filter((id): id is string => typeof id === 'string' && !/opus|image|tts|video|voice|-(?:sol|astra|argon)\b/i.test(id)) : [];
  modelCache = { baseUrl, at: Date.now(), ids };
  return ids;
}

export async function validateSubagentModel(model: string, baseUrl: string, apiKey?: string): Promise<string> {
  const ids = await subagentModels(baseUrl, apiKey);
  if (!ids.includes(model)) throw new ToolUsageError(`Unknown subagent model ${model}; available: ${ids.join(', ')}`);
  return model;
}

let catalogPreparation: Promise<void> | undefined;

export async function runSubagent(options: SubagentRunConfig, id: string): Promise<string> {
  try {
    const window = options.store.getSubagentWindow(id, options.parentSession);
    if (!window) throw new Error('Unknown subagent window for this parent session; use subagent_list to find the actual ID.');
    const messages = options.loadMessages();
    let prompt: string;
    if (!window.thread_id) {
      if (!window.brief_json) throw new ToolUsageError('This legacy subagent window has no saved task brief; start a new task with the original brief.');
      const task = JSON.parse(window.brief_json) as { task: string; context: string; constraints: string; expected_output: string };
      const brief = `Task: ${task.task}\n\nContext and source material: ${task.context}\n\nConstraints: ${task.constraints}\n\nExpected output and acceptance criteria: ${task.expected_output}`;
      prompt = `${subagentSystem}\n\n${brief}${messages.length ? `\n\nAdditional messages:\n${messages.map(row => row.message).join('\n\n')}` : ''}`;
    } else {
      prompt = messages.map(row => row.message).join('\n\n') || 'Continue the task. The previous run was interrupted; check the current state before repeating any action.';
    }
    const model = options.model;
    options.signal?.throwIfAborted();
    options.store.setSubagentModel(id, model);
    const env = { ...process.env, BUTLER_SUBAGENT_API_KEY: options.apiKey ?? '' };
    const catalogPath = projectPath('.data/subagent/codex-models.json');
    try {
      // One catalog per process; a failed preparation is retried by the next run.
      catalogPreparation ??= (async () => {
        const { stdout } = await promisify(execFile)('codex', ['debug', 'models'], { timeout: 15000, env, cwd: window.cwd });
        const catalog: unknown = JSON.parse(stdout);
        if (!isRecord(catalog) || !Array.isArray(catalog.models) || catalog.models.some(model => !isRecord(model))) throw new Error('Expected a JSON object with a models array of objects');
        for (const model of catalog.models) delete model.multi_agent_version;
        mkdirSync(dirname(catalogPath), { recursive: true, mode: 0o700 });
        // Concurrent runs share the catalog; rename keeps readers from seeing a partial file.
        const temporary = `${catalogPath}.${process.pid}.${randomUUID()}`;
        writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
        renameSync(temporary, catalogPath);
      })().catch(error => { catalogPreparation = undefined; throw error; });
      await catalogPreparation;
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error(`Subagent Codex model catalog preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.signal?.throwIfAborted();
    const args = [
      '-c', 'model_provider=butler', '-c', 'model_providers.butler.name=Butler',
      '-c', `model_providers.butler.base_url=${JSON.stringify(options.baseUrl)}`,
      '-c', 'model_providers.butler.env_key=BUTLER_SUBAGENT_API_KEY', '-c', 'model_providers.butler.wire_api=responses',
      '-c', 'model_reasoning_effort=high', '-c', `model_catalog_json=${JSON.stringify(catalogPath)}`, '-c', 'agents.max_depth=0',
      '-m', model, '--search', 'exec', '--ignore-user-config', '--disable', 'memories', '--disable', 'apps',
      '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', window.cwd,
      ...(window.thread_id ? ['resume', '--json', window.thread_id, '-'] : ['--json', '-']),
    ];
    const child = spawn('codex', args, { detached: true, cwd: window.cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
    child.once('spawn', () => {
      try { options.consumeMessages(messages.map(row => row.id)); }
      catch (error) { processError = error instanceof Error ? error : new Error(String(error)); abort(); }
    });
    let turns = 0;
    let lastMessage = '';
    let failure: string | undefined;
    let lastError: string | undefined;
    let processError: Error | undefined;
    let stderr = Buffer.alloc(0);
    const abort = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processError = error instanceof Error ? error : new Error(String(error)); }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let event: unknown;
      try { event = JSON.parse(line); } catch { return; }
      if (!isRecord(event)) return;
      try {
        if (event.type === 'thread.started' && !window.thread_id && typeof event.thread_id === 'string') {
          options.store.setSubagentThread(id, event.thread_id);
          window.thread_id = event.thread_id;
        } else if (event.type === 'item.started' && isRecord(event.item)) {
          const item = event.item;
          options.onActivity({ currentTool: typeof item.type === 'string' ? item.type : undefined, currentCallId: typeof item.id === 'string' ? item.id : undefined, activity: item.type === 'command_execution' && typeof item.command === 'string' ? item.command.slice(0, 200) : String(item.type) });
        } else if (event.type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
          lastMessage = event.item.text;
        } else if (event.type === 'turn.started') {
          options.onActivity({ turns: ++turns });
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          // Codex also emits transient error events (e.g. reconnecting); only turn.failed fails the run.
          const message = (isRecord(event.error) && typeof event.error.message === 'string' ? event.error.message : typeof event.message === 'string' ? event.message : JSON.stringify(event)).slice(0, 2000);
          if (event.type === 'turn.failed') failure = message; else lastError = message;
        }
      } catch (error) {
        processError = error instanceof Error ? error : new Error(String(error));
        abort();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-8 * 1024); });
    child.stdin.on('error', error => { processError = error; });
    child.on('error', error => { processError = error; });
    const code = await new Promise<number | null>(resolve => {
      child.once('close', code => resolve(code));
      child.stdin.end(prompt);
    });
    options.signal?.removeEventListener('abort', abort);
    lines.close();
    logInfo('subagent_codex_exit', { subagentId: id, code, turns });
    options.signal?.throwIfAborted();
    if (processError) throw processError;
    if (code !== 0 || failure !== undefined || !lastMessage.trim()) throw new Error(`Subagent Codex run failed: ${failure || lastError || stderr.toString('utf8') || `exit code ${code}`}`);
    return lastMessage;
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { subagent_id: id }); }
}
