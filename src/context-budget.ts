import { logError } from './error-log.js';

export type CountSource = 'local-count-estimate' | 'character-estimate' | 'calibrated estimate';
export type ContextCount = { inputTokens: number; source: CountSource; nativeCoverage: 'unmeasured native inputs' | 'text and tools'; reason?: string };

/** Counts the text/tool representation of a Responses request without invoking generation. */
export async function countContext(options: { baseUrl: string; apiKey?: string; model: string; input: unknown[]; tools: unknown[]; fetcher?: typeof fetch }): Promise<ContextCount> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  try {
    const response = await (options.fetcher ?? fetch)(`${options.baseUrl.replace(/\/$/, '')}/messages/count_tokens`, {
      method: 'POST', headers, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: options.model, system: systemText(options.input), messages: textMessages(options.input), tools: options.tools.map(tool => isRecord(tool) ? { name: tool.name, description: tool.description ?? '', input_schema: tool.parameters ?? {} } : tool) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Number.isSafeInteger(body.input_tokens) || (body.input_tokens as number) < 0) throw new Error('invalid count response');
    const native = hasNative(options.input);
    return { inputTokens: body.input_tokens as number, source: 'local-count-estimate', nativeCoverage: native ? 'unmeasured native inputs' : 'text and tools' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logError(`Context token count unavailable model=${options.model}; using Unicode character estimate`, error);
    const native = hasNative(options.input);
    return { inputTokens: unicodeEstimate(JSON.stringify({ input: stripNative(options.input), tools: options.tools })), source: 'character-estimate', nativeCoverage: native ? 'unmeasured native inputs' : 'text and tools', reason };
  }
}

export function unicodeEstimate(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return Math.ceil(count / 3);
}

function systemText(input: unknown[]): string {
  return input.flatMap(item => isRecord(item) && (item.role === 'developer' || item.role === 'system') ? [itemText(item)] : []).filter(Boolean).join('\n');
}
function textMessages(input: unknown[]): unknown[] {
  return input.flatMap(item => {
    if (!isRecord(item)) return [];
    const text = itemText(item);
    if (!text || item.role === 'developer' || item.role === 'system') return [];
    if (item.type === 'function_call_output') return [{ role: 'user', content: text }];
    return [{ role: item.role === 'assistant' || item.type === 'function_call' ? 'assistant' : 'user', content: text }];
  });
}
function itemText(item: Record<string, unknown>): string {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.flatMap(part => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('\n');
  if (item.type === 'function_call') return `${String(item.name ?? '')} ${String(item.arguments ?? '')}`;
  if (item.type === 'function_call_output') return String(item.output ?? '');
  return '';
}
function hasNative(input: unknown[]): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    if (value.type === 'input_image' || value.type === 'input_file') return true;
    return Object.values(value).some(visit);
  };
  return visit(input);
}
function stripNative(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNative);
  if (!isRecord(value)) return value;
  if (value.type === 'input_image') return { type: value.type, image_url: '[native image]' };
  if (value.type === 'input_file') return { type: value.type, filename: value.filename, file_data: '[native file]' };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripNative(item)]));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
