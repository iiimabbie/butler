import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeopleToolRuntime } from '../dist/people-tools.js';
import { ToolUsageError } from '../dist/tool-errors.js';

for (const name of ['people_get', 'people_delete']) {
  test(`${name}: missing page is recoverable and does not mutate`, async () => {
    const runtime = createPeopleToolRuntime({ getKnowledgeTree: async () => [] });
    await assert.rejects(runtime.execute(name, { key: 'discord:123' }), error =>
      error instanceof ToolUsageError && error.message === 'Person page not found for key discord:123');
  });
}
test('people_get: service failure stays an operational error', async () => {
  const failure = new Error('Hindsight returned HTTP 503');
  const runtime = createPeopleToolRuntime({ getKnowledgeTree: async () => { throw failure; } });
  await assert.rejects(runtime.execute('people_get', { key: 'discord:123' }), error => error === failure && !(error instanceof ToolUsageError));
});
test('people_get: existing page remains readable', async () => {
  const runtime = createPeopleToolRuntime({
    getKnowledgeTree: async () => [{ id: 'page', kind: 'page', name: 'Example', mental_model_id: 'model', description: 'Butler person key: "discord:123"\nCanonical identity: dc:123' }],
    getKnowledgePage: async id => { assert.equal(id, 'page'); return { name: 'Example', description: 'query', body: 'profile', markdown: 'profile' }; },
  });
  const result = await runtime.execute('people_get', { key: 'discord:123' });
  assert.equal(result.key, 'discord:123');
  assert.equal(result.body, 'profile');
});
