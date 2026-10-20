import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoogleClientConfig } from './config.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_PATH = fileURLToPath(new URL('../.data/google/token.json', import.meta.url));

type OAuthClient = { client_id: string; client_secret: string };
type Token = { access_token: string; refresh_token?: string; scope: string; expiry_date: number; reauthorization_required?: boolean };
type Pending = { verifier: string; browser: string; csrf: string; expires: number };
export class GoogleAuthError extends Error {}

export class GoogleAuth {
  private pending = new Map<string, Pending>();
  private refreshFlight?: Promise<Token>;
  constructor(private readonly options: { client?: GoogleClientConfig; tokenPath?: string; fetcher?: typeof fetch } = {}) {}
  private get tokenPath() { return this.options.tokenPath ?? TOKEN_PATH; }

  async status(): Promise<'not_configured' | 'not_connected' | 'connected' | 'reauthorization_required'> {
    try { await this.readClient(); } catch { return 'not_configured'; }
    try {
      const t = await this.readToken();
      return t.reauthorization_required || !t.refresh_token || !scopesPresent(t.scope) ? 'reauthorization_required' : 'connected';
    } catch { return 'not_connected'; }
  }

  async begin(browser: string): Promise<{ url: string; csrf: string }> {
    const client = await this.readClient();
    for (const [state, p] of this.pending) if (p.expires <= Date.now() || p.browser === browser) this.pending.delete(state);
    const csrf = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { verifier, browser, csrf, expires: Date.now() + 5 * 60_000 });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1', response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { url: u.toString(), csrf };
  }

  async complete(inputUrl: string, csrf: string, browser: string): Promise<void> {
    let u: URL;
    try { u = new URL(inputUrl); } catch { throw new GoogleAuthError('請貼上 Google 導回的完整網址'); }
    if (u.origin !== 'http://127.0.0.1' || u.pathname !== '/' || u.username || u.password || u.hash || u.searchParams.getAll('state').length !== 1 || u.searchParams.getAll('code').length !== 1 || u.searchParams.has('error') || !u.searchParams.get('code')) throw new GoogleAuthError('授權網址格式不符，請重新開始');
    const state = u.searchParams.get('state')!;
    const pending = this.pending.get(state);
    if (!pending || pending.expires <= Date.now() || pending.browser !== browser || !safeEqual(pending.csrf, csrf)) throw new GoogleAuthError('授權已逾時或瀏覽器驗證失敗，請重新開始');
    this.pending.delete(state); // Consume before exchange: never replay an unknown outcome.
    const client = await this.readClient();
    const body = await this.exchange({ code: u.searchParams.get('code')!, ...client, redirect_uri: 'http://127.0.0.1', grant_type: 'authorization_code', code_verifier: pending.verifier });
    if (typeof body.scope !== 'string' || !scopesPresent(body.scope)) throw new GoogleAuthError('Google 未完整提供所需權限，請重新授權');
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new GoogleAuthError('Google 未提供這次登入的離線 refresh token，未保存新憑證；請重新開始授權');
    const token: Token = { access_token: body.access_token as string, refresh_token: body.refresh_token, scope: body.scope, expiry_date: expiry(body) };
    await this.saveToken(token);
  }

  async accessToken(): Promise<string> {
    const token = await this.readToken(); // Re-read for CLI/other processes and a subsequent UI login.
    if (token.reauthorization_required || !token.refresh_token || !scopesPresent(token.scope)) throw new GoogleAuthError('Google 需要重新授權');
    if (token.expiry_date > Date.now() + 60_000) return token.access_token;
    if (!this.refreshFlight) this.refreshFlight = this.refresh(token).finally(() => { this.refreshFlight = undefined; });
    return (await this.refreshFlight).access_token;
  }

  async markReauthorizationRequired(): Promise<void> {
    const token = await this.readToken();
    await this.saveToken({ ...token, reauthorization_required: true });
  }

  private async refresh(old: Token): Promise<Token> {
    const client = await this.readClient();
    let body: Record<string, unknown>;
    try { body = await this.exchange({ ...client, refresh_token: old.refresh_token!, grant_type: 'refresh_token' }); }
    catch (error) {
      if (error instanceof GoogleAuthError && error.message === 'Google 需要重新授權') await this.saveToken({ ...old, reauthorization_required: true });
      throw error;
    }
    const scope = typeof body.scope === 'string' ? body.scope : old.scope;
    if (!scopesPresent(scope)) { await this.saveToken({ ...old, reauthorization_required: true }); throw new GoogleAuthError('Google 需要重新授權'); }
    const next: Token = { access_token: body.access_token as string, refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : old.refresh_token, scope, expiry_date: expiry(body) };
    await this.saveToken(next);
    return next;
  }

  private async exchange(fields: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await (this.options.fetcher ?? fetch)(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new GoogleAuthError('Google 授權連線失敗；結果未確認，請重新開始'); }
    const body: unknown = await response.json().catch(() => null);
    if (isRecord(body) && body.error === 'invalid_grant') throw new GoogleAuthError('Google 需要重新授權');
    if (!response.ok || !isRecord(body) || typeof body.access_token !== 'string' || !body.access_token) throw new GoogleAuthError('Google 授權失敗，請重新開始');
    return body;
  }
  private async readClient(): Promise<OAuthClient> {
    const client = this.options.client;
    if (!client?.clientId || !client.clientSecret) throw new GoogleAuthError('Google client 尚未設定或格式錯誤');
    return { client_id: client.clientId, client_secret: client.clientSecret };
  }
  private async readToken(): Promise<Token> {
    try {
      const x: unknown = JSON.parse(await readFile(this.tokenPath, 'utf8'));
      if (!isRecord(x) || typeof x.access_token !== 'string' || !x.access_token || typeof x.scope !== 'string' || typeof x.expiry_date !== 'number' || !Number.isFinite(x.expiry_date) || (x.refresh_token !== undefined && typeof x.refresh_token !== 'string')) throw new Error();
      return x as Token;
    } catch { throw new GoogleAuthError('Google 尚未連線或 token 格式錯誤'); }
  }
  private async saveToken(token: Token): Promise<void> {
    const temp = `${this.tokenPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.tokenPath), 0o700);
      await writeFile(temp, JSON.stringify(token), { mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, this.tokenPath);
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new GoogleAuthError('Google 憑證保存失敗；請重新開始，不會重試授權交換');
    }
  }
}
function expiry(body: Record<string, unknown>): number {
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new GoogleAuthError('Google 回傳無效 token 效期');
  return Date.now() + body.expires_in * 1000;
}
function scopesPresent(scope: string): boolean { const set = new Set(scope.split(/\s+/)); return GOOGLE_SCOPES.every(s => set.has(s)); }
function safeEqual(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
