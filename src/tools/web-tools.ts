import { createTavilyToolRuntime, prepareWebRequest, webDefinitions } from './web-tavily.js';
import { ToolUsageError, WebFetchExtractionError, WebPoolError, WebProviderError } from './tool-errors.js';
import { readJsonResponse } from '../response-body.js';
import { assertPublicWebUrl, withWebSignal } from './web-url.js';
import { logInfo, logWarn } from '../log.js';
export { webDefinitions } from './web-tavily.js';

type Provider = 'tavily' | 'firecrawl' | 'anysearch';
type Operation = 'search' | 'fetch';
export type ProviderConfig = { enabled?: boolean; apiKey?: string; baseUrl?: string; dailyRequestLimit?: number };
export type WebConfig = {
  pool?: { searchOrder?: Provider[]; fetchOrder?: Provider[]; searchTimeoutMs?: number; fetchTimeoutMs?: number; attemptTimeoutMs?: number; maxAttempts?: number };
  tavily?: ProviderConfig;
  firecrawl?: ProviderConfig;
  anysearch?: ProviderConfig;
};
export type WebToolRuntime = { definitions: typeof webDefinitions; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
type Kind = 'timeout' | 'network' | 'rate_limit' | 'upstream' | 'parse' | 'auth' | 'quota' | 'endpoint' | 'invalid_request' | 'source_unreadable' | 'encoding_suspect' | 'not_found' | 'empty' | 'cancelled' | 'budget' | 'cooldown' | 'unsupported' | 'unconfigured';
type Attempt = { provider: Provider; outcome: string; duration_ms: number; credit_usage?: string; estimated_credits?: number; actual_credits?: number };
class ProviderError extends WebProviderError { declare readonly kind: Kind; constructor(kind: Kind) { super(kind); } }
type Health = { failures: number; until: number; probe: boolean; disabled?: 'auth' | 'quota' | 'endpoint' };
const transient = new Set<Kind>(['timeout','network','rate_limit','upstream','parse']);
const technical = new Set<Kind>([...transient, 'auth','quota','endpoint']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function createWebToolRuntime(config: WebConfig & { reserveRequest: (provider: Provider, limit: number) => boolean }): WebToolRuntime {
  const fetcher = fetch;
  const tavilyKey = config.tavily?.enabled === true ? config.tavily.apiKey?.trim() : undefined;
  const fireKey = config.firecrawl?.enabled === true ? config.firecrawl.apiKey?.trim() : undefined;
  const anyKey = config.anysearch?.enabled === true ? config.anysearch.apiKey?.trim() : undefined;
  const keys: Record<Provider, string | undefined> = { tavily: tavilyKey, firecrawl: fireKey, anysearch: anyKey };
  const health = new Map<string, Health>();
  const providerKey = (provider: Provider) => keys[provider];
  const providerConfig = (provider: Provider) => config[provider];
  const providerBase = (provider: Provider) => providerConfig(provider)?.baseUrl ?? (provider === 'tavily' ? 'https://api.tavily.com' : provider === 'firecrawl' ? 'https://api.firecrawl.dev/v2' : 'https://api.anysearch.com/v1');
  const redact = (text: string) => [config.tavily?.apiKey?.trim(), config.firecrawl?.apiKey?.trim(), config.anysearch?.apiKey?.trim()].reduce<string>((value, key) => key ? value.replaceAll(key, '[redacted]') : value, text);
  const reserve = (provider: Provider) => {
    const limit = providerConfig(provider)?.dailyRequestLimit ?? 0;
    if (!config.reserveRequest(provider, limit)) throw new ProviderError('budget');
  };
  const healthFor = (provider: Provider, operation: Operation) => {
    const key = `${provider}:${operation}`;
    let entry = health.get(key);
    if (!entry) { entry = { failures: 0, until: 0, probe: false }; health.set(key, entry); }
    return entry;
  };
  const tavily = (signal?: AbortSignal, transport = fetcher, onUsage?: (credits: number) => void) => createTavilyToolRuntime({ baseUrl: config.tavily?.baseUrl, apiKey: tavilyKey, fetcher: transport, signal, onUsage });
  return {
    definitions: webDefinitions.filter(tool => tool.name === 'web_search' || tool.name === 'web_fetch' ? Boolean(tavilyKey || fireKey || anyKey) : Boolean(tavilyKey)),
    async execute(name, args) {
      const prepared = prepareWebRequest(name, args); // Invalid arguments stop before DNS, budget or providers.
      const pooled = name === 'web_search' || name === 'web_fetch' || (name === 'web_extract' && (prepared.body!.urls as string[]).length === 1 && !args.query && (args.extract_depth ?? 'basic') === 'basic' && (args.format ?? 'markdown') === 'markdown');
      const operation: Operation = name === 'web_search' ? 'search' : 'fetch';
      const totalMs = operation === 'search' ? config.pool?.searchTimeoutMs ?? 30_000 : config.pool?.fetchTimeoutMs ?? 45_000;
      const started = Date.now();
      const signal = AbortSignal.timeout(pooled ? totalMs : 35_000);
      const urls = prepared.endpoint === 'extract' ? prepared.body!.urls as string[] : [];
      for (const url of urls) {
        try { await assertPublicWebUrl(url, signal); }
        catch (error) { if (error instanceof ToolUsageError) throw error; throw new WebPoolError('URL validation failed or timed out', false); }
      }
      if (!pooled) {
        if (!tavilyKey) throw new ToolUsageError('This web operation requires enabled Tavily configuration');
        // Batch extraction, query chunks, advanced/text extraction and usage retain their Tavily contract.
        signal.throwIfAborted();
        if (name !== 'web_usage') {
          if (healthFor('tavily', 'fetch').disabled) throw new WebPoolError('Tavily is disabled after a credential/account failure', false);
          try { reserve('tavily'); } catch { throw new WebPoolError('Tavily daily request budget', false); }
        }
        const result = await withWebSignal(tavily(signal).execute(name, prepared), signal);
        return record(result) ? boundPoolOutput(redactObject(result, redact)) : result;
      }
      const attempts: Attempt[] = [];
      const order = operation === 'search' ? config.pool?.searchOrder ?? ['tavily','anysearch','firecrawl'] : config.pool?.fetchOrder ?? ['tavily','anysearch','firecrawl'];
      let count = 0, empty: Record<string, unknown> | undefined, partial: Record<string, unknown> | undefined;
      for (const provider of [...new Set(order)]) {
        if (signal.aborted || Date.now() - started >= totalMs) throw new WebPoolError('deadline', false);
        if (count >= (config.pool?.maxAttempts ?? 3)) break;
        const skip = (kind: Kind) => attempts.push({ provider, outcome: kind, duration_ms: 0 });
        if (!providerKey(provider)) { skip('unconfigured'); continue; }
        if (provider === 'firecrawl' && !supportsFirecrawl(operation, prepared.body!)) { skip('unsupported'); continue; }
        if (provider === 'anysearch' && !supportsAnySearch(operation, prepared.body!)) { skip('unsupported'); continue; }
        const health = healthFor(provider, operation);
        if (health.disabled) { skip(health.disabled); continue; }
        if (health.probe || health.until > Date.now()) { skip('cooldown'); continue; }
        try { reserve(provider); } catch { skip('budget'); continue; }
        const wasProbe = health.until > 0;
        if (wasProbe) health.probe = true;
        count++;
        const at = Date.now();
        const attemptTimeout = AbortSignal.timeout(Math.min(config.pool?.attemptTimeoutMs ?? 15_000, Math.max(1, totalMs - (at - started))));
        const attemptSignal = AbortSignal.any([signal, attemptTimeout]);
        let actualCredits: number | undefined;
        const transport: typeof fetch = async (input, init) => {
          let response: Response;
          try { response = await withWebSignal(fetcher(input, { ...init, signal: attemptSignal }), attemptSignal); }
          catch { throw new ProviderError(attemptSignal.aborted ? 'timeout' : 'network'); }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new ProviderError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 402 || response.status === 432 ? 'quota' : response.status === 404 || response.status === 410 ? 'endpoint' : response.status === 422 ? 'source_unreadable' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'upstream' : 'invalid_request');
          }
          return response;
        };
        const estimate = provider === 'anysearch' ? undefined : provider === 'tavily' ? (operation === 'search' ? prepared.body!.search_depth === 'advanced' ? 2 : 1 : 1) : operation === 'search' ? Math.ceil(Number(prepared.body!.max_results) / 10) * 2 : 1;
        try {
          let result: unknown;
          if (provider === 'tavily') {
            result = await withWebSignal(tavily(attemptSignal, transport, credits => { actualCredits = credits; }).execute(name, prepared), attemptSignal);
          } else if (provider === 'anysearch') {
            result = await anysearch(operation, prepared.body!, providerBase(provider), anyKey!, transport, attemptSignal);
          } else {
            const response = await firecrawl(operation, prepared.body!, providerBase(provider), fireKey!, transport, attemptSignal);
            actualCredits = response.actualCredits; result = response.result;
          }
          if (signal.aborted || Date.now() - started >= totalMs) throw new WebPoolError('deadline', false);
          if (!record(result)) throw new ProviderError('parse');
          if (operation === 'fetch' && provider !== 'tavily' && name === 'web_extract') result = { result_count: 1, failed_count: 0, results: [result], failed_results: [], truncated: Boolean(result.truncated) };
          if (!record(result)) throw new ProviderError('parse');
          if (operation === 'fetch') {
            if (Array.isArray(result.results) && !result.results.length && Array.isArray(result.failed_results) && result.failed_results.length) throw new ProviderError('source_unreadable');
            const pages = Array.isArray(result.results) ? result.results : [result];
            if (pages.some(page => !record(page) || page.url !== urls[0])) throw new ProviderError('parse');
          }
          if (operation === 'search' && Array.isArray(result.results)) {
            result.results = result.results.filter(item => record(item) && typeof item.url === 'string' && domainAllowed(item.url, prepared.body!));
            result.result_count = (result.results as unknown[]).length;
          }
          const status = assess(result, operation);
          const entry: Attempt = { provider, outcome: status, duration_ms: Date.now() - at, ...(estimate !== undefined ? { estimated_credits: estimate } : {}), credit_usage: actualCredits !== undefined ? 'reported' : estimate !== undefined ? 'estimated' : 'unknown', ...(actualCredits !== undefined ? { actual_credits: actualCredits } : {}) };
          attempts.push(entry);
          logInfo('web_pool_attempt', { operation, ...entry, ...(urls.length ? { domain: new URL(urls[0]!).hostname } : {}) });
          health.failures = 0; health.until = 0;
          if (status === 'empty') { empty = decorate(redactObject(result, redact), provider, attempts, operation); continue; }
          if (status === 'source_unreadable' || status === 'encoding_suspect') continue;
          if (status === 'partial') { partial ??= decorate(redactObject(result, redact), provider, attempts, operation); continue; }
          if (status === 'not_found') throw new ProviderError('not_found');
          if (attempts.some(item => technical.has(item.outcome as Kind) || ['source_unreadable','encoding_suspect','partial'].includes(item.outcome))) logWarn('Web pool fallback succeeded', undefined, { operation, provider, attempts: attempts.length });
          return boundPoolOutput(decorate(redactObject(result, redact), provider, attempts, operation));
        } catch (error) {
          if (signal.aborted || Date.now() - started >= totalMs) throw new WebPoolError('deadline', false);
          const kind = classify(error, attemptSignal);
          if (attempts.at(-1)?.provider !== provider || !['not_found'].includes(attempts.at(-1)!.outcome)) {
            const entry: Attempt = { provider, outcome: kind, duration_ms: Date.now() - at, ...(estimate !== undefined ? { estimated_credits: estimate } : {}), credit_usage: actualCredits !== undefined ? 'reported' : estimate !== undefined ? 'estimated' : 'unknown', ...(actualCredits !== undefined ? { actual_credits: actualCredits } : {}) };
            attempts.push(entry); logInfo('web_pool_attempt', { operation, ...entry });
          }
          if (kind === 'cancelled' || kind === 'invalid_request' || kind === 'not_found') throw new WebPoolError(kind, false);
          if (kind === 'auth' || kind === 'quota' || kind === 'endpoint') {
            // Credential/account failures apply to both capabilities, not a target domain.
            if (kind === 'endpoint') health.disabled = kind;
            else { healthFor(provider, 'search').disabled = kind; healthFor(provider, 'fetch').disabled = kind; }
            logWarn('Web provider disabled until credentials change or process restart', undefined, { provider, kind });
          } else if (transient.has(kind)) {
            health.failures++;
            if (health.failures >= 3 || wasProbe) health.until = Date.now() + 5 * 60_000;
          }
        } finally { health.probe = false; }
      }
      if (signal.aborted || Date.now() - started >= totalMs) throw new WebPoolError('deadline', false);
      if (partial) return boundPoolOutput({ ...partial, attempts });
      if (empty) return boundPoolOutput({ ...empty, attempts });
      const failed = attempts.some(item => technical.has(item.outcome as Kind));
      throw new WebPoolError(`no usable ${operation} result (${attempts.map(item => `${item.provider}:${item.outcome}`).join(', ')})`, failed);
    },
  };
}

function supportsAnySearch(operation: Operation, body: Record<string, unknown>): boolean {
  if (operation === 'fetch') return true;
  return body.search_depth === 'basic' && (body.topic === undefined || body.topic === 'general') && !body.country && !body.start_date && !body.end_date && !body.time_range && !body.include_domains_mode && !(body.include_domains as unknown[] | undefined)?.length && !(body.exclude_domains as unknown[] | undefined)?.length && Number(body.max_results) <= 10;
}
async function anysearch(operation: Operation, body: Record<string, unknown>, base: string, key: string, transport: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  const payload = operation === 'search' ? { query: body.query, max_results: body.max_results, format: 'json' } : { url: (body.urls as string[])[0] };
  const response = await transport(`${base.replace(/\/+$/, '')}/${operation === 'search' ? 'search' : 'extract'}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal, redirect: 'error' });
  let data: unknown;
  try { data = await withWebSignal(readJsonResponse(response, 5 * 1024 * 1024, signal), signal); }
  catch { throw new ProviderError(signal.aborted ? 'timeout' : 'parse'); }
  // Never log message: 402 responses may contain generated account credentials.
  if (!record(data) || data.code !== 0 || !record(data.data)) throw new ProviderError('parse');
  if (operation === 'search') {
    if (!Array.isArray(data.data.results)) throw new ProviderError('parse');
    const results = data.data.results.map(item => {
      if (!record(item) || typeof item.title !== 'string' || typeof item.url !== 'string' || (item.snippet !== undefined && typeof item.snippet !== 'string')) throw new ProviderError('parse');
      return { title: item.title, url: item.url, content: item.snippet ?? '', truncated: false, content_scope: 'search_snippet' };
    }).slice(0, Number(body.max_results));
    return { query: body.query, result_count: results.length, results, truncated: false };
  }
  if (data.data.url !== (body.urls as string[])[0] || typeof data.data.content !== 'string') throw new ProviderError('parse');
  // The API may return cleaned HTML, JSON or text; do not pretend this is necessarily Markdown.
  return { url: data.data.url, content: data.data.content, content_format: 'provider_content', truncated: false };
}
function supportsFirecrawl(operation: Operation, body: Record<string, unknown>): boolean {
  if (operation === 'fetch') return true;
  // Conservatively skip filters whose semantics have not been live evaluated. Never silently drop them.
  if (body.search_depth !== 'basic' || (body.topic !== undefined && body.topic !== 'general') || body.country || body.start_date || body.end_date || body.time_range || body.include_domains_mode === 'prefer' || String(body.query).length > 500) return false;
  const include = body.include_domains as string[] | undefined, exclude = body.exclude_domains as string[] | undefined;
  return !(include?.length && exclude?.length) && ![...(include ?? []), ...(exclude ?? [])].some(domain => domain.startsWith('*.'));
}
async function firecrawl(operation: Operation, body: Record<string, unknown>, base: string, key: string, transport: typeof fetch, signal: AbortSignal): Promise<{ result: Record<string, unknown>; actualCredits?: number }> {
  const payload = operation === 'search' ? { query: body.query, limit: body.max_results, sources: ['web'], highlights: false, ...(Array.isArray(body.include_domains) && body.include_domains.length ? { includeDomains: body.include_domains } : {}), ...(Array.isArray(body.exclude_domains) && body.exclude_domains.length ? { excludeDomains: body.exclude_domains } : {}), timeout: 15_000 }
    : { url: (body.urls as string[])[0], formats: ['markdown'], onlyMainContent: true, onlyCleanContent: false, proxy: 'basic', parsers: [], skipTlsVerification: false, timeout: 15_000, storeInCache: false };
  const response = await transport(`${base.replace(/\/+$/, '')}/${operation === 'search' ? 'search' : 'scrape'}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal, redirect: 'error' });
  let data: unknown;
  try { data = await withWebSignal(readJsonResponse(response, 5 * 1024 * 1024, signal), signal); }
  catch { throw new ProviderError(signal.aborted ? 'timeout' : 'parse'); }
  if (!record(data)) throw new ProviderError('parse');
  if (data.success !== true) throw new ProviderError(data.code === 'insufficient_credits' ? 'quota' : 'parse');
  if (!record(data.data)) throw new ProviderError('parse');
  const actualCredits = number(data.creditsUsed);
  if (operation === 'search') {
    if (!Array.isArray(data.data.web)) throw new ProviderError('parse');
    const results = data.data.web.map(item => {
      if (!record(item) || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.description !== 'string') throw new ProviderError('parse');
      try { if (!['http:', 'https:'].includes(new URL(item.url).protocol)) throw new Error(); } catch { throw new ProviderError('parse'); }
      return { title: item.title, url: item.url, content: item.description, truncated: false };
    }).filter(item => domainAllowed(item.url, body)).slice(0, Number(body.max_results));
    return { result: { query: body.query, result_count: results.length, results, truncated: false }, actualCredits };
  }
  const page = data.data, metadata = record(page.metadata) ? page.metadata : {};
  if (metadata.statusCode === 404 || metadata.statusCode === 410) throw new ProviderError('not_found');
  if (typeof metadata.statusCode === 'number' && metadata.statusCode >= 400) throw new ProviderError('source_unreadable');
  if (metadata.error) throw new ProviderError('source_unreadable');
  if (typeof page.markdown !== 'string') throw new ProviderError('parse');
  const item = { url: (body.urls as string[])[0], content: page.markdown, truncated: Boolean(page.warning), ...(typeof metadata.url === 'string' ? { final_url: metadata.url } : {}), ...(typeof metadata.statusCode === 'number' ? { source_status: metadata.statusCode } : {}), ...(typeof metadata.contentType === 'string' ? { source_content_type: metadata.contentType } : {}) };
  return { result: item, actualCredits };
}
function domainAllowed(value: string, body: Record<string, unknown>): boolean {
  let host: string;
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false; host = url.hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  const match = (domain: string) => { const plain = domain.replace(/^\*\./, '').toLowerCase(); return host === plain || host.endsWith(`.${plain}`); };
  const include = body.include_domains as string[] | undefined, exclude = body.exclude_domains as string[] | undefined;
  return !(exclude?.some(match)) && (!include?.length || body.include_domains_mode === 'prefer' || include.some(match));
}
function classify(error: unknown, signal: AbortSignal): Kind {
  if (error instanceof WebProviderError) return error.kind as Kind;
  if (signal.aborted) return 'timeout';
  if (error instanceof WebFetchExtractionError) return 'source_unreadable';
  return 'parse';
}
function assess(result: Record<string, unknown>, operation: Operation): 'success' | 'partial' | 'empty' | 'source_unreadable' | 'encoding_suspect' | 'not_found' {
  if (operation === 'search') {
    if (!Array.isArray(result.results)) throw new ProviderError('parse');
    return result.results.length ? 'success' : 'empty';
  }
  const pages = Array.isArray(result.results) ? result.results : [result];
  if (!pages.length) return 'source_unreadable';
  for (const page of pages) {
    if (!record(page) || typeof page.content !== 'string') throw new ProviderError('parse');
    const text = page.content.trim();
    const replacement = (text.match(/\uFFFD/g) ?? []).length;
    const latinExtended = (text.match(/[\u0100-\u02ff]/g) ?? []).length;
    const greek = (text.match(/[\u0370-\u03ff]/g) ?? []).length;
    const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
    // A conservative corruption heuristic, not a guarantee of correct character decoding.
    // GBK mis-decoded and then stripped by providers can lose U+FFFD but retain mixed-script fragments.
    if ((replacement >= 3 && replacement / text.length > 0.002) || (latinExtended >= 8 && greek >= 3 && cjk < latinExtended / 3 && (latinExtended + greek) / text.length > 0.02)) return 'encoding_suspect';
    // Template-like short pages only; do not reject long articles that discuss CAPTCHAs or logins.
    if (text.length < 300 && /^(?:#{1,6}\s*)?(?:404(?:[ :-]+(?:page )?not found)?|410[ :-]+gone)[.! ]*(?:\n|$)/i.test(text)) return 'not_found';
    if (!text || (text.length < 2000 && /(?:^|\n)(?:#{1,6}\s*)?(?:just a moment|access denied|verify (?:that )?you are human|checking your browser|sign in to continue|log in to continue|請先登入|請驗證您是人類)[.!…\s]*(?:\n|$)/i.test(text))) return 'source_unreadable';
  }
  return result.truncated || pages.some(page => record(page) && page.truncated) ? 'partial' : 'success';
}
function decorate(result: Record<string, unknown>, provider: Provider, attempts: Attempt[], operation: Operation): Record<string, unknown> {
  const add = (page: Record<string, unknown>) => ({ ...page, provider, ...(operation === 'fetch' ? { status: page.truncated ? 'partial' : 'available', completeness: 'unverified' } : {}) });
  return { ...add(result), ...(Array.isArray(result.results) ? { results: result.results.map(item => record(item) ? add(item) : item) } : {}), attempts: [...attempts] };
}
function redactObject(value: Record<string, unknown>, redact: (value: string) => string): Record<string, unknown> {
  return JSON.parse(redact(JSON.stringify(value))) as Record<string, unknown>;
}
function boundPoolOutput(result: Record<string, unknown>): Record<string, unknown> {
  const limit = 64 * 1024 - 256, size = () => Buffer.byteLength(JSON.stringify(result));
  const pages = (Array.isArray(result.results) ? result.results : [result]).filter(record);
  if (size() <= limit) return result;
  result.truncated = true;
  const originals = new Map(pages.filter(page => typeof page.content === 'string').map(page => [page, page.content as string]));
  for (const page of originals.keys()) { page.content = ''; page.truncated = true; if ('status' in page) page.status = 'partial'; }
  for (const [page, original] of originals) {
    let low = 0, high = original.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); page.content = original.slice(0,mid); if (size() <= limit) low = mid; else high = mid - 1; }
    if (low > 0 && /[\uD800-\uDBFF]/.test(original[low - 1]!)) low--;
    page.content = original.slice(0,low);
    page.truncated = low < original.length;
  }
  if (size() > limit) throw new ProviderError('parse');
  if ('status' in result) result.status = 'partial';
  return result;
}
