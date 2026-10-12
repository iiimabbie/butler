import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebToolRuntime, webDefinitions } from '../dist/web-tools.js';
const OUTPUT_LIMIT_FOR_TEST = 64 * 1024;

function fakeRuntime(handler) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(await handler(requests.at(-1))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { runtime: createWebToolRuntime({ apiKey: 'test-key', fetcher }), requests };
}

test('web registry exposes tools only with an API key', () => {
  assert.deepEqual(createWebToolRuntime().definitions, []);
  assert.deepEqual(webDefinitions.map(tool => tool.name), ['web_search', 'web_fetch', 'web_extract', 'web_map', 'web_usage']);
});

test('search preserves basic defaults and accepts official filters', async () => {
  const { runtime, requests } = fakeRuntime(() => ({ results: [{ title: 'T', url: 'https://example.test', content: 'C', score: 0.9 }] }));
  await runtime.execute('web_search', { query: 'hello', max_results: 4 });
  assert.deepEqual(requests[0].body, { query: 'hello', max_results: 4, search_depth: 'basic', auto_parameters: false, include_answer: false, include_raw_content: false });
  await runtime.execute('web_search', { query: 'news', search_depth: 'advanced', topic: 'news', time_range: 'week', include_domains: ['example.com'], include_domains_mode: 'prefer' });
  assert.equal(requests[1].body.search_depth, 'advanced');
  assert.deepEqual(requests[1].body.include_domains, ['example.com']);
  assert.equal(requests[1].body.include_domains_mode, 'prefer');
  await assert.rejects(runtime.execute('web_search', { query: 'bad', include_domains_mode: 'prefer' }), /requires a non-empty include_domains/);
  await assert.rejects(runtime.execute('web_search', { query: 'bad', topic: 'news', country: 'canada' }), /country is only supported/);
  await assert.rejects(runtime.execute('web_search', { query: 'bad', start_date: '2025-02-30' }), /valid YYYY-MM-DD/);
  await assert.rejects(runtime.execute('web_search', { query: 'bad', start_date: '2025-02-02', end_date: '2025-02-01' }), /on or before/);
});

test('legacy web_fetch retains basic single-URL extraction contract', async () => {
  const { runtime, requests } = fakeRuntime(() => ({ results: [{ url: 'https://example.test', raw_content: 'page text' }], failed_results: [] }));
  const result = await runtime.execute('web_fetch', { url: 'https://example.test' });
  assert.equal(requests[0].url, 'https://api.tavily.com/extract');
  assert.deepEqual(requests[0].body, { urls: ['https://example.test'], extract_depth: 'basic', timeout: 20 });
  assert.deepEqual(result, { url: 'https://example.test', content: 'page text', truncated: false });
  for (const url of ['ftp://example.test/file', 'http://user:pass@example.test', 'not a URL']) {
    const before = requests.length;
    await assert.rejects(runtime.execute('web_fetch', { url }), /HTTP\(S\) URL without credentials/);
    assert.equal(requests.length, before, 'unsafe URL must be rejected before fetch');
  }
});

test('web_fetch exact single-URL extraction miss exposes a typed, actionable error', async () => {
  const url = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/git/trees/v8.0.23?recursive=1';
  const { runtime } = fakeRuntime(() => ({ results: [], failed_results: [{ url, error: ' Error fetching content ' }] }));
  await assert.rejects(runtime.execute('web_fetch', { url }), error => {
    assert.equal(error.name, 'WebFetchExtractionError');
    assert.equal(error.code, 'WEB_FETCH_EXTRACTION_FAILED');
    assert.ok(error.message.includes(url));
    assert.match(error.message, /Reason:  Error fetching content /);
    assert.match(error.message, /local_shell.*curl -fsSL.*local_read/);
    assert.match(error.message, /not executed automatically.*not guaranteed to succeed/);
    return true;
  });
});

test('web_fetch unknown or structurally inconsistent failure stays an ordinary error', async () => {
  for (const response of [
    { results: [], failed_results: [{ url: 'https://example.test', error: 'unavailable' }] },
    { results: [], failed_results: [{ url: 'https://other.test', error: 'Error fetching content' }] },
    { results: [{ url: 'https://example.test', raw_content: 'unexpected' }], failed_results: [{ url: 'https://example.test', error: 'Error fetching content' }] },
    { results: [], failed_results: [{ url: 'https://example.test', error: 'Error fetching content' }, { url: 'https://example.test', error: 'Error fetching content' }] },
  ]) {
    const { runtime } = fakeRuntime(() => response);
    await assert.rejects(runtime.execute('web_fetch', { url: 'https://example.test' }), error => {
      assert.notEqual(error.name, 'WebFetchExtractionError');
      assert.match(error.message, /URL extraction failed/);
      return true;
    });
  }
});

test('batch extract preserves partial successes and reports truncation', async () => {
  const { runtime, requests } = fakeRuntime(() => ({ results: [{ url: 'https://example.test', raw_content: 'x'.repeat(70_000) }], failed_results: [{ url: 'https://bad.test', error: 'unavailable' }] }));
  const result = await runtime.execute('web_extract', { urls: ['https://example.test', 'https://bad.test'], format: 'text' });
  assert.equal(requests[0].url, 'https://api.tavily.com/extract');
  assert.equal(requests[0].body.format, 'text');
  assert.equal(requests[0].body.extract_depth, 'basic');
  assert.equal(result.results[0].truncated, true);
  assert.equal(result.failed_results[0].error, 'unavailable');
  await assert.rejects(runtime.execute('web_extract', { urls: ['http://user:pass@example.test'] }), /without credentials/);
  await assert.rejects(runtime.execute('web_extract', { urls: Array(21).fill('https://example.test') }), /1 to 20/);
});

test('web_extract query and chunks select relevant chunks without changing legacy behavior', async () => {
  const response = { results: [{ url: 'https://example.test', raw_content: 'relevant text' }], failed_results: [] };
  const { runtime, requests } = fakeRuntime(() => response);
  const definition = webDefinitions.find(tool => tool.name === 'web_extract');
  assert.ok(definition.parameters.properties.query);
  assert.deepEqual(definition.parameters.properties.chunks_per_source, { type: 'integer', minimum: 1, maximum: 5 });
  assert.match(definition.description, /Use query for a specific question/);
  assert.match(definition.description, /omit query to read the full content/);
  assert.match(definition.description, /chunks_per_source requires query/);

  const selected = await runtime.execute('web_extract', { urls: ['https://example.test'], query: 'answer this', chunks_per_source: 2 });
  assert.deepEqual(requests[0].body, { urls: ['https://example.test'], extract_depth: 'basic', timeout: 20, format: 'markdown', query: 'answer this', chunks_per_source: 2 });
  assert.equal(selected.content_scope, 'query_relevant_chunks');
  assert.match(selected.content_scope_description, /not the full source content/);
  assert.equal(selected.results[0].truncated, false, 'false only means local output cap did not truncate');

  await runtime.execute('web_extract', { urls: ['https://example.test'], query: 'answer this' });
  assert.deepEqual(requests[1].body, { urls: ['https://example.test'], extract_depth: 'basic', timeout: 20, format: 'markdown', query: 'answer this' }, 'Tavily default is not hard-coded into payload');
  const legacy = await runtime.execute('web_extract', { urls: ['https://example.test'] });
  assert.deepEqual(requests[2].body, { urls: ['https://example.test'], extract_depth: 'basic', timeout: 20, format: 'markdown' });
  assert.deepEqual(legacy, { result_count: 1, failed_count: 0, results: [{ url: 'https://example.test', content: 'relevant text', truncated: false }], failed_results: [], truncated: false });
});

test('web_extract rejects invalid query/chunks before HTTP; web_fetch rejects new args', async () => {
  const { runtime, requests } = fakeRuntime(() => ({ results: [], failed_results: [] }));
  const invalid = [
    [{ urls: ['https://example.test'], query: '   ' }, /query must be a non-empty string/],
    [{ urls: ['https://example.test'], query: 1 }, /query must be a non-empty string/],
    [{ urls: ['https://example.test'], chunks_per_source: 1 }, /requires query/],
    ...[0, 6, 1.5, '2'].map(chunks_per_source => [{ urls: ['https://example.test'], query: 'q', chunks_per_source }, /chunks_per_source must be an integer/]),
  ];
  for (const [args, expected] of invalid) await assert.rejects(runtime.execute('web_extract', args), expected);
  assert.equal(requests.length, 0);
  await assert.rejects(runtime.execute('web_fetch', { url: 'https://example.test', query: 'q' }), /Unknown web tool argument/);
  await assert.rejects(runtime.execute('web_fetch', { url: 'https://example.test', chunks_per_source: 1 }), /Unknown web tool argument/);
  assert.equal(requests.length, 0);
});

test('query-mode local output truncation remains distinct from content scope', async () => {
  const { runtime } = fakeRuntime(() => ({ results: [{ url: 'https://example.test', raw_content: 'x'.repeat(70_000) }], failed_results: [] }));
  const result = await runtime.execute('web_extract', { urls: ['https://example.test'], query: 'q' });
  assert.equal(result.content_scope, 'query_relevant_chunks');
  assert.equal(result.results[0].truncated, true);
  assert.match(result.content_scope_description, /not the full source content/);
});

test('map uses bounded defaults and usage calls read-only documented endpoint', async () => {
  const { runtime, requests } = fakeRuntime(request => request.url.endsWith('/map') ? ({ base_url: 'https://example.test', results: ['https://example.test/a'] }) : ({ key: { usage: 1, limit: 100 }, account: { current_plan: 'test' } }));
  await runtime.execute('web_map', { url: 'https://example.test' });
  assert.deepEqual(requests[0].body, { url: 'https://example.test', max_depth: 1, max_breadth: 5, limit: 10, allow_external: false, timeout: 30 });
  const usage = await runtime.execute('web_usage', {});
  assert.equal(requests[1].url, 'https://api.tavily.com/usage');
  assert.equal(requests[1].init.method, 'GET');
  assert.equal(usage.key.usage, 1);
  const oversized = fakeRuntime(() => ({ key: { usage: 1, detail: 'x'.repeat(OUTPUT_LIMIT_FOR_TEST) }, account: {} }));
  await assert.rejects(oversized.runtime.execute('web_usage', {}), /metadata exceeds 64 KiB output limit/);
});
