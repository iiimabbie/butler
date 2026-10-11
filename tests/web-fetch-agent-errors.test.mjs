import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCall } from '../dist/agent.js';
import { configureErrorLogging, flushErrorLogs } from '../dist/error-log.js';
import { WebFetchExtractionError } from '../dist/tool-errors.js';

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
  configureErrorLogging({ discord: { errorWebhookUrl: 'https://discord.com/api/webhooks/123/test-token' } });
  try {
    return await run(requests);
  } finally {
    await flushErrorLogs();
    globalThis.fetch = originalFetch;
    configureErrorLogging({});
  }
}

function toolCall() {
  return { call_id: 'call-1', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test/page' }) };
}

test('known web_fetch extraction failure suppresses webhook but remains failed and actionable for model', async () => {
  await withMockWebhook(async requests => {
    const store = fakeStore();
    const result = await executeCall(store, 'session-known', toolCall(), {
      webTools: { execute: async () => { throw new WebFetchExtractionError('https://example.test/page', 'Error fetching content'); } },
    });
    assert.equal(requests.length, 0);
    assert.equal(store.finished[0].status, 'failed');
    assert.equal(store.finished[0].result.error, result.error);
    assert.match(result.error, /https:\/\/example\.test\/page/);
    assert.match(result.error, /Error fetching content/);
    assert.match(result.error, /curl -fsSL.*local_read/);
    assert.match(result.error, /not executed automatically.*not guaranteed to succeed/);
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
    await flushErrorLogs();
    assert.equal(requests.length, errors.length);
  });
});
