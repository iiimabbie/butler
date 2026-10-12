import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCall } from '../dist/agent.js';
import { configureLogging, flushLogs } from '../dist/log.js';
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
    await flushLogs();
    assert.equal(requests.length, errors.length);
  });
});
