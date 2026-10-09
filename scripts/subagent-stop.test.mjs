import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runSubagent, subagentDefinitions } from '../dist/subagent.js';
import { SubagentCoordinator } from '../dist/subagent-coordinator.js';
import { Store } from '../dist/store.js';

const stop = { reason: 'Parent asked to stop', requestedAt: '2026-10-09T02:49:11Z' };
const task = { task: 'Implement the assigned slice', context: 'Test fixture', constraints: 'No unrelated changes', expected_output: 'Changes and tests' };
const call = (name, args = {}, call_id = randomUUID()) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id });
const response = (output = [], text) => new Response(JSON.stringify({ status: 'completed', output, ...(text ? { output_text: text } : {}) }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function runnerFixture({ fetcher, executeTool, stopRequest, maxTurns = 3, parentMessage } = {}) {
  const id = randomUUID(); let input = [{ role: 'developer', content: 'old prompt' }];
  const store = {
    createSubagentWindow: () => id,
    getSubagentWindow: () => ({ model: 'test-model', input_json: JSON.stringify(input) }),
    saveSubagentWindow: (_, next) => { input = structuredClone(next); },
  };
  const requests = []; const executed = [];
  const options = {
    baseUrl: 'https://model.invalid', parentSession: 'p', store, stopRequest,
    localTools: { definitions: ['local_read', 'local_search', 'local_write', 'local_edit', 'local_shell', 'local_process_output', 'local_process_stop'].map(name => ({ type: 'function', name })) },
    webTools: { definitions: [{ type: 'function', name: 'web_fetch' }] },
    fetcher: async (_, init) => { const body = JSON.parse(init.body); requests.push(body); return fetcher(body, init, requests.length); },
    executeTool: async (_, model, name, args, callId) => { executed.push({ name, args }); return executeTool?.(name, args, callId); },
    parentMessage,
  };
  return { id, requests, executed, input: () => input, setInput: next => { input = next; }, run: (extra = {}) => runSubagent({ model: 'test-model', maxTurns }, { ...options, ...extra }, { ...task, subagent_id: id }) };
}
function coordinatorFixture(restored = [], custom = {}) {
  const persisted = []; const answers = []; const inbox = [];
  const coordinator = new SubagentCoordinator(snapshot => persisted.push(structuredClone(snapshot)), {
    persistMessage: (_, message) => { inbox.push({ id: randomUUID(), message }); return inbox.at(-1).id; },
    loadMessages: () => inbox,
    consumeMessages: () => { inbox.splice(0); },
    persistAnswer: (...args) => { answers.push(args); },
    ...custom,
  }, restored);
  return { coordinator, persisted, answers, inbox };
}
const start = (coordinator, execute) => coordinator.start({ id: 'c', parentSession: 'p', task: 'work', execute });
const requestStop = (coordinator, resume = async () => ({ stop_status: 'stopped' })) => coordinator.stop('c', 'p', 'stop safely', resume);

test('parent tool explicitly exposes cooperative stop', () => {
  const tool = subagentDefinitions.find(tool => tool.name === 'subagent_stop');
  assert.deepEqual(tool.parameters.required, ['subagent_id', 'reason']);
  assert.match(tool.description, /Does not cancel/);
});

test('stop during HTTP waits for response and blocks stale write/shell calls', async () => {
  const gate = deferred(); const entered = deferred(); let requested;
  const f = runnerFixture({ stopRequest: () => requested, fetcher: async (_, init, n) => {
    if (n === 1) { entered.resolve(init.signal); await gate.promise; return response([call('local_write'), call('local_shell')]); }
    return response([], 'Safe handoff');
  } });
  const work = f.run(); const signal = await entered.promise;
  requested = stop; assert.equal(signal.aborted, false); gate.resolve();
  const result = await work;
  assert.equal(signal.aborted, false); assert.equal(f.executed.length, 0);
  assert.equal(result.stop_status, 'stopped');
  assert.deepEqual(f.requests[1].tools.map(t => t.name), ['local_read', 'local_search', 'local_process_output', 'subagent_parent_message']);
  assert.ok(f.input().filter(i => i.type === 'function_call_output').every(i => JSON.parse(i.output).skipped));
});

test('stop lets current tool complete but skips next write in same batch', async () => {
  const entered = deferred(); const finish = deferred(); let requested;
  const f = runnerFixture({ stopRequest: () => requested,
    fetcher: async (_, init, n) => n === 1 ? response([call('local_write'), call('local_edit')]) : response([], 'First write finished, second not started'),
    executeTool: async () => { entered.resolve(); await finish.promise; return { bytes_written: 5 }; },
  });
  const work = f.run(); await entered.promise; requested = stop; finish.resolve();
  const result = await work;
  assert.deepEqual(f.executed.map(c => c.name), ['local_write']); assert.equal(result.stop_status, 'stopped');
  const outputs = f.input().filter(i => i.type === 'function_call_output').map(i => JSON.parse(i.output));
  assert.equal(outputs[0].bytes_written, 5); assert.equal(outputs[1].skipped, true);
});

test('stale text without tools is not accepted as a stop handoff', async () => {
  let requested;
  const f = runnerFixture({ stopRequest: () => requested, fetcher: async (_, init, n) => {
    if (n === 1) { requested = stop; return response([], 'Old task done'); }
    return response([], 'Actual stop handoff');
  } });
  assert.equal((await f.run()).text, 'Actual stop handoff'); assert.equal(f.requests.length, 2);
});

test('closeout hides and execution-gates all write, shell, process-stop and web tools', async () => {
  const f = runnerFixture({ stopRequest: () => stop, fetcher: async (_, init, n) => n === 1 ? response(['local_write', 'local_edit', 'local_shell', 'local_process_stop', 'web_fetch'].map(name => call(name))) : response([], 'Done') });
  const result = await f.run(); assert.equal(f.executed.length, 0); assert.equal(result.stop_status, 'stopped');
  assert.ok(f.requests.every(r => r.tools.every(t => !['local_write','local_shell','web_fetch'].includes(t.name))));
});

test('closeout uses non-blocking parent communication even when child asks to wait', async () => {
  const waits = [];
  const f = runnerFixture({ stopRequest: () => stop, parentMessage: async (_, wait) => { waits.push(wait); }, fetcher: async (_, init, n) => n === 1 ? response([call('subagent_parent_message', { message: 'Handoff', wait_for_reply: true })]) : response([], 'Done') });
  await f.run(); assert.deepEqual(waits, [false]);
});

test('active background task is explicitly handed off, not stopped or killed', async () => {
  let requested;
  const f = runnerFixture({ stopRequest: () => requested, fetcher: async (_, init, n) => n === 1 ? response([call('local_shell', { background: true })]) : response([], 'Background remains; hand off bg'), executeTool: async () => { requested = stop; return { task_id: 'bg', status: 'running' }; } });
  const result = await f.run(); assert.equal(result.stop_status, 'handoff'); assert.deepEqual(result.background_tasks, ['bg']); assert.deepEqual(f.executed.map(c => c.name), ['local_shell']);
});

test('owned background can be checked to completion; unrelated process inspection is gated', async () => {
  let requested;
  const f = runnerFixture({ stopRequest: () => requested, fetcher: async (_, init, n) => n === 1 ? response([call('local_shell')]) : n === 2 ? response([call('local_process_output', { task_id: 'other' }), call('local_process_output', { task_id: 'bg' })]) : response([], 'Done'), executeTool: async name => {
    if (name === 'local_shell') { requested = stop; return { task_id: 'bg', status: 'running' }; }
    return { task_id: 'bg', status: 'completed' };
  } });
  const result = await f.run(); assert.equal(result.stop_status, 'stopped'); assert.deepEqual(result.background_tasks, []);
  assert.deepEqual(f.executed.map(c => c.args.task_id).filter(Boolean), ['bg']);
});

test('background ownership is recovered from persistent tool output on resume', async () => {
  const f = runnerFixture({ stopRequest: () => stop, fetcher: async () => response([], 'Hand off old bg') });
  f.setInput([{ role: 'developer', content: 'prompt' }, call('local_shell', {}, 'old'), { type: 'function_call_output', call_id: 'old', output: JSON.stringify({ task_id: 'old-bg', status: 'running' }) }]);
  const result = await f.run({ resume: true }); assert.equal(result.stop_status, 'handoff'); assert.deepEqual(result.background_tasks, ['old-bg']);
});

test('unknown shell outcome is not claimed stopped', async () => {
  let requested;
  const f = runnerFixture({ stopRequest: () => requested, fetcher: async (_, init, n) => n === 1 ? response([call('local_shell')]) : response([], 'Unknown shell outcome'), executeTool: async () => { requested = stop; throw new Error('unknown outcome'); } });
  assert.equal((await f.run()).stop_status, 'handoff');
});

test('closeout has four model rounds even at normal max-turn boundary', async () => {
  let requested;
  const f = runnerFixture({ maxTurns: 1, stopRequest: () => requested, fetcher: async (_, init, n) => {
    if (n === 1) { requested = stop; return response([call('local_write')]); }
    return response([call('local_read')]);
  } });
  const result = await f.run(); assert.equal(result.stop_status, 'handoff'); assert.equal(f.requests.length, 5); assert.equal(f.executed.length, 4);
});

test('explicit new run removes old run-scoped stop control', async () => {
  const f = runnerFixture({ fetcher: async () => response([], 'New brief done') });
  f.setInput([{ role: 'developer', content: 'prompt' }, { role: 'developer', content: 'COOPERATIVE STOP requested by parent at yesterday: old stop' }]);
  const result = await f.run(); assert.equal(result.stop_status, undefined);
  assert.ok(!f.requests[0].input.some(i => String(i.content).startsWith('COOPERATIVE STOP requested')));
});

test('normal subagent still executes tools and completes', async () => {
  const f = runnerFixture({ fetcher: async (_, init, n) => n === 1 ? response([call('local_write')]) : response([], 'Done'), executeTool: async () => ({ written: true }) });
  const result = await f.run(); assert.equal(result.stop_status, undefined); assert.equal(f.executed.length, 1);
});

test('queued stop is durable, does not abort, and ends stopped with event', async () => {
  const { coordinator: c, persisted } = coordinatorFixture(); let request; let aborted;
  start(c, async (signal, runId) => { request = c.stopRequest('c', runId); aborted = signal.aborted; return { stop_status: 'stopped', text: 'Handoff' }; });
  assert.equal(requestStop(c).status, 'stopping'); assert.equal(c.prepareQueuedDeploy(), false);
  assert.equal(c.message('c', 'p', 'do more', undefined, async () => {}).accepted, false);
  await c.drain(); assert.equal(aborted, false); assert.equal(request.reason, 'stop safely'); assert.equal(c.status('c', 'p').status, 'stopped');
  assert.ok(persisted.some(s => s.status === 'stopping' && s.stopRequested)); assert.equal(c.pendingEvents().at(-1).kind, 'stopped');
});

test('terminal stop is idempotent and never resumes completed task', async () => {
  const { coordinator: c } = coordinatorFixture(); let executions = 0;
  start(c, async () => { executions++; return 'Done'; }); await c.drain();
  assert.equal(requestStop(c, async () => { executions++; }).already_finished, true); await c.drain(); assert.equal(executions, 1);
});

test('running stop requests are idempotent and do not cancel the signal', async () => {
  const { coordinator: c } = coordinatorFixture(); const entered = deferred(); const finish = deferred(); let signal;
  start(c, async s => { signal = s; entered.resolve(); await finish.promise; return { stop_status: 'handoff', background_tasks: ['bg'] }; });
  await entered.promise; requestStop(c); const first = c.status('c','p').stopRequested;
  requestStop(c); assert.deepEqual(c.status('c','p').stopRequested, first); assert.equal(signal.aborted, false);
  finish.resolve(); await c.drain(); assert.equal(c.status('c','p').status, 'handoff'); assert.equal(c.pendingEvents().at(-1).kind, 'handoff');
});

test('stop resolves pending parent question without question_id or abort', async () => {
  const { coordinator: c, answers } = coordinatorFixture(); const entered = deferred(); let signal;
  start(c, async (s, runId) => { signal = s; const waiting = c.askParent('c', runId, 'Need decision', true, 'call'); entered.resolve(); assert.match(await waiting, /cooperative stop/); return { stop_status: 'stopped' }; });
  await entered.promise; assert.equal(c.status('c','p').status, 'waiting'); requestStop(c); await c.drain();
  assert.equal(signal.aborted, false); assert.equal(answers.length, 1); assert.equal(c.status('c','p').question, undefined); assert.equal(c.status('c','p').status, 'stopped');
});

test('restored waiting task resumes only in stopping closeout mode', async () => {
  const old = { id: 'c', parentSession: 'p', runId: 'old', status: 'waiting', task: 'work', createdAt: 'old', updatedAt: 'old', question: { id: 'q', callId: 'call', message: 'question' } };
  const { coordinator: c } = coordinatorFixture([old]); let observed;
  requestStop(c, async (signal, runId, task, resume) => { observed = { resume, request: c.stopRequest('c', runId), aborted: signal.aborted }; return { stop_status: 'stopped' }; });
  await c.drain(); assert.equal(observed.resume, true); assert.equal(observed.aborted, false); assert.ok(observed.request); assert.equal(c.status('c','p').status, 'stopped');
});

test('wrong parent cannot stop a task', async () => {
  const { coordinator: c } = coordinatorFixture(); const finish = deferred(); start(c, async () => { await finish.promise; return 'Done'; });
  assert.throws(() => c.stop('c','other','stop',async () => {}), /Unknown/); assert.throws(() => c.stop('missing','p','stop',async () => {}), /Unknown/);
  finish.resolve(); await c.drain(); assert.equal(c.status('c','p').status, 'completed');
});

test('failed closeout is handoff, not falsely stopped', async () => {
  const { coordinator: c } = coordinatorFixture(); const entered = deferred(); const finish = deferred();
  start(c, async () => { entered.resolve(); await finish.promise; throw new Error('model failure'); });
  await entered.promise; requestStop(c); finish.resolve(); await c.drain(); assert.equal(c.status('c','p').status, 'handoff'); assert.equal(c.status('c','p').error, 'model failure');
});

test('restored stopping becomes interrupted, preserving stop reason', () => {
  const { coordinator: c } = coordinatorFixture([{ id: 'c', parentSession:'p', runId:'old', status:'stopping', task:'work', createdAt:'old', updatedAt:'old', stopRequested: stop }]);
  assert.equal(c.status('c','p').status,'interrupted'); assert.deepEqual(c.status('c','p').stopRequested,stop);
});

test('sqlite snapshot and question answer preserve stop control across restore', async () => {
  const store = new Store(':memory:');
  try {
    const windowId = store.createSubagentWindow('p','model',[{role:'developer',content:'prompt'},call('subagent_parent_message',{message:'q',wait_for_reply:true},'call')]);
    const create = () => new SubagentCoordinator(s => store.saveSubagentRun(s), {
      persistMessage: (id,message) => store.enqueueSubagentMessage(id,message),
      loadMessages: id => store.pendingSubagentMessages(id),
      consumeMessages: (id, ids, input) => store.consumeSubagentInbox(id,ids,input),
      persistAnswer: (id,callId,answer,stopRequest) => store.answerSubagentQuestion(id,callId,answer,stopRequest),
    }, store.allSubagentRuns());
    const c = create(); const entered = deferred();
    c.start({id:windowId,parentSession:'p',task:'work',execute:async (_,runId) => { const waiting = c.askParent(windowId,runId,'q',true,'call'); entered.resolve(); await waiting; return {stop_status:'stopped'}; }});
    await entered.promise; c.stop(windowId,'p','stop',async () => {}); await c.drain();
    const restored = create(); assert.equal(restored.status(windowId,'p').status,'stopped'); assert.equal(restored.status(windowId,'p').stopRequested.reason,'stop');
    const input = JSON.parse(store.getSubagentWindow(windowId,'p').input_json); assert.ok(input.some(i => i.type === 'function_call_output' && i.call_id === 'call'));
  } finally { store.close(); }
});

test('stop during last normal tool still gets reserved closeout turns', async () => {
  let requested;
  const f = runnerFixture({ maxTurns: 1, stopRequest: () => requested, fetcher: async (_, init, n) => n === 1 ? response([call('local_write')]) : response([], 'Safe handoff'), executeTool: async () => { requested = stop; return {written:true}; } });
  const result = await f.run(); assert.equal(result.stop_status,'stopped'); assert.equal(f.requests.length,2);
});

test('ordinary process inspection does not grant ownership during closeout', async () => {
  let requested;
  const f = runnerFixture({ stopRequest: () => requested, fetcher: async (_, init, n) => n === 1 ? response([call('local_process_output', {task_id:'other'})]) : n === 2 ? response([call('local_process_output', {task_id:'other'})]) : response([], 'Done'), executeTool: async () => { requested = stop; return {task_id:'other',status:'running'}; } });
  await f.run(); assert.equal(f.executed.length,1);
});

test('durable-answer failure leaves pending stop retryable', async () => {
  let failing = true;
  const { coordinator:c } = coordinatorFixture([], {persistAnswer: () => { if (failing) throw new Error('db unavailable'); }});
  const entered = deferred();
  start(c, async (_,runId) => { const p = c.askParent('c',runId,'q',true,'call'); entered.resolve(); await p; return {stop_status:'stopped'}; });
  await entered.promise; assert.throws(() => requestStop(c), /db unavailable/); assert.equal(c.status('c','p').status,'waiting'); assert.equal(c.status('c','p').stopRequested,undefined);
  failing = false; requestStop(c); await c.drain(); assert.equal(c.status('c','p').status,'stopped');
});

test('sqlite pending-answer transaction atomically records stop request', () => {
  const store = new Store(':memory:');
  try {
    const id = store.createSubagentWindow('p','model',[call('subagent_parent_message',{message:'q',wait_for_reply:true},'call')]);
    store.saveSubagentRun({id,parentSession:'p',runId:'r',status:'waiting',task:'t',question:{id:'q',callId:'call'},updatedAt:'now'});
    store.answerSubagentQuestion(id,'call','stop',stop);
    const saved = store.allSubagentRuns()[0]; assert.equal(saved.status,'stopping'); assert.deepEqual(saved.stopRequested,stop); assert.equal(saved.question,undefined);
    const restored = coordinatorFixture(store.allSubagentRuns()).coordinator;
    assert.equal(restored.status(id,'p').status,'interrupted'); assert.deepEqual(restored.status(id,'p').stopRequested,stop);
  } finally { store.close(); }
});
