import type { Store } from './store.js';

export type SubagentConfig = { model: string; maxTurns?: number; timeoutMs?: number };
export type SubagentToolRuntime = { definitions: Array<{ type: string; name: string; [key: string]: unknown }>; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
export type SubagentRunConfig = { baseUrl: string; apiKey?: string; fetcher?: typeof fetch; store: Store; parentSession: string; localTools?: SubagentToolRuntime; webTools?: SubagentToolRuntime; executeTool: (windowId: string, model: string, name: string, args: Record<string, unknown>) => Promise<unknown> };

const system = 'You are an independent subagent. You have your own persistent task window and tool history. You report only to the parent agent; do not address the end user. You have no Hindsight or workspace personality/memory. Use host tools only within the assigned task. If essential information is missing, report the gap instead of asking the end user. Do not exceed the task scope.';
export const subagentDefinitions = [{ type: 'function', name: 'subagent_run', description: 'Delegate complex or multi-step work with a clear outcome; do simple single-fact checks directly. Once delegated, do not repeat the same investigation yourself. A low-tier model has no chat background: provide a self-contained task with goal, concrete steps, relevant source text/paths, constraints, acceptance criteria, and expected output. For follow-up, corrections, or returned work, reuse the same subagent_id to preserve its context; create a new ID only for independent work, each new task gets a distinct ID. This waits for a result; it does not provide asynchronous background notifications or cross-agent messaging. The parent agent must verify results and retains architecture/final decisions.', parameters: { type: 'object', properties: { task: { type: 'string', minLength: 1 }, context: { type: 'string', minLength: 1 }, constraints: { type: 'string', minLength: 1 }, expected_output: { type: 'string', minLength: 1 }, subagent_id: { type: 'string', minLength: 1 } }, required: ['task', 'context', 'constraints', 'expected_output'], additionalProperties: false } }];

const busy = new Set<string>();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const refusalInOutput = (output: Record<string, unknown>[]): boolean => output.some(item => item.type === 'refusal' || item.status === 'incomplete' || (item.type === 'message' && Array.isArray(item.content) && item.content.some(block => isRecord(block) && block.type === 'refusal')));
function validateOutput(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new Error('Subagent response output must contain only objects');
  const output = value as Record<string, unknown>[];
  for (const item of output) {
    if (item.type === 'function_call' && (typeof item.name !== 'string' || !item.name.trim() || typeof item.call_id !== 'string' || !item.call_id.trim() || typeof item.arguments !== 'string')) throw new Error('Subagent function call is malformed');
    if (item.type === 'message') {
      if (!Array.isArray(item.content) || item.content.some(block => !isRecord(block))) throw new Error('Subagent message content is malformed');
      for (const block of item.content as Record<string, unknown>[]) if (block.type === 'output_text' && typeof block.text !== 'string') throw new Error('Subagent output text is malformed');
    }
  }
  return output;
}
const toolsAllowed = (name: string, allowed: Set<string>) => allowed.has(name) && name !== 'butler_deploy' && name !== 'subagent_run';

export async function runSubagent(config: SubagentConfig, options: SubagentRunConfig, task: { task: string; context: string; constraints: string; expected_output: string; subagent_id?: string }): Promise<{ subagent_id: string; model: string; text: string; turns: number }> {
  const fields = [task.task, task.context, task.constraints, task.expected_output];
  if (fields.some(value => typeof value !== 'string' || !value.trim())) throw new Error('All task fields must be nonempty strings');
  const id = task.subagent_id ?? options.store.createSubagentWindow(options.parentSession, config.model, [{ role: 'developer', content: system }]);
  if (busy.has(id)) throw Object.assign(new Error('This subagent window is already running'), { subagent_id: id });
  const window = options.store.getSubagentWindow(id, options.parentSession);
  if (!window) throw Object.assign(new Error('Unknown subagent window for this parent session'), { subagent_id: id });
  busy.add(id);
  try {
    const model = window.model;
    const allowedTools = [...(options.localTools?.definitions ?? []).filter(t => t.name.startsWith('local_')), ...(options.webTools?.definitions ?? []).filter(t => t.name.startsWith('web_'))];
    const allow = new Set(allowedTools.map(t => t.name));
    const tools = allowedTools.filter(t => toolsAllowed(t.name, allow));
    const user = `Task: ${task.task}\n\nContext and source material: ${task.context}\n\nConstraints: ${task.constraints}\n\nExpected output and acceptance criteria: ${task.expected_output}`;
    const input = JSON.parse(window.input_json) as unknown[];
    const pendingCalls = new Map<string, Record<string, unknown>>();
    const completedCalls = new Set<string>();
    for (const item of input) {
      if (!isRecord(item)) continue;
      if (item.type === 'function_call' && typeof item.call_id === 'string') pendingCalls.set(item.call_id, item);
      else if (item.type === 'function_call_output' && typeof item.call_id === 'string') completedCalls.add(item.call_id);
    }
    for (const [callId] of pendingCalls) if (!completedCalls.has(callId)) input.push({ type: 'function_call_output', call_id: callId, output: '先前執行中斷，結果未知；先檢查現況，不得自動重跑' });
    if (pendingCalls.size !== completedCalls.size || [...pendingCalls.keys()].some(callId => !completedCalls.has(callId))) options.store.saveSubagentWindow(id, input);
    input.push({ role: 'user', content: user });
    options.store.saveSubagentWindow(id, input);
    const fetcher = options.fetcher ?? fetch;
    for (let turn = 1; turn <= (config.maxTurns ?? 30); turn++) {
      const response = await fetcher(`${options.baseUrl.replace(/\/$/, '')}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) }, body: JSON.stringify({ model, input, tools, store: false }), signal: AbortSignal.timeout(config.timeoutMs ?? 120000) });
      if (!response.ok) throw new Error(`Subagent Responses request failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!isRecord(body) || body.status !== 'completed' || (body.output_text !== undefined && typeof body.output_text !== 'string')) throw new Error('Subagent response is incomplete or malformed');
      const output = validateOutput(body.output);
      input.push(...output);
      options.store.saveSubagentWindow(id, input);
      if (refusalInOutput(output)) throw new Error('Subagent returned refusal or incomplete output');
      const calls = output.filter(item => item.type === 'function_call');
      if (calls.length) {
        for (const call of calls) {
          if (typeof call.name !== 'string' || !toolsAllowed(call.name, allow) || typeof call.arguments !== 'string' || typeof call.call_id !== 'string') throw new Error(`Subagent tool is not allowed or malformed: ${String(call.name)}`);
          let result: unknown;
          try {
            const args: unknown = JSON.parse(call.arguments);
            if (!isRecord(args)) throw new Error('Tool arguments must be a JSON object');
            result = await options.executeTool(id, model, call.name, args);
          } catch (error) { if ((error as { auditPersistenceFailure?: boolean })?.auditPersistenceFailure) throw error; result = { error: error instanceof Error ? error.message : String(error) }; }
          input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
          options.store.saveSubagentWindow(id, input);
        }
        continue;
      }
      const text = typeof body.output_text === 'string' ? body.output_text : output.filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []).filter(isRecord).filter(item => item.type === 'output_text').map(item => item.text as string).join('');
      if (!text.trim() || refusalInOutput(output)) throw new Error('Subagent returned refusal, incomplete, or empty output');
      return { subagent_id: id, model, text, turns: turn };
    }
    throw new Error(`Subagent reached the maximum of ${config.maxTurns ?? 30} turns`);
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { subagent_id: id }); }
  finally { busy.delete(id); }
}
