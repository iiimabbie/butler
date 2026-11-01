import { ToolUsageError, WebFetchExtractionError, WebProviderError } from './tool-errors.js';
import { readResponseBytes, ResponseSizeLimitError } from './response-body.js';
const RESPONSE_LIMIT = 5 * 1024 * 1024;
// Leave room for the agent's tool_history_id envelope.
const OUTPUT_LIMIT = 64 * 1024 - 256;
const SEARCH_DEPTH = ['basic', 'advanced'] as const;
const EXTRACT_DEPTH = ['basic', 'advanced'] as const;
const TOPICS = ['general', 'news', 'finance'] as const;
const TIME_RANGES = ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'] as const;
const FORMATS = ['markdown', 'text'] as const;
const COUNTRIES = ['afghanistan','albania','algeria','andorra','angola','argentina','armenia','australia','austria','azerbaijan','bahamas','bahrain','bangladesh','barbados','belarus','belgium','belize','benin','bhutan','bolivia','bosnia and herzegovina','botswana','brazil','brunei','bulgaria','burkina faso','burundi','cambodia','cameroon','canada','cape verde','central african republic','chad','chile','china','colombia','comoros','congo','costa rica','croatia','cuba','cyprus','czech republic','denmark','djibouti','dominican republic','ecuador','egypt','el salvador','equatorial guinea','eritrea','estonia','ethiopia','fiji','finland','france','gabon','gambia','georgia','germany','ghana','greece','guatemala','guinea','haiti','honduras','hungary','iceland','india','indonesia','iran','iraq','ireland','israel','italy','jamaica','japan','jordan','kazakhstan','kenya','kuwait','kyrgyzstan','latvia','lebanon','lesotho','liberia','libya','liechtenstein','lithuania','luxembourg','madagascar','malawi','malaysia','maldives','mali','malta','mauritania','mauritius','mexico','moldova','monaco','mongolia','montenegro','morocco','mozambique','myanmar','namibia','nepal','netherlands','new zealand','nicaragua','niger','nigeria','north korea','north macedonia','norway','oman','pakistan','panama','papua new guinea','paraguay','peru','philippines','poland','portugal','qatar','romania','russia','rwanda','saudi arabia','senegal','serbia','singapore','slovakia','slovenia','somalia','south africa','south korea','south sudan','spain','sri lanka','sudan','sweden','switzerland','syria','taiwan','tajikistan','tanzania','thailand','togo','trinidad and tobago','tunisia','turkey','turkmenistan','uganda','ukraine','united arab emirates','united kingdom','united states','uruguay','uzbekistan','venezuela','vietnam','yemen','zambia','zimbabwe'] as const;
const string = { type: 'string', minLength: 1 };
const stringArray = (maxItems: number) => ({ type: 'array', items: string, minItems: 1, maxItems });
const optionalArray = (maxItems: number) => ({ type: 'array', items: string, maxItems });

export const webDefinitions: { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }[] = [
  { type: 'function', name: 'web_search', description: 'Search the public web. Uses basic depth by default; advanced costs more and must be requested explicitly. Date windows and domain filters narrow results.', parameters: { type: 'object', properties: {
    query: string, max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 }, search_depth: { type: 'string', enum: SEARCH_DEPTH, default: 'basic' }, topic: { type: 'string', enum: TOPICS },
    include_domains: optionalArray(300), exclude_domains: optionalArray(150), include_domains_mode: { type: 'string', enum: ['restrict', 'prefer'] }, time_range: { type: 'string', enum: TIME_RANGES }, start_date: { type: 'string', format: 'date' }, end_date: { type: 'string', format: 'date' }, country: { type: 'string', enum: COUNTRIES },
  }, required: ['query'], additionalProperties: false } },
  { type: 'function', name: 'web_fetch', description: 'Extract content from one public HTTP(S) URL using basic extraction; truncated indicates incomplete content.', parameters: { type: 'object', properties: { url: string }, required: ['url'], additionalProperties: false } },
  { type: 'function', name: 'web_extract', description: 'Extract content from 1–20 public HTTP(S) URLs in one request. Use query for a specific question and relevant chunks; omit query to read the full content. chunks_per_source requires query. Returns successes and per-URL failures; advanced extraction may cost more. Content may be truncated.', parameters: { type: 'object', properties: { urls: stringArray(20), extract_depth: { type: 'string', enum: EXTRACT_DEPTH, default: 'basic' }, format: { type: 'string', enum: FORMATS, default: 'markdown' }, query: string, chunks_per_source: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['urls'], additionalProperties: false } },
  { type: 'function', name: 'web_usage', description: 'Read-only Tavily API key and account usage for the current billing cycle.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
];

export type WebToolRuntime = { definitions: typeof webDefinitions; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
export function createTavilyToolRuntime(config: { baseUrl?: string; apiKey?: string; fetcher?: typeof fetch; signal?: AbortSignal; onUsage?: (credits: number) => void } = {}): WebToolRuntime {
  const apiKey = config.apiKey?.trim();
  const fetcher = config.fetcher ?? fetch;
  const baseUrl = (config.baseUrl?.trim() || 'https://api.tavily.com').replace(/\/+$/, '');
  return {
    definitions: apiKey ? webDefinitions : [],
    async execute(name, args) {
      if (!apiKey) throw new Error('Web API key is not configured');
      const prepared = prepareWebRequest(name, args);
      const redact = (value: string) => value.replaceAll(apiKey, '[redacted]');
      if (name === 'web_search') {
        const body = prepared.body!;
        const query = body.query as string, maxResults = body.max_results as number;
        body.include_usage = true;
        const response = await request('search', body, apiKey, fetcher, baseUrl, config.signal);
        if (isRecord(response.usage) && typeof response.usage.credits === 'number' && Number.isFinite(response.usage.credits) && response.usage.credits >= 0) config.onUsage?.(response.usage.credits);
        if (!Array.isArray(response.results) || response.results.length > maxResults) throw new Error('Tavily search: invalid response');
        const results = response.results.map(item => {
          if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.content !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score)) throw new Error('Tavily search: invalid response');
          return { title: redact(item.title), url: redact(item.url), content: redact(item.content), score: item.score, truncated: false };
        });
        return boundedOutput({ query: redact(query), result_count: results.length, results, truncated: false }, results);
      }
      if (name === 'web_fetch' || name === 'web_extract') {
        const body = prepared.body!;
        const urls = body.urls as string[];
        const query = body.query as string | undefined;
        body.include_usage = true;
        const response = await request('extract', body, apiKey, fetcher, baseUrl, config.signal);
        if (isRecord(response.usage) && typeof response.usage.credits === 'number' && Number.isFinite(response.usage.credits) && response.usage.credits >= 0) config.onUsage?.(response.usage.credits);
        if (!Array.isArray(response.failed_results) || !Array.isArray(response.results)) throw new Error('Tavily extract: invalid response');
        const failed = response.failed_results.map(item => {
          if (!isRecord(item) || typeof item.url !== 'string' || typeof item.error !== 'string') throw new Error('Tavily extract: invalid response');
          return { url: item.url, error: item.error };
        });
        const results = response.results.map(item => {
          if (!isRecord(item) || typeof item.url !== 'string' || typeof item.raw_content !== 'string') throw new Error('Tavily extract: invalid response');
          return { url: redact(item.url), content: redact(item.raw_content), provider: 'tavily', completeness: 'unverified', truncated: false };
        });
        if (!results.length && failed.some(item => /\b(?:HTTP\s+(?:404|410)|status(?:\s+code)?[:\s]+(?:404|410))\b/i.test(item.error))) throw new WebProviderError('not_found');
        if (name === 'web_fetch') {
          if (failed.length) {
            const requestedUrl = urls[0]!;
            const failure = failed[0];
            const isKnownSinglePageFailure = failed.length === 1
              && results.length === 0
              && failure?.url === requestedUrl
              && failure.error.trim() === 'Error fetching content';
            if (results.length === 0 && failed.length > 0) {
              if (isKnownSinglePageFailure) throw new WebFetchExtractionError(redact(requestedUrl), redact(failure.error));
              const details = failed.map(item => `${redact(item.url)}: ${redact(item.error)}`).join('; ');
              throw new WebFetchExtractionError(redact(requestedUrl), redact(failure?.error ?? 'URL extraction failed'), `Tavily extract: URL extraction failed${details ? ` (${details})` : ''}`);
            }
            const details = failed.map(item => `${redact(item.url)}: ${redact(item.error)}`).join('; ');
            throw new Error(`Tavily extract: URL extraction failed${details ? ` (${details})` : ''}`);
          }
          if (results.length !== 1) throw new Error('Tavily extract: invalid response');
          return boundedOutput(results[0]!, [results[0]!]);
        }
        const safeFailed = failed.map(item => ({ url: redact(item.url), error: redact(item.error) }));
        const result = { result_count: results.length, failed_count: safeFailed.length, results, failed_results: safeFailed, truncated: false, ...(query !== undefined ? { content_scope: 'query_relevant_chunks' as const, content_scope_description: 'Content contains query-relevant chunks, not the full source content.' } : {}) };
        return boundedOutput(result, results);
      }
      const response = await request('usage', undefined, apiKey, fetcher, baseUrl, config.signal);
      if (!isRecord(response.key) || !isRecord(response.account)) throw new Error('Tavily usage: invalid response');
      return boundedUsageOutput(redactDeep(response, apiKey));
    },
  };
}

async function request(endpoint: 'search' | 'extract' | 'usage', body: Record<string, unknown> | undefined, apiKey: string, fetcher: typeof fetch, baseUrl: string, externalSignal?: AbortSignal): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/${endpoint}`, {
      method: endpoint === 'usage' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof WebProviderError) throw error;
    throw new Error(`Tavily ${endpoint}: ${signal.aborted ? 'request timed out' : 'request failed'}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Tavily ${endpoint}: HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Tavily ${endpoint}: response exceeds 5 MiB limit`);
  }
  if (!response.body) throw new Error(`Tavily ${endpoint}: invalid response`);
  let bytes: Buffer;
  try { bytes = await readResponseBytes(response, RESPONSE_LIMIT, signal); }
  catch (error) {
    throw new Error(`Tavily ${endpoint}: ${signal.aborted ? 'request timed out' : error instanceof ResponseSizeLimitError ? 'response exceeds 5 MiB limit' : 'response read failed'}`);
  }
  let result: unknown;
  try { result = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Tavily ${endpoint}: invalid response`); }
  if (!isRecord(result)) throw new Error(`Tavily ${endpoint}: invalid response`);
  return result;
}

function boundedOutput<T extends { truncated: boolean }>(result: T, contents: { content: string; truncated: boolean }[]): T {
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (size() <= OUTPUT_LIMIT) return result;
  result.truncated = true;
  const originals = contents.map(item => item.content);
  for (const item of contents) { item.truncated = item.content.length > 0; item.content = ''; }
  if (size() > OUTPUT_LIMIT) throw new Error('Tavily: result metadata exceeds 64 KiB output limit');
  for (let i = 0; i < contents.length; i++) {
    const item = contents[i]!, original = originals[i]!;
    let low = 0, high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      item.content = original.slice(0, middle);
      item.truncated = middle < original.length;
      if (size() <= OUTPUT_LIMIT) low = middle;
      else high = middle - 1;
    }
    if (low < original.length && /[\uD800-\uDBFF]/.test(original[low - 1] ?? '')) low--;
    item.content = original.slice(0, low);
    item.truncated = low < original.length;
  }
  result.truncated = true;
  return result;
}
function boundedUsageOutput(value: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > OUTPUT_LIMIT) {
    throw new Error('Tavily usage: result metadata exceeds 64 KiB output limit');
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolUsageError(`${name} must be a non-empty string`);
  return value.trim();
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < min || (result as number) > max) throw new ToolUsageError(`${name} must be an integer from ${min} to ${max}`);
  return result as number;
}
function oneOf<T extends string>(value: unknown, fallback: T, allowed: readonly T[], name: string): T {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !allowed.includes(result as T)) throw new ToolUsageError(`${name} must be one of the supported values`);
  return result as T;
}
function validDate(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new ToolUsageError(`${name} must be a valid YYYY-MM-DD date`);
  return result;
}
function stringList(value: unknown, max: number, name: string): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim())) throw new ToolUsageError(`${name} must be an array of 1-${max} non-empty strings`);
  return value.map(item => (item as string).trim());
}
function domainList(value: unknown, max: number, name: string): string[] {
  const domains = stringList(value, max, name);
  if (domains.some(domain => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))) {
    throw new ToolUsageError(`${name} must contain valid domain names`);
  }
  return domains;
}
function validUrl(value: unknown): string {
  const url = requiredString(value, 'url');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ToolUsageError('url must be an HTTP(S) URL without credentials'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ToolUsageError('url must be an HTTP(S) URL without credentials');
  }
  return url;
}
function validateUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new ToolUsageError('urls must contain 1 to 20 HTTP(S) URLs');
  return value.map(validUrl);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function redactDeep(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') return value.replaceAll(apiKey, '[redacted]');
  if (Array.isArray(value)) return value.map(item => redactDeep(item, apiKey));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, redactDeep(item, apiKey)]));
  return value;
}

export function prepareWebRequest(name: string, args: Record<string, unknown>): { endpoint: "search" | "extract" | "usage"; body?: Record<string, unknown> } {
      const allowedByName: Record<string, string[]> = {
        web_search: ['query','max_results','search_depth','topic','include_domains','exclude_domains','include_domains_mode','time_range','start_date','end_date','country'],
        web_fetch: ['url'], web_extract: ['urls','extract_depth','format','query','chunks_per_source'],
        web_usage: [],
      };
      const allowed = allowedByName[name];
      if (!allowed) throw new ToolUsageError('Unknown web tool');
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new ToolUsageError('Unknown web tool argument');

  if (name === 'web_search') {
        const query = requiredString(args.query, 'query');
        const maxResults = integer(args.max_results, 5, 1, 20, 'max_results');
        const depth = oneOf(args.search_depth, 'basic', SEARCH_DEPTH, 'search_depth');
        const body: Record<string, unknown> = { query, max_results: maxResults, search_depth: depth, auto_parameters: false, include_answer: false, include_raw_content: false };
        if (args.topic !== undefined) body.topic = oneOf(args.topic, 'general', TOPICS, 'topic');
        if (args.include_domains !== undefined) body.include_domains = domainList(args.include_domains, 300, 'include_domains');
        if (args.exclude_domains !== undefined) body.exclude_domains = domainList(args.exclude_domains, 150, 'exclude_domains');
        if (args.include_domains_mode !== undefined) {
          body.include_domains_mode = oneOf(args.include_domains_mode, 'restrict', ['restrict', 'prefer'] as const, 'include_domains_mode');
          if (!Array.isArray(body.include_domains) || body.include_domains.length === 0) throw new ToolUsageError('include_domains_mode requires a non-empty include_domains list');
        }
        if (args.time_range !== undefined) body.time_range = oneOf(args.time_range, 'day', TIME_RANGES, 'time_range');
        if (args.start_date !== undefined) body.start_date = validDate(args.start_date, 'start_date');
        if (args.end_date !== undefined) body.end_date = validDate(args.end_date, 'end_date');
        if (args.start_date !== undefined && args.end_date !== undefined && String(args.start_date) > String(args.end_date)) throw new ToolUsageError('start_date must be on or before end_date');
        if (args.country !== undefined) {
          body.country = oneOf(args.country, 'united states', COUNTRIES, 'country');
          if (body.topic !== undefined && body.topic !== 'general') throw new ToolUsageError('country is only supported with topic=general');
        }
    return { endpoint: 'search', body };
  }
  if (name === 'web_fetch' || name === 'web_extract') {
        const urls = name === 'web_fetch' ? [validUrl(args.url)] : validateUrls(args.urls);
        const depth = name === 'web_fetch' ? 'basic' : oneOf(args.extract_depth, 'basic', EXTRACT_DEPTH, 'extract_depth');
        const format = name === 'web_extract' ? oneOf(args.format, 'markdown', FORMATS, 'format') : undefined;
        const query = name === 'web_extract' && args.query !== undefined ? requiredString(args.query, 'query') : undefined;
        const chunksPerSource = name === 'web_extract' && args.chunks_per_source !== undefined
          ? integer(args.chunks_per_source, 3, 1, 5, 'chunks_per_source')
          : undefined;
        if (chunksPerSource !== undefined && query === undefined) throw new ToolUsageError('chunks_per_source requires query');
        const body: Record<string, unknown> = { urls, extract_depth: depth, timeout: 20, ...(format ? { format } : {}), ...(query !== undefined ? { query } : {}), ...(chunksPerSource !== undefined ? { chunks_per_source: chunksPerSource } : {}) };
    return { endpoint: 'extract', body };
  }
  return { endpoint: 'usage' };
}
