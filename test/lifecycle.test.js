import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const launcher = new URL('../scripts/discord-restart.sh', import.meta.url).pathname;

test('managed launcher restarts only exit 75 and waits for readiness on each start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-lifecycle-'));
  const count = join(dir, 'count'); const fakeNode = join(dir, 'fake-node');
  writeFileSync(count, '0');
  writeFileSync(fakeNode, '#!/bin/sh\nn=$(cat "$COUNT_FILE")\nn=$((n + 1))\nprintf "%s" "$n" > "$COUNT_FILE"\nprintf "ready\\n" > "$BUTLER_RESTART_READY_FILE"\n[ "$n" -eq 1 ] && exit 75\nexit 0\n');
  chmodSync(fakeNode, 0o755);
  try {
    const result = await run(launcher, { ...process.env, BUTLER_NODE: fakeNode, COUNT_FILE: count, BUTLER_READY_TIMEOUT_SECONDS: '3', TMPDIR: dir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(count, 'utf8'), '2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('managed launcher reports an early child exit code instead of timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-lifecycle-'));
  const fakeNode = join(dir, 'fake-node');
  writeFileSync(fakeNode, '#!/bin/sh\nexit 42\n'); chmodSync(fakeNode, 0o755);
  try {
    const result = await run(launcher, { ...process.env, BUTLER_NODE: fakeNode, BUTLER_READY_TIMEOUT_SECONDS: '3', TMPDIR: dir });
    assert.equal(result.code, 42);
    assert.match(result.stderr, /exited before readiness \(exit 42\)/);
    assert.doesNotMatch(result.stderr, /timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('managed launcher distinguishes a genuine readiness timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-lifecycle-'));
  const fakeNode = join(dir, 'fake-node');
  writeFileSync(fakeNode, '#!/bin/sh\nexec sleep 30\n'); chmodSync(fakeNode, 0o755);
  try {
    const result = await run(launcher, { ...process.env, BUTLER_NODE: fakeNode, BUTLER_READY_TIMEOUT_SECONDS: '1', TMPDIR: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /readiness timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('managed launcher waits for signal-terminated child to exit before exiting itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-lifecycle-'));
  const count = join(dir, 'count'); const fakeNode = join(dir, 'fake-node'); const done = join(dir, 'done');
  writeFileSync(fakeNode, '#!/bin/sh\necho run >> "$COUNT_FILE"\nprintf "ready\\n" > "$BUTLER_RESTART_READY_FILE"\ntrap \'sleep 0.4; echo terminated > "$DONE_FILE"; exit 0\' TERM\nwhile :; do sleep 1; done\n');
  chmodSync(fakeNode, 0o755);
  let child;
  try {
    child = spawn('sh', [launcher], { env: { ...process.env, BUTLER_NODE: fakeNode, COUNT_FILE: count, DONE_FILE: done, TMPDIR: dir } });
    const closed = new Promise(resolve => child.once('close', resolve));
    const readyFile = await waitForReady(child, dir);
    assert.equal(readFileSync(readyFile, 'utf8').trim(), 'ready');
    child.kill('SIGTERM');
    const code = await closed;
    assert.equal(code, 143);
    assert.equal(readFileSync(count, 'utf8').trim(), 'run');
    assert.equal(readFileSync(done, 'utf8').trim(), 'terminated');
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForReady(child, dir) {
  const started = Date.now();
  while (Date.now() - started < 3000 && child.exitCode === null) {
    const privateDir = readdirSync(dir).find(name => name.startsWith('butler-restart.'));
    if (privateDir) {
      const path = join(dir, privateDir, 'ready');
      try { if (readFileSync(path, 'utf8').startsWith('ready')) return path; } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('managed launcher did not create readiness marker');
}

function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script], { env }); let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
