import { GoogleAuthError, type GoogleAuth } from './google-auth.js';
import { ToolUsageError } from './tool-errors.js';
import { readJsonResponse, readResponseBytes, ResponseSizeLimitError } from './response-body.js';

export const GOOGLE_FILE_LIMIT = 10 * 1024 * 1024;
export class GoogleClient {
  constructor(private readonly auth: GoogleAuth) {}
  async available(): Promise<boolean> { return await this.auth.status() === 'connected'; }

  async accounts() { return this.auth.accounts(); }
  async account(value?: string) {
    try { return await this.auth.resolveAccount(value); }
    catch (error) { if (error instanceof GoogleAuthError) throw new ToolUsageError(error.message); throw error; }
  }
  async requireModify(account: string) { return this.auth.requireModify(account); }

  async request(path: string, options: {
    account?: string;
    method?: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    upload?: { bytes: Buffer; contentType: string };
    raw?: boolean;
  } = {}): Promise<any> {
    if (!/^\/(gmail\/v1\/|calendar\/v3\/|tasks\/v1\/|drive\/v3\/|upload\/drive\/v3\/)/.test(path) || path.includes('..') || path.includes('\\') || path.includes('?') || path.includes('#')) throw new Error('Invalid Google API path');
    if (!await this.available()) throw new Error('Google tools are unavailable until Google is connected');
    const account = await this.account(options.account);
    const url = new URL(path, 'https://www.googleapis.com');
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let token: string;
    try { token = await this.auth.accessToken(account); }
    catch (error) { if (error instanceof GoogleAuthError) throw new ToolUsageError(error.message); throw error; }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (options.upload) { headers['content-type'] = options.upload.contentType; body = new Uint8Array(options.upload.bytes); }
    else if (options.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.body); }
    let response: Response;
    try { response = await fetch(url, { method: options.method ?? 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('Google API connection failed; outcome is unknown and was not retried'); }
    if (!response.ok) {
      if (response.status === 401) {
        await this.auth.markReauthorizationRequired(account);
        throw new Error('Google token rejected; reconnect Google. The request was not retried.');
      }
      throw new Error(`Google API request failed (HTTP ${response.status}); request was not retried`);
    }
    if (response.status === 204) return {};
    if (options.raw) {
      try { return { content_type: response.headers.get('content-type') ?? 'application/octet-stream', bytes: await readLimited(response) }; }
      catch (error) { throw new Error(error instanceof Error && error.message === 'Google file exceeds the 10 MiB read limit' ? error.message : 'Google file read failed; no complete result was returned'); }
    }
    const value: unknown = await readJsonResponse(response, GOOGLE_FILE_LIMIT).catch(() => null);
    if (value === null || typeof value !== 'object') throw new Error('Google API returned invalid JSON; request was not retried');
    return value;
  }
}

async function readLimited(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > GOOGLE_FILE_LIMIT) { await response.body?.cancel(); throw new Error('Google file exceeds the 10 MiB read limit'); }
  try { return await readResponseBytes(response, GOOGLE_FILE_LIMIT); }
  catch (error) {
    if (error instanceof ResponseSizeLimitError) throw new Error('Google file exceeds the 10 MiB read limit');
    throw error;
  }
}
