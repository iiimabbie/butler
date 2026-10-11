import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleToolRuntime, googleDefinitions } from '../dist/google-tools.js';

function fakeRuntime(handler) {
  const requests = [];
  const client = {
    available: async () => true,
    request: async (path, options) => {
      requests.push({ path, options });
      return handler(path, options);
    },
  };
  return { runtime: createGoogleToolRuntime(client), requests };
}

test('google_tasks_lists is registered with list-specific schema and create guidance', () => {
  const definition = googleDefinitions.find(tool => tool.name === 'google_tasks_lists');
  assert.ok(definition);
  assert.match(definition.description, /task lists.*not the tasks/i);
  assert.equal(definition.parameters.properties.max_results.minimum, 1);
  assert.equal(definition.parameters.properties.max_results.maximum, 1000);
  assert.equal(definition.parameters.properties.max_results.default, 20);
  assert.ok('page_token' in definition.parameters.properties);
  const create = googleDefinitions.find(tool => tool.name === 'google_tasks_create');
  assert.match(create.description, /google_tasks_lists/);
  assert.match(create.description, /task_list_id/);
  assert.match(create.description, /explicitly specified by the user/);
  assert.match(create.description, /without asking/);
  assert.match(create.description, /material classification ambiguity/);
  assert.match(create.description, /@default behavior is retained/);
  assert.ok('task_list_id' in create.parameters.properties);
});

test('google_tasks_lists maps API title/id and forwards maxResults/pageToken pagination', async () => {
  const { runtime, requests } = fakeRuntime(() => ({
    items: [{ id: 'list-1', title: 'Work', kind: 'tasks#taskList' }, { id: 'list-2', title: 'Home' }],
    nextPageToken: 'next-page',
  }));
  const result = await runtime.execute('google_tasks_lists', { max_results: 7, page_token: 'prior-page' });
  assert.deepEqual(requests, [{ path: '/tasks/v1/users/@me/lists', options: { query: { maxResults: 7, pageToken: 'prior-page' } } }]);
  assert.deepEqual(result, { items: [{ id: 'list-1', name: 'Work' }, { id: 'list-2', name: 'Home' }], next_page_token: 'next-page' });
});

test('google_tasks_lists defaults to 20, passes no pageToken when omitted, and exposes no implicit extra pages', async () => {
  const { runtime, requests } = fakeRuntime(() => ({ items: [{ id: 'one', title: 'One' }], nextPageToken: 'later' }));
  const result = await runtime.execute('google_tasks_lists', {});
  assert.deepEqual(requests[0], { path: '/tasks/v1/users/@me/lists', options: { query: { maxResults: 20, pageToken: undefined } } });
  assert.deepEqual(result, { items: [{ id: 'one', name: 'One' }], next_page_token: 'later' });
  assert.equal(requests.length, 1);
});

test('google_tasks_lists validates max_results limits and unknown arguments before requests', async () => {
  const { runtime, requests } = fakeRuntime(() => ({ items: [] }));
  for (const value of [0, 1001, 1.5, '20']) {
    await assert.rejects(runtime.execute('google_tasks_lists', { max_results: value }), /max_results must be an integer from 1 to 1000/);
  }
  await assert.rejects(runtime.execute('google_tasks_lists', { unknown: true }), /Unknown Google tool argument/);
  await assert.rejects(runtime.execute('google_tasks_lists', { page_token: 1 }), /page_token must be a .*string/);
  assert.equal(requests.length, 0);
});

test('existing google_tasks_list and google_tasks_create default-list behavior remains compatible', async () => {
  const { runtime, requests } = fakeRuntime((path, options) => path.endsWith('/tasks')
    ? options.method === 'POST' ? { id: 'task-1', title: 'Call Sam' } : { items: [{ id: 'task-2', title: 'Existing' }], nextPageToken: null }
    : {});
  const listed = await runtime.execute('google_tasks_list', {});
  assert.deepEqual(listed, { items: [{ id: 'task-2', title: 'Existing' }], next_page_token: null });
  const created = await runtime.execute('google_tasks_create', { title: 'Call Sam' });
  assert.deepEqual(created, { id: 'task-1', title: 'Call Sam' });
  assert.equal(requests[0].path, '/tasks/v1/lists/%40default/tasks');
  assert.equal(requests[1].path, '/tasks/v1/lists/%40default/tasks');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(requests[1].options.body, { title: 'Call Sam' });
});
