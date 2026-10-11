import test from 'node:test';
import assert from 'node:assert/strict';
import { Hindsight } from '../dist/hindsight.js';
import { configureLogging, flushLogs } from '../dist/log.js';

function mockStore() {
  const records = [];
  return {
    records,
    beginTool(_session, name) { const id = `${name}-${records.length}`; records.push({ id, name, status: 'pending' }); return id; },
    finishTool(id, status, result) { Object.assign(records.find(row => row.id === id), { status, result }); },
  };
}
const message = { id: 'm', sessionId: 's', role: 'user', content: 'hello', createdAt: new Date().toISOString(), source: {} };
const ok = () => new Response('{}', { status: 200 });

for (const status of [400, 422]) test(`automatic recall HTTP ${status} is model-visible and audited without alarm`, async () => {
  const store = mockStore(); let alarms = 0; const oldError = console.error; const oldFetch = globalThis.fetch;
  configureLogging({ discord: { errorWebhookUrl: 'https://discord.com/api/webhooks/1/fake' } });
  globalThis.fetch = async () => { alarms++; return new Response(null, { status: 204 }); };
  try {
    const hindsight = new Hindsight({ baseUrl: 'http://memory.invalid', bankId: 'bank' }, async url => url.endsWith('/config') ? ok() : new Response('not logged or exposed', { status }));
    const block = await hindsight.prepare(store, 's', message);
    assert.match(block, /Recall status: unavailable/);
    assert.match(block, status === 400 ? /too long/ : /failed validation/);
    await flushLogs();
    assert.equal(alarms, 0);
    const audit = store.records.find(row => row.name === 'hindsight_recall');
    assert.equal(audit.status, 'failed');
    assert.match(audit.result.reason, /no memories were retrieved/);
    assert.equal(JSON.stringify(audit).includes('not logged or exposed'), false);
  } finally { console.error = oldError; globalThis.fetch = oldFetch; configureLogging({}); }
});

test('automatic recall HTTP 500 and network failures warn without alert and retain failed audit', async () => {
  for (const fetcher of [async url => url.endsWith('/config') ? ok() : new Response('', { status: 500 }), async url => { if (url.endsWith('/config')) return ok(); throw new Error('network unavailable'); }]) {
    const store = mockStore(); let alerts = 0; const oldError = console.error; const oldFetch = globalThis.fetch;
    configureLogging({ discord: { errorWebhookUrl: 'https://discord.com/api/webhooks/1/fake' } });
    globalThis.fetch = async () => { alerts++; return new Response(null, { status: 204 }); };
    try {
      const hindsight = new Hindsight({ baseUrl: 'http://memory.invalid', bankId: 'bank' }, fetcher);
      const block = await hindsight.prepare(store, 's', message);
      assert.match(block, /Recall status: unavailable/);
      await flushLogs();
      assert.equal(alerts, 0);
      assert.equal(store.records.find(row => row.name === 'hindsight_recall').status, 'failed');
    } finally { console.error = oldError; globalThis.fetch = oldFetch; configureLogging({}); }
  }
});
