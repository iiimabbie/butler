import { logError } from './log.js';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { logInfo } from './log.js';

const traceInstanceId = randomUUID();
const traceHmacKey = randomBytes(32);
export function traceTextMetadata(text: string): { textLength: number; textHmac: string } {
  return { textLength: text.length, textHmac: createHmac('sha256', traceHmacKey).update(text).digest('hex').slice(0, 24) };
}
export function logTrace(event: string, fields: Record<string, unknown>): void {
  try { logInfo(event, { instanceId: traceInstanceId, ...fields }); } catch { /* diagnostics must not affect message flow */ }
}

/** Metadata only: never log prompts, responses, credentials or endpoint URLs. */
export async function requestModel(options: {
  url: string; headers: Record<string, string>; body: string; session: string;
  model: string; turn: number; timeoutMs: number; fetcher: typeof fetch;
  emit?: (event: Record<string, unknown>) => void;
  askId?: string; traceId?: string;
}): Promise<{ response: Response; raw: unknown; requestId: string }> {
  const requestId = randomUUID();
  const started = performance.now();
  const signal = AbortSignal.timeout(options.timeoutMs);
  const emit = options.emit ?? (event => { const { event: name, timestamp: _timestamp, ...fields } = event; if (name === 'failed') logError('Model HTTP request failed', undefined, { notify: false, fields }); else logInfo(`model_http_${String(name)}`, fields); });
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
    response = await options.fetcher(options.url, { method: 'POST', headers: options.headers, body: options.body, signal });
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
