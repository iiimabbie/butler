import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoogleClientConfig } from './config.js';

export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
// Connection only requires the base scopes; gmail.modify is checked by the tools that need it.
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file',
];
export const GOOGLE_SCOPES = [...BASE_SCOPES, GMAIL_MODIFY];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_PATH = fileURLToPath(new URL('../.data/google/tokens.json', import.meta.url));

type OAuthClient = { client_id: string; client_secret: string };
type Token = { access_token: string; refresh_token?: string; scope: string; expiry_date: number; reauthorization_required?: boolean };
type Store = { default_account: string; accounts: Record<string, Token> };
type Pending = { verifier: string; browser: string; csrf: string; expires: number };
export class GoogleAuthError extends Error {}

export class GoogleAuth {
  private pending = new Map<string, Pending>();
  private refreshFlights = new Map<string, Promise<Token>>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { client?: GoogleClientConfig; tokenPath?: string; fetcher?: typeof fetch } = {}) {}
  private get tokenPath() { return this.options.tokenPath ?? TOKEN_PATH; }
  // Single-account token file from before multi-account support; read only to migrate it once.
  private get legacyPath() { return join(dirname(this.tokenPath), 'token.json'); }

  async status(): Promise<'not_configured' | 'not_connected' | 'connected' | 'reauthorization_required'> {
    try { await this.readClient(); } catch { return 'not_configured'; }
    try {
      const accounts = await this.accounts();
      if (accounts.some(a => a.status === 'connected')) return 'connected';
      return accounts.length ? 'reauthorization_required' : 'not_connected';
    } catch { return 'reauthorization_required'; }
  }

  async accounts() {
    const store = await this.readStore();
    return Object.entries(store.accounts).map(([email, token]) => ({ email, default: email === store.default_account, status: unusable(token) ? 'reauthorization_required' as const : 'connected' as const, gmail_modify: hasScope(token, GMAIL_MODIFY) }));
  }

  async resolveAccount(account?: string): Promise<string> { return pick(await this.readStore(), account); }

  async requireModify(account: string): Promise<void> {
    const token = (await this.readStore()).accounts[account];
    if (!token || !hasScope(token, GMAIL_MODIFY)) throw new GoogleAuthError('此帳號尚未授權 gmail.modify，請在 UI 重新授權該帳號');
  }

  async setDefault(account: string): Promise<void> {
    await this.mutate(store => { if (!Object.hasOwn(store.accounts, account)) throw new GoogleAuthError('找不到 Google 帳號'); store.default_account = account; });
  }

  async removeAccount(account: string): Promise<{ revoked: boolean }> {
    let token: Token | undefined;
    await this.mutate(store => {
      token = store.accounts[account];
      if (!token) throw new GoogleAuthError('找不到 Google 帳號');
      delete store.accounts[account];
      if (store.default_account === account) store.default_account = Object.keys(store.accounts)[0] ?? '';
    });
    try {
      const response = await (this.options.fetcher ?? fetch)('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token!.refresh_token ?? token!.access_token }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      return { revoked: response.ok };
    } catch { return { revoked: false }; }
  }

  async begin(browser: string): Promise<{ url: string; csrf: string }> {
    const client = await this.readClient();
    for (const [state, p] of this.pending) if (p.expires <= Date.now() || p.browser === browser) this.pending.delete(state);
    const csrf = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { verifier, browser, csrf, expires: Date.now() + 5 * 60_000 });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1', response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
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
    const email = await this.profile(token.access_token);
    await this.mutate(store => { store.accounts[email] = token; if (!store.default_account) store.default_account = email; });
    // A legacy token still present here failed migration; the new store supersedes it.
    await rm(this.legacyPath, { force: true });
  }

  async accessToken(account?: string): Promise<string> {
    const store = await this.readStore(); // Re-read for CLI/other processes and a subsequent UI login.
    const email = pick(store, account);
    const token = store.accounts[email]!;
    if (unusable(token)) throw new GoogleAuthError('Google 需要重新授權');
    if (token.expiry_date > Date.now() + 60_000) return token.access_token;
    let flight = this.refreshFlights.get(email);
    if (!flight) {
      flight = this.refresh(token, email).finally(() => { this.refreshFlights.delete(email); });
      this.refreshFlights.set(email, flight);
    }
    return (await flight).access_token;
  }

  async markReauthorizationRequired(email: string): Promise<void> {
    await this.mutate(store => { const token = store.accounts[email]; if (token) store.accounts[email] = { ...token, reauthorization_required: true }; });
  }

  // Without email the refreshed token is only returned (legacy migration); with email it is stored for that account.
  private async refresh(old: Token, email?: string): Promise<Token> {
    const client = await this.readClient();
    let body: Record<string, unknown>;
    try { body = await this.exchange({ ...client, refresh_token: old.refresh_token!, grant_type: 'refresh_token' }); }
    catch (error) {
      if (email && error instanceof GoogleAuthError && error.message === 'Google 需要重新授權') await this.markReauthorizationRequired(email);
      throw error;
    }
    const scope = typeof body.scope === 'string' ? body.scope : old.scope;
    if (!scopesPresent(scope)) { if (email) await this.markReauthorizationRequired(email); throw new GoogleAuthError('Google 需要重新授權'); }
    const next: Token = { access_token: body.access_token as string, refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : old.refresh_token, scope, expiry_date: expiry(body) };
    if (email) await this.mutate(store => { if (store.accounts[email]) store.accounts[email] = next; });
    return next;
  }

  private async profile(accessToken: string): Promise<string> {
    let response: Response;
    try { response = await (this.options.fetcher ?? fetch)('https://www.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new GoogleAuthError('無法取得 Gmail 帳號'); }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || typeof body.emailAddress !== 'string' || !body.emailAddress) throw new GoogleAuthError('無法取得 Gmail 帳號');
    return body.emailAddress;
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

  private async readStore(): Promise<Store> {
    return await this.loadStore() ?? await this.serialize(() => this.migrate());
  }
  private async loadStore(): Promise<Store | undefined> {
    let text: string;
    try { text = await readFile(this.tokenPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new GoogleAuthError('Google 憑證讀取失敗'); }
    let store: unknown;
    try { store = JSON.parse(text); } catch { /* reported below */ }
    if (!validStore(store)) throw new GoogleAuthError('Google 憑證格式錯誤');
    return store;
  }
  private async migrate(): Promise<Store> {
    const current = await this.loadStore(); // An earlier queued call may have migrated already.
    if (current) return current;
    let old: unknown;
    try { old = JSON.parse(await readFile(this.legacyPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { default_account: '', accounts: {} }; throw new GoogleAuthError('Google 需要重新授權'); }
    if (!validToken(old) || unusable(old)) throw new GoogleAuthError('Google 需要重新授權');
    const token = await this.refresh(old);
    const email = await this.profile(token.access_token);
    const store: Store = { default_account: email, accounts: { [email]: token } };
    await this.saveStore(store);
    await rm(this.legacyPath, { force: true });
    return store;
  }
  // Every account shares one file, so read-modify-write runs one at a time.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.writes.then(fn, fn);
    this.writes = task.catch(() => undefined);
    return task;
  }
  private mutate(fn: (store: Store) => void): Promise<void> {
    return this.serialize(async () => {
      const store = await this.loadStore() ?? { default_account: '', accounts: {} };
      fn(store);
      await this.saveStore(store);
    });
  }
  private async saveStore(store: Store): Promise<void> {
    const temp = `${this.tokenPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.tokenPath), 0o700);
      await writeFile(temp, JSON.stringify(store), { mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, this.tokenPath);
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new GoogleAuthError('Google 憑證保存失敗；請重新開始，不會重試授權交換');
    }
  }
}
function pick(store: Store, account?: string): string {
  const selected = account ?? store.default_account;
  if (!Object.hasOwn(store.accounts, selected)) throw new GoogleAuthError(`找不到 Google 帳號；已連線帳號：${Object.keys(store.accounts).join(', ') || '無'}`);
  return selected;
}
function expiry(body: Record<string, unknown>): number {
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new GoogleAuthError('Google 回傳無效 token 效期');
  return Date.now() + body.expires_in * 1000;
}
function scopesPresent(scope: string): boolean { const set = new Set(scope.split(/\s+/)); return BASE_SCOPES.every(s => set.has(s)); }
function hasScope(token: Token, scope: string): boolean { return token.scope.split(/\s+/).includes(scope); }
function unusable(token: Token): boolean { return !!token.reauthorization_required || !token.refresh_token || !scopesPresent(token.scope); }
function safeEqual(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validToken(x: unknown): x is Token { return isRecord(x) && typeof x.access_token === 'string' && !!x.access_token && typeof x.scope === 'string' && typeof x.expiry_date === 'number' && Number.isFinite(x.expiry_date) && (x.refresh_token === undefined || typeof x.refresh_token === 'string'); }
function validStore(x: unknown): x is Store {
  if (!isRecord(x) || typeof x.default_account !== 'string' || !isRecord(x.accounts) || !Object.values(x.accounts).every(validToken)) return false;
  return Object.keys(x.accounts).length === 0 || Object.hasOwn(x.accounts, x.default_account);
}
