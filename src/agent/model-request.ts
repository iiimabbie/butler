import { logError } from '../log.js';
import { randomUUID } from 'node:crypto';
import { logInfo } from '../log.js';
import { Agent } from 'undici';
import { isRecord } from '../tools/tool-schema.js';
import { AttachmentInputError, redactAttachmentPayload } from '../attachments/input-attachments.js';
import type { Store } from '../store.js';
import type { AgentConfig } from './agent.js';

// Node fetch otherwise aborts at undici's 300 s header/body timeouts; the AbortSignal below is the only limit.
const modelDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const traceInstanceId = randomUUID();
export function traceTextMetadata(text: string): { textLength: number } {
  return { textLength: text.length };
}
export function logTrace(event: string, fields: Record<string, unknown>): void {
  try { logInfo(event, { instanceId: traceInstanceId, ...fields }); } catch { /* diagnostics must not affect message flow */ }
}

/** Metadata only: never log prompts, responses, credentials or endpoint URLs. */
export async function requestModel(options: {
  url: string; headers: Record<string, string>; body: string; session: string;
  model: string; turn: number; timeoutMs: number;
  askId?: string; traceId?: string; requestId?: string;
}): Promise<{ response: Response; raw: unknown; requestId: string }> {
  const requestId = options.requestId ?? randomUUID();
  const started = performance.now();
  const signal = AbortSignal.timeout(options.timeoutMs);
  const emit = (event: Record<string, unknown>) => { const { event: name, timestamp: _timestamp, ...fields } = event; if (name === 'failed') logError('Model HTTP request failed', undefined, { notify: false, fields }); else logInfo(`model_http_${String(name)}`, fields); };
  const metadata = { instanceId: traceInstanceId, requestId, ...(options.askId ? { askId: options.askId } : {}), ...(options.traceId ? { traceId: options.traceId } : {}), session: options.session, model: options.model, turn: options.turn, timeoutMs: options.timeoutMs, requestBytes: Buffer.byteLength(options.body) };
  const log = (event: Record<string, unknown>) => {
    try { emit({ timestamp: new Date().toISOString(), ...metadata, elapsedMs: Math.round(performance.now() - started), ...event }); } catch { /* Logging cannot alter HTTP or delivery outcomes. */ }
  };
  let stage = 'headers';
  let response: Response | undefined;
  let headersMs: number | null = null;
  let bodyMs: number | null = null;
  log({ event: 'start' });
  try {
    response = await fetch(options.url, { method: 'POST', headers: options.headers, body: options.body, signal, dispatcher: modelDispatcher } as RequestInit);
    headersMs = Math.round(performance.now() - started);
    const upstreamRequestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    stage = 'body';
    const bodyStarted = performance.now();
    const text = await response.text();
    bodyMs = Math.round(performance.now() - bodyStarted);
    stage = 'json';
    let raw: unknown = null;
    let validJson = true;
    try { raw = JSON.parse(text); } catch { validJson = false; }
    log({ event: response.ok && validJson ? 'complete' : 'failed', status: response.status, upstreamRequestId, headersMs, bodyMs, responseBytes: Buffer.byteLength(text), validJson, ...(response.ok && validJson ? {} : { errorType: response.ok ? 'invalid_json' : 'http_error' }) });
    return { response, raw, requestId };
  } catch (error) {
    log({ event: 'failed', stage, status: response?.status ?? null, headersMs, bodyMs, timedOut: signal.aborted && signal.reason?.name === 'TimeoutError', errorType: error instanceof Error ? error.name : 'unknown' });
    // Preserve the original error, including a timeout while reading the body.
    throw error;
  }
}

export interface FunctionCall {
  type: 'function_call';
  name: string;
  call_id: string;
  arguments: string;
}

interface ResponsesBody {
  output: unknown[];
  output_text?: string;
}

export async function requestTurn(store: Store, session: string, config: AgentConfig, request: {
  turn: number;
  input: unknown[];
  tools: unknown[];
  toolChoice: 'none' | { type: 'function'; name: string } | undefined;
  /** Whether this ask has sent any ready attachment; an HTTP error is then reported as an attachment input error. */
  hasReadyAttachments: boolean;
  /** Stored with the measured usage so the next ask can predict its size. */
  localEstimate: number;
  contextLimit: number;
  limitSource: 'known model limit' | 'configured budget';
}): Promise<{ body: ResponsesBody; raw: unknown; requestId: string; httpStatus: number }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  // Every channel shares the same prompt start; a per-session key keeps its requests on the machine that holds its cache,
  // and extended retention keeps a channel's history cached between messages minutes apart.
  const requestBody = JSON.stringify({ model: config.model, input: request.input, tools: request.tools, prompt_cache_key: session, prompt_cache_retention: '24h', ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}), ...(config.reasoningEffort === undefined || config.reasoningEffort === 'auto' ? {} : { reasoning: { effort: config.reasoningEffort } }), store: false });
  const requestId = randomUUID();
  store.saveModelRequest({ requestId, sessionId: session, askId: config.askId, traceId: config.traceId, turn: request.turn, bodyJson: JSON.stringify({ redacted: true, body: redactAttachmentPayload(JSON.parse(requestBody)) }) });
  let result: Awaited<ReturnType<typeof requestModel>>;
  try {
    result = await requestModel({ url: `${config.baseUrl.replace(/\/$/, '')}/responses`, headers, body: requestBody, session, model: config.model, turn: request.turn, timeoutMs: config.timeoutMs, askId: config.askId, traceId: config.traceId, requestId });
  } catch (error) {
    store.finishModelRequest(requestId, { errorType: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
  const { response, raw } = result;
  store.finishModelRequest(requestId, { httpStatus: response.status, usage: isRecord(raw) ? raw.usage : undefined, ...(!response.ok ? { errorType: 'http_error' } : raw === null ? { errorType: 'invalid_json' } : {}) });
  if (!response.ok) {
    const serviceError = isRecord(raw) ? raw.error : undefined;
    const details = typeof serviceError === 'string' ? serviceError : isRecord(serviceError) ? ['type', 'code', 'message'].filter(key => typeof serviceError[key] === 'string').map(key => `${key}=${serviceError[key]}`).join(' ') : '';
    if (request.hasReadyAttachments) throw new AttachmentInputError('request_rejected', response.status, { cause: new Error(`LLM HTTP ${response.status}${details ? `: ${details}` : ''}`) });
    throw new Error(`LLM HTTP ${response.status}${details ? `: ${details}` : ''}`);
  }
  const body = parseResponse(raw);
  const safeMeta = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
  const outputMeta = body.output.map((item: unknown) => {
    if (!isRecord(item)) return { type: 'unknown' };
    const base = { ...(safeMeta(item.type) ? { type: safeMeta(item.type) } : {}), ...(safeMeta(item.id) ? { id: safeMeta(item.id) } : {}), ...(safeMeta(item.status) ? { status: safeMeta(item.status) } : {}), ...(safeMeta(item.channel) ? { channel: safeMeta(item.channel) } : {}) };
    if (item.type === 'reasoning') return { ...base, present: true, summaryCount: Array.isArray(item.summary) ? item.summary.length : undefined, summary: Array.isArray(item.summary) ? item.summary.filter(isRecord).filter(part => typeof part.text === 'string').map(part => ({ text: (part.text as string).slice(0, 16000), textLength: (part.text as string).length, truncated: (part.text as string).length > 16000 })) : undefined };
    if (item.type === 'message') return { ...base, content: Array.isArray(item.content) ? item.content.map(part => isRecord(part) ? { type: safeMeta(part.type) ?? 'unknown', ...(typeof part.text === 'string' ? { textLength: part.text.length } : {}) } : { type: 'unknown' }) : undefined };
    if (item.type === 'function_call') return { ...base, name: safeMeta(item.name), callId: safeMeta(item.call_id) };
    return base;
  });
  logTrace('model_response_items', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn: request.turn, output: outputMeta, finishReason: safeMeta(isRecord(raw) ? raw.finish_reason : undefined), status: safeMeta(isRecord(raw) ? raw.status : undefined) });
  if (isRecord(raw) && isRecord(raw.usage) && Number.isSafeInteger(raw.usage.input_tokens) && Number.isSafeInteger(raw.usage.output_tokens)) {
    const cachedTokens = isRecord(raw.usage.input_tokens_details) ? raw.usage.input_tokens_details.cached_tokens : undefined;
    logTrace('model_usage', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn: request.turn, inputTokens: raw.usage.input_tokens, cachedTokens: typeof cachedTokens === 'number' ? cachedTokens : null, outputTokens: raw.usage.output_tokens });
    store.saveContextUsage(session, { model: config.model, baseUrl: config.baseUrl, inputTokens: raw.usage.input_tokens as number, outputTokens: raw.usage.output_tokens as number, localCount: request.localEstimate, contextLimit: request.contextLimit, limitSource: request.limitSource, sampledAt: new Date().toISOString() });
  } else store.clearContextUsage(session);
  // Failed/cancelled/incomplete upstream turns must not enter recovery or execute tools.
  // Transport aborts and timeouts already throw from requestModel before this point.
  if (isRecord(raw) && raw.status !== undefined && raw.status !== 'completed') {
    throw new Error(`LLM response status ${String(raw.status)} cannot complete the turn`);
  }
  return { body, raw, requestId, httpStatus: response.status };
}

function parseResponse(value: unknown): ResponsesBody {
  if (!isRecord(value) || !Array.isArray(value.output)) throw new Error('LLM response is missing output array');
  for (const item of value.output) {
    if (!isRecord(item) || typeof item.type !== 'string') throw new Error('LLM response contains an invalid output item');
    if (item.type === 'function_call' && !isFunctionCall(item)) throw new Error('LLM response contains an invalid function call');
  }
  if (value.output_text !== undefined && typeof value.output_text !== 'string') throw new Error('LLM response output_text must be a string');
  return value as unknown as ResponsesBody;
}

export function isFunctionCall(value: unknown): value is FunctionCall {
  return isRecord(value) && value.type === 'function_call' && typeof value.name === 'string' &&
    typeof value.call_id === 'string' && typeof value.arguments === 'string';
}

export function responseText(body: ResponsesBody): string {
  const hasCommentary = body.output.some(item => isRecord(item) && item.type === 'message' && item.channel === 'commentary');
  if (body.output_text !== undefined && !hasCommentary) return body.output_text;
  return body.output.map(item => {
    if (!isRecord(item) || item.type !== 'message' || item.channel === 'commentary' || !Array.isArray(item.content)) return '';
    return item.content.map(part => isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' ? part.text : '').join('');
  }).join('');
}
