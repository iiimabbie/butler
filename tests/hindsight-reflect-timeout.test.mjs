import test from 'node:test';
import assert from 'node:assert/strict';
import { Hindsight } from '../dist/hindsight.js';

const reflectResponse = () => new Response(JSON.stringify({ text: 'ok', based_on: null }), { status: 200 });
const recallResponse = () => new Response(JSON.stringify({ results: [] }), { status: 200 });

test('reflect uses a 60s deadline while recall retains configured timeout', async () => {
  const original = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = ms => { timeouts.push(ms); return new AbortController().signal; };
  try {
    const hindsight = new Hindsight({ baseUrl: 'http://hindsight.test', bankId: 'bank', timeoutMs: 30_000 }, async url =>
      String(url).endsWith('/reflect') ? reflectResponse() : recallResponse());
    await hindsight.reflect('local mock query');
    await hindsight.recall('local mock query');
    assert.deepEqual(timeouts, [60_000, 30_000]);
  } finally { AbortSignal.timeout = original; }
});

test('reflect timeout is one client request and does not claim server cancellation', async () => {
  const original = AbortSignal.timeout;
  let timeoutMs;
  let calls = 0;
  AbortSignal.timeout = ms => { timeoutMs = ms; return new AbortController().signal; };
  try {
    const hindsight = new Hindsight({ baseUrl: 'http://hindsight.test', bankId: 'bank', timeoutMs: 30_000 }, async (_url, init) => {
      calls++;
      assert.ok(init.signal instanceof AbortSignal);
      throw new Error('mock timeout');
    });
    await assert.rejects(hindsight.reflect('local mock query'), /mock timeout/);
    assert.equal(timeoutMs, 60_000);
    assert.equal(calls, 1);
  } finally { AbortSignal.timeout = original; }
});
