import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { ask } from '../dist/agent.js';
import { createDiscordToolRuntime, discordMessageTools } from '../dist/discord-tools.js';

const tdir = () => mkdtempSync(join(tmpdir(), 'butler-discord-tools-'));
const toolCall = (name, args) => ({ type: 'function_call', name, call_id: 'discord-call', arguments: JSON.stringify(args) });

test('declares exactly eight Discord tools with strict schemas', () => {
  assert.deepEqual(discordMessageTools.map(tool => tool.name), [
    'discord_send_message', 'discord_fetch_message', 'discord_fetch_channel_messages', 'discord_edit_message',
    'discord_delete_message', 'discord_react', 'discord_pin', 'discord_unpin',
  ]);
  for (const tool of discordMessageTools) assert.equal(tool.parameters.additionalProperties, false);
});

test('Discord runtime enforces allowlist and validates before REST', async () => {
  let requests = 0;
  const runtime = createDiscordToolRuntime({ token: 'never-record-token', channelIds: ['123456'], context: { channelId: '123456' }, fetcher: async () => { requests++; return new Response('{}'); } });
  await assert.rejects(runtime.execute('discord_send_message', { channelId: '999999', content: 'hello' }), /not allowlisted/);
  await assert.rejects(runtime.execute('discord_send_message', { channelId: '123456', content: 'x'.repeat(2001) }), /content is invalid/);
  await assert.rejects(runtime.execute('discord_send_message', { channelId: '123456', content: 'ok', extra: true }), /Unexpected argument/);
  assert.equal(requests, 0);
});

test('Discord REST routes preserve raw fetches, paginate and encode Unicode emoji', async () => {
  const calls = [];
  const raw = { id: '333333', channel_id: '123456', content: 'unmodified', author: { id: '444444', username: 'someone' }, attachments: [{ id: 'a' }] };
  const runtime = createDiscordToolRuntime({ token: 'secret', channelIds: ['123456'], context: { channelId: '123456' }, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET' && url.endsWith('/messages/333333')) return Response.json(raw);
    if (init.method === 'GET') return Response.json([raw]);
    if (init.method === 'POST') return Response.json(raw);
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(await runtime.execute('discord_fetch_message', { channelId: '123456', messageId: '333333' }), raw);
  const page = await runtime.execute('discord_fetch_channel_messages', { channelId: '123456', before: '444444' });
  assert.equal(page.messages[0].content, 'unmodified');
  assert.equal(page.next_before, null);
  assert.match(calls[1].url, /before=444444/);
  const sent = await runtime.execute('discord_send_message', { channelId: '123456', content: '@everyone hi' });
  assert.equal(sent.messageId, '333333');
  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].init.body), { content: '@everyone hi', allowed_mentions: { parse: [] } });
  await runtime.execute('discord_edit_message', { channelId: '123456', messageId: '333333', content: 'edited' });
  assert.equal(calls[3].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[3].init.body), { content: 'edited', allowed_mentions: { parse: [] } });
  await runtime.execute('discord_delete_message', { channelId: '123456', messageId: '333333' });
  assert.equal(calls[4].init.method, 'DELETE');
  await runtime.execute('discord_react', { channelId: '123456', messageId: '333333', emoji: '🧪' });
  assert.match(calls[5].url, /%F0%9F%A7%AA/);
  assert.equal(calls[5].init.method, 'PUT');
  await runtime.execute('discord_pin', { channelId: '123456', messageId: '333333' });
  assert.equal(calls[6].init.method, 'PUT');
  assert.equal(calls[6].url, 'https://discord.com/api/v10/channels/123456/messages/pins/333333');
  await runtime.execute('discord_unpin', { channelId: '123456', messageId: '333333' });
  assert.equal(calls[7].init.method, 'DELETE');
  assert.equal(calls[7].url, 'https://discord.com/api/v10/channels/123456/messages/pins/333333');
  assert.ok(calls.every(call => call.init.headers.authorization === 'Bot secret'));
});

test('async agent loop exposes Discord tools only when configured and persists original tool result', async () => {
  const dir = tdir();
  const store = new Store(join(dir, 'history.sqlite'));
  const session = store.newSession();
  const restRaw = { id: '333333', channel_id: '123456', content: 'original', author: { id: '444444' } };
  const discordTools = createDiscordToolRuntime({ token: 'secret', channelIds: ['123456'], context: { channelId: '123456', messageId: '555555' }, fetcher: async () => Response.json(restRaw) });
  let turn = 0;
  const fetcher = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.ok(request.tools.some(tool => tool.name === 'discord_fetch_message'));
    if (turn++ === 0) {
      assert.ok(request.input.some(item => item.role === 'developer' && item.content.includes('messageId=555555')));
      return Response.json({ output: [toolCall('discord_fetch_message', { channelId: '123456', messageId: '333333' })] });
    }
    const output = request.input.find(item => item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(output.output).content, 'original');
    return Response.json({ output: [], output_text: 'done' });
  };
  assert.equal(await ask(store, session, 'read this', { baseUrl: 'http://fake/v1', model: 'test', fetcher, discordTools }), 'done');
  const record = store.history(session)[0];
  assert.equal(record.name, 'discord_fetch_message');
  assert.equal(record.status, 'completed');
  assert.deepEqual(JSON.parse(record.result), restRaw);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Discord HTTP failures expose status only and do not retry', async () => {
  for (const status of [403, 404, 429, 500]) {
    let requests = 0;
    const runtime = createDiscordToolRuntime({ token: 'sensitive-token', channelIds: ['123456'], context: { channelId: '123456' }, fetcher: async () => { requests++; return new Response('sensitive-token must not leak', { status }); } });
    await assert.rejects(runtime.execute('discord_delete_message', { channelId: '123456', messageId: '333333' }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /sensitive-token/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('non-idempotent send failure is recorded and never automatically retried', async () => {
  const dir = tdir();
  const store = new Store(join(dir, 'history.sqlite'));
  const session = store.newSession();
  let sends = 0;
  const discordTools = createDiscordToolRuntime({ token: 'secret', channelIds: ['123456'], context: { channelId: '123456' }, fetcher: async () => { sends++; throw new Error('network gone'); } });
  let turns = 0;
  const fetcher = async (_url, init) => {
    turns++;
    if (turns === 1) return Response.json({ output: [toolCall('discord_send_message', { channelId: '123456', content: 'once' })] });
    return Response.json({ output: [], output_text: 'failed safely' });
  };
  assert.equal(await ask(store, session, 'send once', { baseUrl: 'http://fake/v1', model: 'test', fetcher, discordTools }), 'failed safely');
  assert.equal(sends, 1);
  assert.equal(store.history(session)[0].status, 'failed');
  assert.match(JSON.parse(store.history(session)[0].result).error, /outcome is unknown/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
