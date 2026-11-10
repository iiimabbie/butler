import { logWarn } from '../log.js';
import { isRecord } from '../tools/tool-schema.js';

/** Size-based token estimate of a request (UTF-8 bytes / 3; attachments as placeholders). Two estimates are comparable, so their difference tracks growth. */
export function estimateContextTokens(input: unknown[], tools: unknown[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ input: stripNative(input), tools })) / 3);
}

/** Counts the text/tool representation of a Responses request without invoking generation; the size estimate when counting is unavailable. */
export async function countContextTokens(options: { baseUrl: string; apiKey?: string; model: string; input: unknown[]; tools: unknown[] }): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/messages/count_tokens`, {
      method: 'POST', headers, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: options.model, system: systemText(options.input), messages: textMessages(options.input), tools: options.tools.map(tool => isRecord(tool) ? { name: tool.name, description: tool.description ?? '', input_schema: tool.parameters ?? {} } : tool) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Number.isSafeInteger(body.input_tokens) || (body.input_tokens as number) < 0) throw new Error('invalid count response');
    return body.input_tokens as number;
  } catch (error) {
    logWarn(`Context token count unavailable model=${options.model}; using size estimate`, error);
    return estimateContextTokens(options.input, options.tools);
  }
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
export function stripNative(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNative);
  if (!isRecord(value)) return value;
  if (value.type === 'input_image') return { type: value.type, image_url: '[native image]' };
  if (value.type === 'input_file') return { type: value.type, filename: value.filename, file_data: '[native file]' };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripNative(item)]));
}
