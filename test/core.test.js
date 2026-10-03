import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Store } from '../dist/store.js';
import { ask } from '../dist/agent.js';

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-'));
  return { dir, path: join(dir, 'nested', 'data.sqlite') };
}
function cleanup(tempDir) { rmSync(tempDir, { recursive: true, force: true }); }
function response(output, outputText) {
  return new Response(JSON.stringify({ output, ...(outputText === undefined ? {} : { output_text: outputText }) }));
}
function call(name, args = '{}', callId = 'call-1') {
  return { type: 'function_call', name, call_id: callId, arguments: args };
}
function agentConfig(fetcher, extra = {}) {
  return { baseUrl: 'http://fake/v1', model: 'test-model', fetcher, ...extra };
}

test('SQLite creates parent directories and preserves sessions and raw history on reopen', () => {
  const t = temp();
  let store = new Store(t.path);
  const session = store.newSession();
  const id = store.beginTool(session, 'demo', { input: 'raw' });
  store.finishTool(id, 'completed', { result: 'unabridged' });
  store.close();
  store = new Store(t.path);
  assert.equal(store.hasSession(session), true);
  assert.deepEqual(JSON.parse(store.toolById(id).result), { result: 'unabridged' });
  store.close();
  cleanup(t.dir);
});

test('same session sends persisted turns once after reopen', async () => {
  const t = temp();
  let store = new Store(t.path);
  const session = store.newSession();
  const seen = [];
  const fetcher = async (_url, options) => {
    const request = JSON.parse(options.body);
    seen.push(request);
    assert.equal(request.store, false);
    return response([], `answer-${seen.length}`);
  };
  assert.equal(await ask(store, session, 'first prompt', agentConfig(fetcher)), 'answer-1');
  store.close();
  store = new Store(t.path);
  assert.equal(await ask(store, session, 'second prompt', agentConfig(fetcher)), 'answer-2');
  const secondInput = seen[1].input;
  assert.equal(secondInput.filter((item) => item.role === 'user' && item.content === 'first prompt').length, 1);
  assert.equal(secondInput.filter((item) => item.role === 'user' && item.content === 'second prompt').length, 1);
  assert.equal(secondInput.at(-1).content, 'second prompt');
  assert.ok(secondInput.some((item) => item.role === 'developer' && item.content.includes('history_list')));
  store.close();
  cleanup(t.dir);
});

test('tool loop records successful result and sends valid function output wire', async () => {
  const t = temp();
  const store = new Store(t.path);
  const session = store.newSession();
  let requests = 0;
  const fetcher = async (_url, options) => {
    requests++;
    const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    if (requests === 1) return response([call('current_time')]);
    assert.ok(request.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call-1'));
    return response([], 'time returned');
  };
  assert.equal(await ask(store, session, 'time?', agentConfig(fetcher)), 'time returned');
  assert.equal(store.history(session)[0].status, 'completed');
  store.close();
  cleanup(t.dir);
});

test('steer received before a final answer is persisted once and gets another model turn', async () => {
  const t = temp(); const store = new Store(t.path); const session = store.newSession();
  const requests = []; let consume = 0;
  const fetcher = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response([], requests.length === 1 ? 'premature final' : 'answer after steer');
  };
  const values = [undefined, 'please also do this', undefined];
  const result = await ask(store, session, 'original', agentConfig(fetcher, { consumeSteer: () => values[consume++] }));
  assert.equal(result, 'answer after steer');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.filter(item => item.role === 'user' && item.content === 'please also do this').length, 1);
  assert.equal(store.messages(session).filter(item => item.role === 'user' && item.content === 'please also do this').length, 1);
  store.close(); cleanup(t.dir);
});

test('failed HTTP and request timeout reject without false success', async () => {
  const t = temp();
  const store = new Store(t.path);
  const session = store.newSession();
  await assert.rejects(ask(store, session, 'http failure', agentConfig(async () => new Response('no', { status: 500 }))), /CPA HTTP 500/);
  let receivedSignal;
  await assert.rejects(ask(store, session, 'timeout', agentConfig(async (_url, options) => {
    receivedSignal = options.signal;
    await new Promise((resolve, reject) => receivedSignal.addEventListener('abort', () => reject(new Error('request timed out')), { once: true }));
  }, { timeoutMs: 10 })), /request timed out/);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, true);
  store.close();
  cleanup(t.dir);
});

test('invalid JSON arguments are saved as failed evidence', async () => {
  const t = temp();
  const store = new Store(t.path);
  const session = store.newSession();
  let requests = 0;
  const fetcher = async () => ++requests === 1 ? response([call('current_time', '{bad')]) : response([], 'handled');
  await ask(store, session, 'bad tool', agentConfig(fetcher));
  const item = store.history(session)[0];
  assert.equal(item.status, 'failed');
  assert.equal(JSON.parse(item.arguments).raw_arguments, '{bad');
  store.close();
  cleanup(t.dir);
});

test('unknown sessions and invalid tool arguments fail explicitly', async () => {
  const t = temp();
  const store = new Store(t.path);
  assert.throws(() => store.ensureSession('not-a-session'), /Unknown session/);
  const session = store.newSession();
  let requests = 0;
  const fetcher = async () => ++requests === 1
    ? response([call('history_get', JSON.stringify({ id: 'x', offset: -1 }))])
    : response([], 'reported error');
  await ask(store, session, 'invalid page', agentConfig(fetcher));
  assert.equal(store.history(session)[0].status, 'failed');
  store.close();
  cleanup(t.dir);
});

test('pending persistence failure prevents tool execution', async () => {
  const t = temp();
  const store = new Store(t.path);
  const session = store.newSession();
  store.beginTool = () => { throw new Error('pending write failed'); };
  let requests = 0;
  const fetcher = async () => ++requests === 1 ? response([call('current_time')]) : response([], 'unexpected');
  await assert.rejects(ask(store, session, 'do not run', agentConfig(fetcher)), /pending write failed/);
  assert.equal(requests, 1);
  store.close();
  cleanup(t.dir);
});

test('result persistence failure stops loop without retrying tool', async () => {
  const t = temp();
  const store = new Store(t.path);
  const session = store.newSession();
  let runs = 0;
  const begin = store.beginTool.bind(store);
  const finish = store.finishTool.bind(store);
  store.beginTool = (...args) => { runs++; return begin(...args); };
  store.finishTool = () => { throw new Error('result write failed'); };
  let requests = 0;
  const fetcher = async () => ++requests === 1 ? response([call('current_time')]) : response([], 'unexpected');
  await assert.rejects(ask(store, session, 'do not retry', agentConfig(fetcher)), /result write failed/);
  assert.equal(runs, 1);
  assert.equal(requests, 1);
  store.finishTool = finish;
  store.close();
  cleanup(t.dir);
});

test('history pages are newest-first and bounded; get returns raw result segments', async () => {
  const t = temp();
  const store = new Store(t.path);
  const session = store.newSession();
  let longId;
  for (const value of ['old', 'x'.repeat(7000), 'newest']) {
    const id = store.beginTool(session, 'item', { value });
    store.finishTool(id, 'completed', { value });
    if (value.startsWith('x')) longId = id;
  }
  const rows = store.history(session, 0, 2);
  assert.equal(rows[0].id !== longId, true);
  assert.equal(store.history(session, 2, 2).length, 1);

  async function getPage(offset) {
    let capturedOutput;
    let requests = 0;
    const fetcher = async (_url, options) => {
      requests++;
      if (requests === 1) return response([call('history_get', JSON.stringify({ id: longId, offset, limit: 4000 }))]);
      capturedOutput = JSON.parse(JSON.parse(options.body).input.at(-1).output);
      return response([], 'page read');
    };
    await ask(store, session, `read page at ${offset}`, agentConfig(fetcher));
    return capturedOutput.result;
  }
  const firstPage = await getPage(0);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.text.length, 4000);
  assert.ok(firstPage.total_length > 4000);
  assert.equal(firstPage.next_offset, 4000);
  const secondPage = await getPage(firstPage.next_offset);
  assert.equal(secondPage.offset, 4000);
  assert.equal(secondPage.text.length, secondPage.total_length - 4000);
  assert.equal(secondPage.next_offset, null);
  store.close();
  cleanup(t.dir);
});

test('models CLI does not create or open the configured database', async () => {
  const t = temp();
  const server = createServer((_request, responseOut) => {
    responseOut.setHeader('content-type', 'application/json');
    responseOut.end(JSON.stringify({ data: [{ id: 'model-x' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const result = await runCli(cli, ['models'], {
    ...process.env,
    CPA_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    BUTLER_DB: t.path,
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'model-x');
  assert.equal(existsSync(dirname(t.path)), false);
  cleanup(t.dir);
});

test('CLI validates --session and keeps option values out of prompt', async () => {
  const t = temp();
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const env = { ...process.env, BUTLER_DB: t.path, CPA_MODEL: 'unused' };
  const missing = await runCli(cli, ['ask', 'hello', '--session'], env);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /--session requires/);
  const unknown = await runCli(cli, ['ask', 'hello', '--session', 'missing-session'], env);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown session/);
  const store = new Store(t.path);
  const session = store.newSession();
  store.close();

  let received;
  const server = createServer(async (request, responseOut) => {
    for await (const chunk of request) { received = JSON.parse(chunk); }
    responseOut.setHeader('content-type', 'application/json');
    responseOut.end(JSON.stringify({ output: [], output_text: 'ok' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const valid = await runCli(cli, ['ask', 'hello', '--session', session], {
    ...env,
    CPA_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(valid.code, 0, valid.stderr);
  const userMessages = received.input.filter((item) => item.role === 'user');
  assert.deepEqual(userMessages.map((item) => item.content), ['hello']);
  cleanup(t.dir);
});

function runCli(cli, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
