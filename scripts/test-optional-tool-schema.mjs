import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { ask } from '../dist/agent.js';
import { runSubagent } from '../dist/subagent.js';
import { createScheduleToolRuntime, scheduleToolDefinitions } from '../dist/schedule-tools.js';
import { preserveOptionalToolArguments } from '../dist/tool-schema.js';

const root = mkdtempSync(join(tmpdir(), 'butler-optional-tools-'));
const store = new Store(join(root, 'test.sqlite'));
try {
  const session = store.newSession();
  const input = store.addMessage(session, 'user', 'test');
  const runtime = createScheduleToolRuntime({ store, sourceChannelId: '123', creatorId: '456', isOutputChannelAllowed: () => true, now: () => new Date('2026-10-10T00:00:00Z') });
  const before = JSON.stringify(scheduleToolDefinitions);
  let requests = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith('/messages/count_tokens')) return Response.json({ input_tokens: 100 });
    const body = JSON.parse(options.body);
    const create = body.tools.find(tool => tool.name === 'schedule_create');
    assert.equal(create.strict, false);
    assert.deepEqual(create.parameters.required, ['kind', 'outputChannelId', 'content', 'label']);
    assert.deepEqual(body.tools.find(tool => tool.name === 'schedule_update').parameters.required, ['id', 'label']);
    assert(body.tools.every(tool => tool.strict === false));
    if (requests++ === 0) return Response.json({ output: [{ type: 'function_call', name: 'schedule_create', call_id: 'cron-test', arguments: JSON.stringify({ kind: 'cron', outputChannelId: '123', content: 'test', cron: '0 3 * * *', label: 'test' }) }] });
    const result = JSON.parse(body.input.find(item => item.type === 'function_call_output').output);
    assert.equal(result.kind, 'cron');
    assert.equal(result.runAt, null);
    return Response.json({ output: [], output_text: 'done' });
  };
  assert.equal(await ask(store, session, 'test', { baseUrl: 'https://test.invalid', model: 'test', storedInput: input, scheduleTools: runtime, workspaceDirectory: root, fetcher }), 'done');
  assert.equal(requests, 2);
  assert.equal(JSON.stringify(scheduleToolDefinitions), before, 'definitions must not be mutated');
  const cron = store.listSchedules('123')[0];
  const updated = await runtime.execute('schedule_update', { id: cron.id, content: 'changed' });
  assert.equal(updated.cron, cron.cron);
  assert.equal(updated.timezone, cron.timezone);
  const reminder = await runtime.execute('schedule_create', { kind: 'reminder', outputChannelId: '123', content: 'test reminder', runAt: '2026-10-11T00:00:00Z' });
  assert.equal(reminder.cron, null);
  await assert.rejects(runtime.execute('schedule_create', { kind: 'cron', outputChannelId: '123', content: 'invalid', cron: '0 3 * * *', runAt: '2026-10-11T00:00:00Z' }), /cannot include runAt/);
  await assert.rejects(runtime.execute('schedule_create', { kind: 'reminder', outputChannelId: '123', content: 'invalid', cron: '0 3 * * *', runAt: '2026-10-11T00:00:00Z' }), /cannot include cron/);
  await assert.rejects(runtime.execute('schedule_create', { kind: 'cron', outputChannelId: '123', content: 'invalid' }), /requires an expression/);
  await assert.rejects(runtime.execute('schedule_create', { kind: 'reminder', outputChannelId: '123', content: 'invalid' }), /valid ISO/);
  const strict = { type: 'function', strict: true, parameters: {} };
  assert.equal(preserveOptionalToolArguments(strict), strict);
  const hosted = { type: 'web_search' };
  assert.equal(preserveOptionalToolArguments(hosted), hosted);
  let childChecked = false;
  await runSubagent({ model: 'test' }, { store, parentSession: session, baseUrl: 'https://test.invalid', localTools: { definitions: [{ type: 'function', name: 'local_test', parameters: { type: 'object', properties: { optional: { type: 'string' } }, required: [] } }], execute: async () => ({}) }, executeTool: async () => ({}), fetcher: async (_url, options) => { const body = JSON.parse(options.body); assert(body.tools.every(tool => tool.strict === false)); assert.deepEqual(body.tools[0].parameters.required, []); childChecked = true; return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }); } }, { task: 'test', context: 'test', constraints: 'test', expected_output: 'test' });
  assert(childChecked);
  console.log('Optional tool schema, serialized main/subagent requests, cron/reminder and update regression checks passed');
} finally {
  store.db.close();
  rmSync(root, { recursive: true, force: true });
}
