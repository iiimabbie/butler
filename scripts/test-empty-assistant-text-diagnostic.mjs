import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { ask } from '../dist/agent.js';
import { buildEmptyAssistantTextDiagnostic } from '../dist/empty-assistant-text-diagnostic.js';

const id = { requestId: 'req-123', session: 'session-456', model: 'gpt-test', httpStatus: 200 };
const diagnostic = raw => buildEmptyAssistantTextDiagnostic({ ...id, raw });

const empty = diagnostic({ status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 0 } });
assert.equal(empty.outputCount, 0);
assert.equal(empty.apiStatus, 'completed');
assert.deepEqual(empty.usage, { inputTokens: 12, outputTokens: 0 });

const refusalOnly = diagnostic({ status: 'completed', output: [{ type: 'message', channel: 'final', content: [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL_TEXT' }] }] });
assert.deepEqual(refusalOnly.output, [{ type: 'message', channel: 'final', contentCount: 1, contentTruncated: false, contentTypes: ['refusal'] }]);

const incomplete = diagnostic({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens', ignored: 'PRIVATE_DETAILS' }, output: [] });
assert.equal(incomplete.apiStatus, 'incomplete');
assert.equal(incomplete.incompleteReason, 'max_output_tokens');
assert.equal(diagnostic({ incomplete_details: { reason: 'PRIVATE_FREE_TEXT' }, output: [] }).incompleteReason, 'unknown');

const commentary = diagnostic({ status: 'completed', output: [{ type: 'message', channel: 'commentary', content: [{ type: 'output_text', text: 'PRIVATE_COMMENTARY' }] }] });
assert.equal(commentary.output[0].channel, 'commentary');
assert.deepEqual(commentary.output[0].contentTypes, ['output_text']);

const nonText = diagnostic({ status: 'completed', output: [{ type: 'image_generation_call', result: 'PRIVATE_BASE64' }, { type: 'message', content: [{ type: 'input_image', image_url: 'PRIVATE_URL' }] }] });
assert.deepEqual(nonText.output.map(item => item.type), ['image_generation_call', 'message']);
assert.deepEqual(nonText.output[1].contentTypes, ['input_image']);

const malformed = diagnostic({ status: { secret: 'PRIVATE_STATUS' }, incomplete_details: 'PRIVATE_DETAILS', usage: { input_tokens: 'PRIVATE_NUMBER' }, output: [{ type: 'PRIVATE_TYPE', channel: { secret: 'PRIVATE_CHANNEL' }, content: 'PRIVATE_CONTENT' }] });
assert.equal(malformed.apiStatus, 'invalid');
assert.equal(malformed.incompleteReason, 'invalid');
assert.deepEqual(malformed.usage, { inputTokens: 'invalid', outputTokens: 'missing' });
assert.deepEqual(malformed.output, [{ type: 'unknown' }]);
assert.equal(malformed.outputCount, 1);
assert.equal(malformed.output[0].channel, undefined);

const huge = diagnostic({ output: Array.from({ length: 27 }, () => ({ type: 'message', channel: 'analysis', content: Array.from({ length: 25 }, () => ({ type: 'output_text', text: 'PRIVATE_TEXT' })) })) });
assert.equal(huge.outputCount, 27);
assert.equal(huge.output.length, 20);
assert.equal(huge.outputTruncated, true);
assert.equal(huge.output[0].contentCount, 25);
assert.equal(huge.output[0].contentTypes.length, 20);
assert.equal(huge.output[0].contentTruncated, true);

const serialized = JSON.stringify([refusalOnly, incomplete, commentary, nonText, malformed, huge]);
for (const secret of ['PRIVATE_REFUSAL_TEXT', 'PRIVATE_DETAILS', 'PRIVATE_FREE_TEXT', 'PRIVATE_COMMENTARY', 'PRIVATE_BASE64', 'PRIVATE_URL', 'PRIVATE_STATUS', 'PRIVATE_NUMBER', 'PRIVATE_TYPE', 'PRIVATE_CHANNEL', 'PRIVATE_CONTENT', 'PRIVATE_TEXT']) assert(!serialized.includes(secret), `diagnostic leaked ${secret}`);
assert.equal(buildEmptyAssistantTextDiagnostic({ ...id, httpStatus: undefined, raw: { output: null } }).httpStatus, 'missing');
assert.equal(diagnostic({ output: null }).outputCount, 'invalid');
assert.equal(diagnostic({}).apiStatus, 'missing');
assert.equal(diagnostic({}).incompleteReason, 'missing');

const root = mkdtempSync(join(tmpdir(), 'butler-empty-response-'));
const previousError = console.error;
const logs = [];
console.error = (...args) => logs.push(args.join(' '));
try {
  const run = async (responses, expectReject = false) => {
    const store = new Store(join(root, `case-${Math.random()}.sqlite`));
    try {
      const session = store.newSession();
      const storedInput = store.addMessage(session, 'user', 'synthetic test input');
      let responseIndex = 0;
      const fetcher = async (url) => {
        if (String(url).endsWith('/messages/count_tokens')) return Response.json({ input_tokens: 10 });
        return Response.json(responses[responseIndex++]);
      };
      const operation = ask(store, session, 'synthetic test input', { baseUrl: 'https://test.invalid', model: 'gpt-test', storedInput, workspaceDirectory: root, fetcher });
      if (expectReject) await assert.rejects(operation, /LLM response has no assistant text/);
      else assert.equal(await operation, 'synthetic answer');
      return responseIndex;
    } finally { store.db.close(); }
  };
  const initialLogs = logs.length;
  await run([{ status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } }], true);
  assert.equal(logs.length, initialLogs + 1, 'empty assistant text emits exactly one diagnostic');
  const diagnosticLog = logs.at(-1);
  assert.match(diagnosticLog, / \| llm_empty_assistant_text(?: \| |$)/);
  const diagnosticFields = Object.fromEntries([...diagnosticLog.matchAll(/(?:^| )([A-Za-z0-9_]+)=("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null)(?= |$)/g)].map(([, key, value]) => [key, JSON.parse(value)]));
  assert.match(diagnosticFields.requestId, /^.+$/);
  assert.equal(diagnosticFields.httpStatus, 200);
  assert(!logs.at(-1).includes('synthetic test input'));

  const afterEmpty = logs.length;
  await run([{ status: 'completed', output: [], output_text: 'synthetic answer' }]);
  assert.equal(logs.length, afterEmpty, 'normal text emits no empty-text diagnostic');

  const afterNormal = logs.length;
  assert.equal(await run([
    { status: 'completed', output: [{ type: 'function_call', name: 'current_time', call_id: 'call-1', arguments: '{}' }] },
    { status: 'completed', output: [], output_text: 'synthetic answer' },
  ]), 2);
  assert.equal(logs.length, afterNormal, 'function call and subsequent answer emit no empty-text diagnostic');
  console.log('Empty assistant text diagnostic metadata, redaction, bounds, and ask-path behavior passed');
} finally {
  console.error = previousError;
  rmSync(root, { recursive: true, force: true });
}
