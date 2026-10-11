const MAX_OUTPUT_BLOCKS = 20;
const MAX_CONTENT_PARTS = 20;

const OUTPUT_TYPES = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning', 'image_generation_call',
  'web_search_call', 'file_search_call', 'computer_call', 'code_interpreter_call', 'mcp_call',
  'local_shell_call', 'local_shell_call_output', 'patch_apply_call', 'patch_apply_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'browser', 'compaction', 'unknown',
]);
const CHANNELS = new Set([
  'analysis', 'final', 'commentary', 'summary', 'justify', 'confidence', 'complete',
  'notification', 'delegate_summary', 'juicepred',
]);
const CONTENT_TYPES = new Set([
  'output_text', 'refusal', 'input_text', 'input_image', 'input_file', 'input_audio',
  'input_video', 'output_audio', 'output_audio_text', 'audio', 'summary_text', 'reasoning_text',
  'text', 'image', 'refusal_marker',
]);
const RESPONSE_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress']);
const INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter', 'max_tool_calls', 'tool_use_limit']);

type Field<T> = T | 'missing' | 'invalid';

export type EmptyAssistantTextDiagnostic = {
  event: 'llm_empty_assistant_text';
  requestId: string;
  session: string;
  model: string;
  httpStatus: number | 'missing' | 'invalid';
  apiStatus: Field<string>;
  incompleteReason: Field<string>;
  usage: { inputTokens: number | 'missing' | 'invalid'; outputTokens: number | 'missing' | 'invalid' };
  outputCount: number | 'missing' | 'invalid';
  outputTruncated: boolean;
  output: Array<{
    type: string;
    channel?: Field<string>;
    contentCount?: number | 'missing' | 'invalid';
    contentTruncated?: boolean;
    contentTypes?: string[];
  }>;
};

/** Build a bounded, content-free summary. Every string derived from the response is allowlisted. */
export function buildEmptyAssistantTextDiagnostic(input: {
  requestId: string;
  session: string;
  model: string;
  httpStatus: unknown;
  raw: unknown;
}): EmptyAssistantTextDiagnostic {
  const raw = record(input.raw);
  const output = raw === null ? 'missing' : Array.isArray(raw.output) ? raw.output : raw.output === undefined ? 'missing' : 'invalid';
  const blocks = Array.isArray(output) ? output : [];
  const usage = raw && raw.usage !== undefined ? record(raw.usage) : null;
  const incomplete = raw && raw.incomplete_details !== undefined ? record(raw.incomplete_details) : null;
  const reason: Field<string> = !raw || raw.incomplete_details === undefined
    ? 'missing'
    : incomplete === null
      ? 'invalid'
      : incomplete.reason === undefined
        ? 'missing'
        : typeof incomplete.reason !== 'string'
          ? 'invalid'
          : allowlisted(incomplete.reason, INCOMPLETE_REASONS);

  const summarized = blocks.slice(0, MAX_OUTPUT_BLOCKS).map(value => summarizeBlock(value));
  return {
    event: 'llm_empty_assistant_text',
    requestId: safeIdentifier(input.requestId),
    session: safeIdentifier(input.session),
    model: safeIdentifier(input.model),
    httpStatus: Number.isSafeInteger(input.httpStatus) && (input.httpStatus as number) >= 100 && (input.httpStatus as number) <= 599 ? input.httpStatus as number : input.httpStatus === undefined ? 'missing' : 'invalid',
    apiStatus: !raw || raw.status === undefined ? 'missing' : typeof raw.status === 'string' ? allowlisted(raw.status, RESPONSE_STATUSES) : 'invalid',
    incompleteReason: reason,
    usage: {
      inputTokens: usage === null ? raw?.usage === undefined ? 'missing' : 'invalid' : numericField(usage.input_tokens),
      outputTokens: usage === null ? raw?.usage === undefined ? 'missing' : 'invalid' : numericField(usage.output_tokens),
    },
    outputCount: Array.isArray(output) ? output.length : output,
    outputTruncated: blocks.length > MAX_OUTPUT_BLOCKS,
    output: summarized,
  };
}

function summarizeBlock(value: unknown): EmptyAssistantTextDiagnostic['output'][number] {
  const item = record(value);
  const type: string = item === null ? 'invalid' : typeof item.type !== 'string' ? item.type === undefined ? 'missing' : 'invalid' : allowlisted(item.type, OUTPUT_TYPES);
  if (type !== 'message') return { type };
  const channel: Field<string> = item!.channel === undefined ? 'missing' : typeof item!.channel === 'string' ? allowlisted(item!.channel, CHANNELS) : 'invalid';
  const content = item!.content;
  if (content === undefined) return { type, channel, contentCount: 'missing' };
  if (!Array.isArray(content)) return { type, channel, contentCount: 'invalid' };
  return {
    type, channel, contentCount: content.length, contentTruncated: content.length > MAX_CONTENT_PARTS,
    contentTypes: content.slice(0, MAX_CONTENT_PARTS).map(part => {
      const partRecord = record(part);
      if (partRecord === null) return 'invalid';
      if (partRecord.type === undefined) return 'missing';
      return typeof partRecord.type === 'string' ? allowlisted(partRecord.type, CONTENT_TYPES) : 'invalid';
    }),
  };
}

function numericField(value: unknown): number | 'missing' | 'invalid' {
  if (value === undefined) return 'missing';
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 'invalid';
}
function allowlisted(value: string, allowed: Set<string>): string { return allowed.has(value) ? value : 'unknown'; }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : 'invalid';
}
