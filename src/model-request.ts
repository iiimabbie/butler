import { logError, logInfo } from './log.js';
import { randomUUID } from 'node:crypto';

/** Metadata only: never log prompts, responses, credentials or endpoint URLs. */
export async function requestModel(options: {
  url: string; headers: Record<string, string>; body: string; session: string;
  model: string; turn: number; timeoutMs: number; fetcher: typeof fetch;
  emit?: (event: Record<string, unknown>) => void;
}): Promise<{ response: Response; raw: unknown }> {
  const requestId = randomUUID();
  const started = performance.now();
  const signal = AbortSignal.timeout(options.timeoutMs);
  const emit = options.emit ?? (event => { const { event: name, timestamp: _timestamp, ...fields } = event; if (name === 'failed') logError('Model HTTP request failed', undefined, { notify: false, fields }); else logInfo(`model_http_${String(name)}`, fields); });
  const metadata = { requestId, session: options.session, model: options.model, turn: options.turn, timeoutMs: options.timeoutMs, requestBytes: Buffer.byteLength(options.body) };
  const log = (event: Record<string, unknown>) => emit({ timestamp: new Date().toISOString(), ...metadata, elapsedMs: Math.round(performance.now() - started), ...event });
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
    log({ event: 'complete', status: response.status, upstreamRequestId, headersMs, bodyMs, responseBytes: Buffer.byteLength(text), validJson });
    return { response, raw };
  } catch (error) {
    log({ event: 'failed', stage, status: response?.status ?? null, headersMs, bodyMs, timedOut: signal.aborted && signal.reason?.name === 'TimeoutError', errorType: error instanceof Error ? error.name : 'unknown' });
    // Preserve the original error, including a timeout while reading the body.
    throw error;
  }
}
