import { isRecord } from './tool-schema.js';

/** Content-free, bounded diagnostics for responses without assistant text. */
export function buildEmptyAssistantTextDiagnostic(input: { requestId: string; session: string; model: string; httpStatus: unknown; raw: unknown }) {
  const raw = isRecord(input.raw) ? input.raw : {};
  const usage = isRecord(raw.usage) ? raw.usage : {};
  const incomplete = isRecord(raw.incomplete_details) ? raw.incomplete_details : {};
  const allowed = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value) ? value : value === undefined ? 'missing' : 'unknown';
  const number = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value : value === undefined ? 'missing' : 'invalid';
  const identifier = (value: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : 'invalid';
  const output = Array.isArray(raw.output) ? raw.output : [];
  return {
    event: 'llm_empty_assistant_text', requestId: identifier(input.requestId), session: identifier(input.session), model: identifier(input.model),
    httpStatus: number(input.httpStatus),
    apiStatus: allowed(raw.status, ['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress']),
    incompleteReason: allowed(incomplete.reason, ['max_output_tokens', 'content_filter']),
    usage: { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens) },
    outputCount: Array.isArray(raw.output) ? output.length : raw.output === undefined ? 'missing' : 'invalid',
    outputTruncated: output.length > 20,
    output: output.slice(0, 20).map(value => {
      const item = isRecord(value) ? value : {};
      const type = allowed(item.type, ['message', 'reasoning', 'function_call', 'image_generation_call']);
      if (type !== 'message') return { type };
      const content = Array.isArray(item.content) ? item.content : [];
      return { type, channel: allowed(item.channel, ['analysis', 'final', 'commentary', 'summary']), contentCount: Array.isArray(item.content) ? content.length : item.content === undefined ? 'missing' : 'invalid', contentTruncated: content.length > 20, contentTypes: content.slice(0, 20).map(part => allowed(isRecord(part) ? part.type : undefined, ['output_text', 'refusal'])) };
    }),
  };
}
