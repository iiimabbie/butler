import { ToolUsageError, WebFetchExtractionError } from './tool-errors.js';
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
  { type: 'function', name: 'web_extract', description: 'Extract content from 1–20 public HTTP(S) URLs in one request. Returns successes and per-URL failures; advanced extraction may cost more. Content may be truncated.', parameters: { type: 'object', properties: { urls: stringArray(20), extract_depth: { type: 'string', enum: EXTRACT_DEPTH, default: 'basic' }, format: { type: 'string', enum: FORMATS, default: 'markdown' } }, required: ['urls'], additionalProperties: false } },
  { type: 'function', name: 'web_map', description: 'Map a website to discover URLs only; this does not crawl or extract page contents. Mapping costs credits per successful pages; instructions raise the rate from 1 to 2 credits per 10 successful pages. Conservative defaults: depth 1, breadth 5, limit 10, external domains excluded.', parameters: { type: 'object', properties: { url: string, instructions: { type: 'string', minLength: 1, maxLength: 1000 }, max_depth: { type: 'integer', minimum: 1, maximum: 5, default: 1 }, max_breadth: { type: 'integer', minimum: 1, maximum: 20, default: 5 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }, select_paths: optionalArray(20), exclude_paths: optionalArray(20) }, required: ['url'], additionalProperties: false } },
  { type: 'function', name: 'web_usage', description: 'Read-only Tavily API key and account usage for the current billing cycle.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
];

export type WebToolRuntime = { definitions: typeof webDefinitions; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
export function createWebToolRuntime(config: { provider?: 'tavily'; baseUrl?: string; apiKey?: string; fetcher?: typeof fetch } = {}): WebToolRuntime {
  const apiKey = config.apiKey?.trim();
  const fetcher = config.fetcher ?? fetch;
  const baseUrl = (config.baseUrl?.trim() || 'https://api.tavily.com').replace(/\/+$/, '');
  return {
    definitions: apiKey ? webDefinitions : [],
    async execute(name, args) {
      if (!apiKey) throw new Error('Web API key is not configured');
      if (config.provider !== undefined && config.provider !== 'tavily') throw new Error('Unsupported web provider');
      const allowedByName: Record<string, string[]> = {
        web_search: ['query','max_results','search_depth','topic','include_domains','exclude_domains','include_domains_mode','time_range','start_date','end_date','country'],
        web_fetch: ['url'], web_extract: ['urls','extract_depth','format'],
        web_map: ['url','instructions','max_depth','max_breadth','limit','select_paths','exclude_paths'], web_usage: [],
      };
      const allowed = allowedByName[name];
      if (!allowed) throw new Error('Unknown web tool');
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new ToolUsageError('Unknown web tool argument');
      const redact = (value: string) => value.replaceAll(apiKey, '[redacted]');
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
        const response = await request('search', body, apiKey, fetcher, baseUrl);
        if (!Array.isArray(response.results) || response.results.length > maxResults) throw new Error('Tavily search: invalid response');
        const results = response.results.map(item => {
          if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.content !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score)) throw new Error('Tavily search: invalid response');
          return { title: redact(item.title), url: redact(item.url), content: redact(item.content), score: item.score, truncated: false };
        });
        return boundedOutput({ query: redact(query), result_count: results.length, results, truncated: false }, results);
      }
      if (name === 'web_fetch' || name === 'web_extract') {
        const urls = name === 'web_fetch' ? [validUrl(args.url)] : validateUrls(args.urls);
        const depth = name === 'web_fetch' ? 'basic' : oneOf(args.extract_depth, 'basic', EXTRACT_DEPTH, 'extract_depth');
        const format = name === 'web_extract' ? oneOf(args.format, 'markdown', FORMATS, 'format') : undefined;
        const response = await request('extract', { urls, extract_depth: depth, timeout: 20, ...(format ? { format } : {}) }, apiKey, fetcher, baseUrl);
        if (!Array.isArray(response.failed_results) || !Array.isArray(response.results)) throw new Error('Tavily extract: invalid response');
        const failed = response.failed_results.map(item => {
          if (!isRecord(item) || typeof item.url !== 'string' || typeof item.error !== 'string') throw new Error('Tavily extract: invalid response');
          return { url: item.url, error: item.error };
        });
        const results = response.results.map(item => {
          if (!isRecord(item) || typeof item.url !== 'string' || typeof item.raw_content !== 'string') throw new Error('Tavily extract: invalid response');
          return { url: redact(item.url), content: redact(item.raw_content), truncated: false };
        });
        if (name === 'web_fetch') {
          if (failed.length) {
            const requestedUrl = urls[0]!;
            const failure = failed[0];
            const isKnownSinglePageFailure = failed.length === 1
              && results.length === 0
              && failure?.url === requestedUrl
              && failure.error.trim() === 'Error fetching content';
            if (isKnownSinglePageFailure) throw new WebFetchExtractionError(redact(requestedUrl), redact(failure.error));
            const details = failed.map(item => `${redact(item.url)}: ${redact(item.error)}`).join('; ');
            throw new Error(`Tavily extract: URL extraction failed${details ? ` (${details})` : ''}`);
          }
          if (results.length !== 1) throw new Error('Tavily extract: invalid response');
          return boundedOutput(results[0]!, [results[0]!]);
        }
        const safeFailed = failed.map(item => ({ url: redact(item.url), error: redact(item.error) }));
        const result = { result_count: results.length, failed_count: safeFailed.length, results, failed_results: safeFailed, truncated: false };
        return boundedOutput(result, results);
      }
      if (name === 'web_map') {
        const url = validUrl(args.url);
        const mapBody: Record<string, unknown> = { url, max_depth: integer(args.max_depth, 1, 1, 5, 'max_depth'), max_breadth: integer(args.max_breadth, 5, 1, 20, 'max_breadth'), limit: integer(args.limit, 10, 1, 20, 'limit'), allow_external: false, timeout: 30 };
        if (args.instructions !== undefined) mapBody.instructions = boundedString(args.instructions, 'instructions', 1000);
        if (args.select_paths !== undefined) mapBody.select_paths = stringList(args.select_paths, 20, 'select_paths');
        if (args.exclude_paths !== undefined) mapBody.exclude_paths = stringList(args.exclude_paths, 20, 'exclude_paths');
        const response = await request('map', mapBody, apiKey, fetcher, baseUrl);
        if (typeof response.base_url !== 'string' || !Array.isArray(response.results) || response.results.some(item => typeof item !== 'string')) throw new Error('Tavily map: invalid response');
        const mapped = response.results.map(item => redact(item as string));
        return boundedOutput({ base_url: redact(response.base_url), result_count: mapped.length, results: mapped, truncated: false }, []);
      }
      const response = await request('usage', undefined, apiKey, fetcher, baseUrl);
      if (!isRecord(response.key) || !isRecord(response.account)) throw new Error('Tavily usage: invalid response');
      return boundedUsageOutput(redactDeep(response, apiKey));
    },
  };
}

async function request(endpoint: 'search' | 'extract' | 'map' | 'usage', body: Record<string, unknown> | undefined, apiKey: string, fetcher: typeof fetch, baseUrl: string): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(endpoint === 'map' ? 35_000 : 30_000);
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/${endpoint}`, {
      method: endpoint === 'usage' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: 'error',
    });
  } catch {
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
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new Error('response exceeds 5 MiB limit');
      }
      chunks.push(value);
    }
  } catch {
    throw new Error(`Tavily ${endpoint}: ${signal.aborted ? 'request timed out' : length > RESPONSE_LIMIT ? 'response exceeds 5 MiB limit' : 'response read failed'}`);
  } finally {
    reader.releaseLock();
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
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
function boundedString(value: unknown, name: string, max: number): string {
  const result = requiredString(value, name);
  if (result.length > max) throw new ToolUsageError(`${name} must be at most ${max} characters`);
  return result;
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
