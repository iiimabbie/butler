import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../dist/model-request.js';
const base = { url: 'http://private/responses', headers: { authorization: 'secret' }, body: 'private prompt', session: 'test', model: 'test-model', turn: 1, timeoutMs: 1000 };
test('successful request records metadata, not private payloads', async () => {
  const events = [];
  const result = await requestModel({ ...base, emit: e => events.push(e), fetcher: async () => new Response('{"output":[]}', { headers: { 'x-request-id': 'upstream-id' } }) });
  assert.deepEqual(result.raw, { output: [] });
  assert.deepEqual(events.map(e => e.event), ['start', 'complete']);
  assert.equal(events[1].upstreamRequestId, 'upstream-id');
  assert.equal(events[1].validJson, true);
  assert.ok(!JSON.stringify(events).includes('private'));
  assert.ok(!JSON.stringify(events).includes('secret'));
});
test('header timeout preserves error and records stage', async () => {
  const events = [];
  await assert.rejects(requestModel({ ...base, timeoutMs: 10, emit: e => events.push(e), fetcher: async (_, { signal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('test guard')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) }), { name: 'TimeoutError' });
  assert.equal(events.at(-1).stage, 'headers');
  assert.equal(events.at(-1).timedOut, true);
});
test('body timeout is not swallowed as invalid JSON', async () => {
  const events = [];
  await assert.rejects(requestModel({ ...base, timeoutMs: 10, emit: e => events.push(e), fetcher: async (_, { signal }) => {
    let timer;
    return new Response(new ReadableStream({ start(controller) {
      timer = setTimeout(() => controller.error(new Error('test guard')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(signal.reason); }, { once: true });
    } }));
  } }), { name: 'TimeoutError' });
  assert.equal(events.at(-1).stage, 'body');
  assert.equal(events.at(-1).status, 200);
});
test('HTTP errors remain available to existing caller policy', async () => {
  const events = [];
  const result = await requestModel({ ...base, emit: e => events.push(e), fetcher: async () => new Response('{"error":"busy"}', { status: 503 }) });
  assert.equal(result.response.status, 503);
  assert.equal(events.at(-1).status, 503);
});
test('invalid JSON remains null with explicit diagnostic', async () => {
  const events = [];
  const result = await requestModel({ ...base, emit: e => events.push(e), fetcher: async () => new Response('invalid') });
  assert.equal(result.raw, null);
  assert.equal(events.at(-1).validJson, false);
});
test('network failure is distinguished from timeout and never retried', async () => {
  const events = []; let calls = 0;
  const error = new TypeError('connection failed');
  await assert.rejects(requestModel({ ...base, emit: e => events.push(e), fetcher: async () => { calls++; throw error; } }), e => e === error);
  assert.equal(calls, 1);
  assert.equal(events.at(-1).timedOut, false);
  assert.equal(events.at(-1).errorType, 'TypeError');
});
