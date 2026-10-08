import test from 'node:test';
import assert from 'node:assert/strict';
import { Hindsight } from '../dist/hindsight.js';

const base = { baseUrl: 'http://memory.invalid', bankId: 'test-bank' };
function client(config = {}) {
  const requests = [];
  const memory = new Hindsight({ ...base, ...config }, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(String(url).endsWith('/reflect') ? { text: 'summary', based_on: null } : { results: [] }), { status: 200 });
  });
  return { memory, requests };
}

test('recall and reflect delegate budgets and tokens to Hindsight', async () => {
  for (const config of [{}, { recallBudget: 'high', reflectBudget: 'high', maxTokens: 9999 }]) {
    const { memory, requests } = client(config);
    await memory.recall('question'); await memory.reflect('question');
    assert.deepEqual(requests[0].body, { query: 'question' });
    assert.deepEqual(requests[1].body, { query: 'question', include: { facts: {} } });
  }
});
test('automatic prepare does not claim or send client-owned budgets', async () => {
  const { memory, requests } = client(); memory.ensureBank = async () => {};
  const audits = [];
  const store = { beginTool(_session, _name, args) { audits.push(args); return 'audit'; }, finishTool() {} };
  await memory.prepare(store, 'session', { id: 'msg', sessionId: 'session', role: 'user', content: 'question', createdAt: '2026-10-08T00:00:00Z', source: { authorId: '123' } });
  for (const body of [audits[0], requests[0].body]) {
    assert.equal(Object.hasOwn(body, 'budget'), false);
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  }
});
