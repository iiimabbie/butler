import { Worker } from 'node:worker_threads';
import { ToolUsageError } from './tool-errors.js';

// Explicit list: a newly added tool is not available to scripts (or run concurrently) until it is known to be read-only.
export const readOnlyTools: ReadonlySet<string> = new Set([
  'memory_recall', 'memory_reflect', 'memory_tags_list',
  'history_list', 'history_get', 'history_search', 'journal_transcript_by_date',
  'discord_fetch_channel', 'discord_fetch_channel_messages', 'discord_fetch_message', 'discord_fetch_pins',
  'google_accounts_list', 'google_gmail_search', 'google_gmail_read', 'google_calendar_list_events',
  'google_tasks_lists', 'google_tasks_list', 'google_drive_search', 'google_drive_read',
  'agent_reach', 'local_read', 'local_search', 'web_search', 'web_fetch', 'web_extract', 'web_usage',
  'weather_search', 'weather_forecast', 'skills_list', 'skills_read', 'schedule_list',
  'hledger_accounts', 'hledger_schedules_list', 'hledger_forecast', 'hledger_budget', 'hledger_backup_list',
]);

// memory_reflect's own deadline exceeds the longest script, so scripts cannot call it.
const scriptTools: ReadonlySet<string> = new Set([...readOnlyTools].filter(name => name !== 'memory_reflect'));
const MAX_CALLS = 64;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const codeExecuteDefinition = {
  type: 'function', name: 'code_execute', strict: false,
  description: 'Run a JavaScript async function body in an isolated QuickJS sandbox to chain read-only tool calls and reduce their results before they reach you. Call tools with `await callTool(name, args)` (use Promise.all for independent calls; a later call can use an earlier result directly, so dependent lookups finish in one run); load a tool\'s definition with tools_catalog first. Only read-only tools you can already use are callable. There is no Node, filesystem, network or timers. Return a small JSON value (at most 64 KiB). At most 64 tool calls; timeout_ms defaults to 30000 (max 120000); memory_reflect can run longer than that, so call it directly. Each tool call is recorded in tool history.',
  parameters: { type: 'object', properties: {
    code: { type: 'string', minLength: 1, description: 'Async function body; use return for the result.' },
    timeout_ms: { type: 'integer', minimum: 1, maximum: 120000 },
  }, required: ['code'], additionalProperties: false },
};

export async function executeCode(args: Record<string, unknown>, options: {
  available: (name: string) => boolean;
  execute: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
  callId: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (typeof args.code !== 'string' || !args.code.trim()) throw new ToolUsageError('code must be a nonempty JavaScript function body');
  const timeoutMs = args.timeout_ms ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 120000) throw new ToolUsageError('timeout_ms must be an integer from 1 to 120000');
  // A worker keeps a CPU-bound script off the service event loop; it is discarded after every run.
  const worker = new Worker(new URL('./code-mode-worker.js', import.meta.url), { workerData: { code: args.code, timeoutMs } });
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ToolUsageError(`Script timed out after ${timeoutMs} ms`)), timeoutMs as number);
      onAbort = () => reject(new ToolUsageError('Script cancelled'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      worker.on('error', reject);
      worker.on('exit', code => reject(new Error(`Script worker exited (${code})`)));
      worker.on('message', async (message: { type: 'result' | 'error' | 'call'; id?: number; json?: string; error?: string; name?: string; args?: unknown }) => {
        if (message.type === 'result') {
          if (Buffer.byteLength(message.json!) > MAX_OUTPUT_BYTES) reject(new ToolUsageError('Script result exceeds 64 KiB; return a smaller summary'));
          else resolve(JSON.parse(message.json!));
          return;
        }
        if (message.type === 'error') { reject(new ToolUsageError(message.error!)); return; }
        try {
          if (typeof message.name !== 'string' || !scriptTools.has(message.name) || !options.available(message.name)) throw new Error(`Tool ${String(message.name)} is not available to scripts`);
          if (!message.args || typeof message.args !== 'object' || Array.isArray(message.args)) throw new Error('Tool args must be a JSON object');
          if (++calls > MAX_CALLS) throw new Error(`Scripts may make at most ${MAX_CALLS} tool calls`);
          const output = await options.execute(message.name, message.args as Record<string, unknown>, `${options.callId}:${calls}`);
          worker.postMessage({ id: message.id, json: JSON.stringify(output) });
        } catch (error) {
          if ((error as { auditPersistenceFailure?: boolean })?.auditPersistenceFailure) { reject(error); return; }
          worker.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await worker.terminate();
  }
}
