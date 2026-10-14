import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCall } from '../dist/agent.js';
import { configureLogging, flushLogs } from '../dist/log.js';
import { WebFetchExtractionError } from '../dist/tool-errors.js';
import { LocalToolRuntime } from '../dist/local-tools.js';

function fakeStore() {
  const finished = [];
  return {
    finished,
    beginTool: () => `tool-${finished.length + 1}`,
    finishTool: (id, status, result) => finished.push({ id, status, result }),
  };
}

async function withMockWebhook(run) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  configureLogging({ discord: { errorWebhookUrl: 'https://discord.com/api/webhooks/123/test-token' } });
  try {
    return await run(requests);
  } finally {
    await flushLogs();
    globalThis.fetch = originalFetch;
    configureLogging({});
  }
}

function toolCall() {
  return { call_id: 'call-1', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test/page' }) };
}

test('unknown local tool remains an audited usage error without an error notification', async () => {
  await withMockWebhook(async requests => {
    const store = fakeStore();
    const localTools = new LocalToolRuntime('/tmp');
    const result = await executeCall(store, 'session-local', { call_id: 'local-call', name: 'local_unknown', arguments: '{"path":"unused"}' }, { localTools });
    assert.equal(result.error, 'Unknown local tool: local_unknown');
    assert.equal(store.finished[0].status, 'failed');
    assert.equal(requests.length, 0);
    await localTools.close();
  });
});

test('unavailable tool request is audited without error notification or duplicate subagent entry log', async () => {
  await withMockWebhook(async requests => {
    const store = fakeStore();
    const info = [];
    const originalInfo = console.info;
    console.info = (...args) => info.push(args.join(' '));
    try {
      const result = await executeCall(store, 'session-child', { call_id: 'child-call', name: 'web_search', arguments: '{"query":"test"}' }, {}, undefined, 'subagent');
      await flushLogs();
      assert.equal(result.error, 'Web tools are unavailable in this entry point');
      assert.equal(store.finished[0].status, 'failed');
      assert.equal(requests.length, 0, 'ToolUsageError must not notify the webhook');
      assert.equal(info.filter(line => line.includes('tool_call')).length, 0, 'subagent tool entry is logged by the parent dispatcher only once');
    } finally { console.info = originalInfo; }
  });
});

test('web_fetch extraction failures suppress webhook but remain locally logged, failed, and actionable for model', async () => {
  await withMockWebhook(async requests => {
    const errors = [
      new WebFetchExtractionError('https://example.test/timeout', 'Request timed out', 'Tavily extract: URL extraction failed (https://example.test/timeout: Request timed out)'),
      new WebFetchExtractionError('https://example.test/not-found', '404 page not found', 'Tavily extract: URL extraction failed (https://example.test/not-found: 404 page not found)'),
      new WebFetchExtractionError('https://example.test/fetch', 'Failed to fetch url', 'Tavily extract: URL extraction failed (https://example.test/fetch: Failed to fetch url)'),
      new WebFetchExtractionError('https://example.test/known', 'Error fetching content'),
    ];
    const originalError = console.error;
    const localLogs = [];
    console.error = (...args) => localLogs.push(args.join(' '));
    try {
      for (const [index, extractionError] of errors.entries()) {
        const store = fakeStore();
        const result = await executeCall(store, `session-fetch-${index}`, toolCall(), {
          webTools: { execute: async () => { throw extractionError; } },
        });
        assert.equal(store.finished[0].status, 'failed');
        assert.equal(store.finished[0].result.error, result.error);
        assert.match(result.error, /https:\/\/example\.test/);
        if (index === errors.length - 1) {
          assert.match(result.error, /curl -fsSL.*local_read/);
          assert.match(result.error, /not executed automatically.*not guaranteed to succeed/);
        }
      }
      assert.equal(requests.length, 0);
      assert.equal(localLogs.length, errors.length, 'each extraction error is still written to local error logging');
      assert.match(localLogs[0], /Request timed out/);
    } finally { console.error = originalError; }
  });
});

test('unknown extraction reason and operational failures still notify', async () => {
  await withMockWebhook(async requests => {
    const errors = [
      new Error('Tavily extract: URL extraction failed (https://example.test/page: unavailable)'),
      new Error('Tavily extract: HTTP 500'),
      new Error('Tavily extract: HTTP 401 authentication failed'),
      new Error('Tavily extract: request timed out'),
    ];
    for (let index = 0; index < errors.length; index++) {
      const store = fakeStore();
      const result = await executeCall(store, `session-other-${index}`, toolCall(), {
        webTools: { execute: async () => { throw errors[index]; } },
      });
      assert.equal(store.finished[0].status, 'failed');
      assert.equal(store.finished[0].result.error, result.error);
    }
    await flushLogs();
    assert.equal(requests.length, errors.length);
  });
});
