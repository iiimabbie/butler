import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordToolRuntime } from '../dist/discord-tools.js';
const token = 'secret-test-token';
function runtime(fetcher) { return createDiscordToolRuntime({ token, context: { channelId: '123', attachmentFiles: [] }, fetcher }); }
const get = r => r.execute('discord_fetch_channel', { channelId: '123' });
const post = r => r.execute('discord_send_message', { channelId: '123', content: 'private outgoing content' });
async function failure(action) { try { await action(); assert.fail('expected failure'); } catch (e) { return e.message; } }
test('GET 404 retains Discord code/message and has no mutation ambiguity', async () => {
  const msg = await failure(() => get(runtime(async () => Response.json({ code: 10003, message: 'Unknown Channel' }, { status: 404 }))));
  assert.match(msg, /method=GET path=\/channels\/123 status=404 code=10003 message="Unknown Channel"/);
  assert.match(msg, /no mutation was requested/); assert.doesNotMatch(msg, /outcome.*unknown/);
});
test('403 preserves actual permission diagnostic without inferring deletion', async () => {
  const msg = await failure(() => get(runtime(async () => Response.json({ code: 50001, message: 'Missing Access' }, { status: 403 }))));
  assert.match(msg, /code=50001 message="Missing Access"/);
});
test('malformed error JSON keeps HTTP status', async () => {
  const msg = await failure(() => get(runtime(async () => new Response('<html>bad</html>', { status: 502 }))));
  assert.match(msg, /status=502/); assert.match(msg, /could not be read as JSON/); assert.doesNotMatch(msg, /<html>/);
});
test('redacts token/URLs, strips controls, bounds message and excludes other fields', async () => {
  const msg = await failure(() => get(runtime(async () => Response.json({ code: 10003, message: `${token}\nhttps://discord.com/api/webhooks/secret ${'x'.repeat(2000)}`, extra: 'private-response-data' }, { status: 404 }))));
  assert.doesNotMatch(msg, /secret-test-token|https:|private-response-data|\n/); assert.match(msg, /redacted/); assert.ok(msg.length < 800);
});
test('GET transport failure does not imply write occurred and never retries', async () => {
  let calls = 0; const msg = await failure(() => get(runtime(async () => { calls++; throw new Error(token); })));
  assert.equal(calls, 1); assert.match(msg, /stage=transport/); assert.match(msg, /no mutation/); assert.doesNotMatch(msg, /secret-test-token|outcome is unknown/);
});
test('POST transport failure keeps unknown outcome, omits sent body and never retries', async () => {
  let calls = 0; const msg = await failure(() => post(runtime(async () => { calls++; throw new Error(token); })));
  assert.equal(calls, 1); assert.match(msg, /outcome is unknown; do not retry/); assert.doesNotMatch(msg, /private outgoing content|secret-test-token/);
});
test('write 4xx rejected; write 5xx still uncertain', async () => {
  for (const status of [403, 408, 500]) {
    const msg = await failure(() => post(runtime(async () => Response.json({ message: 'failure' }, { status }))));
    assert.match(msg, status === 403 ? /request rejected/ : /outcome may be unknown/);
  }
});
test('successful GET remains unchanged', async () => {
  const result = await get(runtime(async () => Response.json({ id: '123', name: 'test', type: 0 })));
  assert.equal(result.id, '123'); assert.equal(result.name, 'test');
});
