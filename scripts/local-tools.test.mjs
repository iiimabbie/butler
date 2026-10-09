import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolRuntime } from '../dist/local-tools.js';
import { ToolUsageError } from '../dist/tool-errors.js';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'butler-write-test-'));
  const runtime = new LocalToolRuntime(root);
  try { await run(runtime, root); }
  finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}

for (const overwrite of [undefined, false]) {
  test(`exclusive create rejects existing file; overwrite=${overwrite}`, () => fixture(async (runtime, root) => {
    await writeFile(join(root, 'existing.txt'), 'original');
    await assert.rejects(runtime.execute('local_write', { path: 'existing.txt', content: 'replacement', ...(overwrite === undefined ? {} : { overwrite }) }), error => {
      assert.ok(error instanceof ToolUsageError);
      assert.equal(error.cause.code, 'EEXIST');
      assert.match(error.message, /file unchanged/);
      assert.match(error.message, /local_edit/);
      return true;
    });
    assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'original');
  }));
}

test('new files and explicit overwrite still work', () => fixture(async (runtime, root) => {
  const result = await runtime.execute('local_write', { path: 'new.txt', content: '芮妮' });
  assert.equal(result.bytes_written, Buffer.byteLength('芮妮'));
  await runtime.execute('local_write', { path: 'new.txt', content: '', overwrite: true });
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), '');
}));

test('exclusive create does not follow existing symlink', () => fixture(async (runtime, root) => {
  await writeFile(join(root, 'target.txt'), 'original');
  await symlink('target.txt', join(root, 'link.txt'));
  await assert.rejects(runtime.execute('local_write', { path: 'link.txt', content: 'replacement' }), ToolUsageError);
  assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'original');
}));

for (const overwrite of [false, true]) {
  for (const code of ['ENOENT', 'ENOTDIR']) {
    test(`path open rejection is a usage error; code=${code}, overwrite=${overwrite}`, () => fixture(async (runtime, root) => {
      await writeFile(join(root, 'not-directory'), 'original');
      const path = code === 'ENOENT' ? 'missing/file.txt' : 'not-directory/file.txt';
      await assert.rejects(runtime.execute('local_write', { path, content: 'replacement', overwrite }), error => {
        assert.ok(error instanceof ToolUsageError);
        assert.equal(error.cause.code, code);
        assert.match(error.message, /file unchanged/);
        assert.match(error.message, /parent directories/);
        return true;
      });
      assert.equal(await readFile(join(root, 'not-directory'), 'utf8'), 'original');
      await assert.rejects(readFile(join(root, 'missing')), { code: 'ENOENT' });
    }));
  }
}

test('dangling symlink with overwrite is a safe ENOENT open rejection', () => fixture(async (runtime, root) => {
  await symlink('missing/target.txt', join(root, 'dangling'));
  await assert.rejects(runtime.execute('local_write', { path: 'dangling', content: 'x', overwrite: true }), error => {
    assert.ok(error instanceof ToolUsageError);
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
  await assert.rejects(readFile(join(root, 'missing/target.txt')), { code: 'ENOENT' });
}));

test('directory open failures remain operational errors', () => fixture(async (runtime, root) => {
  await mkdir(join(root, 'directory'));
  await assert.rejects(runtime.execute('local_write', { path: 'directory', content: 'x', overwrite: true }), error => {
    assert.ok(!(error instanceof ToolUsageError));
    assert.equal(error.code, 'EISDIR');
    return true;
  });
}));

test('concurrent exclusive creates have exactly one winner', () => fixture(async (runtime, root) => {
  const results = await Promise.allSettled(['first', 'second'].map(content => runtime.execute('local_write', { path: 'race.txt', content })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected.reason instanceof ToolUsageError);
  const winner = results[0].status === 'fulfilled' ? 'first' : 'second';
  assert.equal(await readFile(join(root, 'race.txt'), 'utf8'), winner);
}));
