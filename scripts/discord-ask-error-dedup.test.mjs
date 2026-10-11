import test from 'node:test';
import assert from 'node:assert/strict';
import { discordAskDeduplicationKey } from '../dist/discord.js';
import { configureLogging, flushLogs, logError } from '../dist/log.js';

const config = { discord: { errorWebhookUrl: 'https://discord.com/api/webhooks/1/fake' } };
const rejected = () => Object.assign(new Error('request rejected'), { name: 'AttachmentInputError', cause: new Error('LLM HTTP 400: unsupported MIME type audio/mpeg3') });

async function withNotifier(testBody) {
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  const oldError = console.error;
  let now = 1_000_000;
  let sends = 0;
  const logged = [];
  Date.now = () => now;
  globalThis.fetch = async () => { sends++; return new Response(null, { status: 204 }); };
  console.error = line => logged.push(String(line));
  configureLogging(config);
  try { await testBody({ advance: ms => { now += ms; }, get sends() { return sends; }, logged }); }
  finally {
    await flushLogs();
    configureLogging({});
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    console.error = oldError;
  }
}

function askFailure(channelId, messageId, failureKind, error = rejected()) {
  const context = `Discord message ask failed${failureKind} channel=${channelId} message=${messageId}`;
  logError(context, error, { deduplicationKey: discordAskDeduplicationKey(channelId, failureKind) });
  return context;
}

test('Discord ask notifications deduplicate same channel/class/identity but preserve each full log context', async () => {
  await withNotifier(async state => {
    const first = askFailure('chan-a', 'msg-1', ' (request_rejected HTTP 400)');
    const duplicate = askFailure('chan-a', 'msg-2', ' (request_rejected HTTP 400)');
    assert.notEqual(first, duplicate);
    assert.equal(discordAskDeduplicationKey('chan-a', ' (request_rejected HTTP 400)'), discordAskDeduplicationKey('chan-a', ' (request_rejected HTTP 400)'));
    await flushLogs();
    assert.equal(state.sends, 1);
    assert.ok(state.logged.some(line => line.includes('message=msg-1')));
    assert.ok(state.logged.some(line => line.includes('message=msg-2')));
  });
});

test('Discord ask dedup key distinguishes channel, failure classification, and error identity', async () => {
  await withNotifier(async state => {
    askFailure('chan-distinct-a', 'msg-1', ' (request_rejected HTTP 400)');
    askFailure('chan-distinct-b', 'msg-2', ' (request_rejected HTTP 400)');
    askFailure('chan-distinct-a', 'msg-3', ' (request_rejected HTTP 422)');
    askFailure('chan-distinct-a', 'msg-4', ' (request_rejected HTTP 400)', Object.assign(new Error('different rejection'), { name: 'AttachmentInputError' }));
    await flushLogs();
    assert.equal(state.sends, 4);
  });
});

test('Discord ask dedup suppresses at 299999ms and permits notification at 300000ms', async () => {
  await withNotifier(async state => {
    askFailure('chan-boundary', 'msg-1', ' (request_rejected HTTP 400)');
    await flushLogs();
    assert.equal(state.sends, 1);
    state.advance(299_999);
    askFailure('chan-boundary', 'msg-2', ' (request_rejected HTTP 400)');
    await flushLogs();
    assert.equal(state.sends, 1);
    state.advance(1);
    askFailure('chan-boundary', 'msg-3', ' (request_rejected HTTP 400)');
    await flushLogs();
    assert.equal(state.sends, 2);
  });
});
