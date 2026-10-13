import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/store.js';
import { Scheduler } from '../dist/scheduler.js';

const now = new Date('2026-10-13T00:09:00+08:00');
const log = { logWarn() {}, logError(...args) { throw new Error(`unexpected scheduler error: ${args[0]}`); } };
function job(id, kind, runAt, nextRun, enabled = true, cron = null) {
  return { id, sourceChannelId: 'source', outputChannelId: 'output', creatorId: 'creator', kind, content: 'test reminder', cron, runAt, timezone: 'Asia/Taipei', enabled, nextRun, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
async function runSchedule(jobs) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-scheduler-'));
  const store = new Store(join(dir, 'store.sqlite'));
  const enqueued = [];
  const scheduler = new Scheduler({ store, enqueue: async request => { enqueued.push(request); }, log, now: () => now, pollIntervalMs: 5 });
  try {
    for (const item of jobs) store.createSchedule(item);
    scheduler.start();
    for (let i = 0; i < 100 && enqueued.length < jobs.filter(j => j.enabled).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 30)); // allow repeated polling; a claimed reminder must not enqueue again.
    await scheduler.stop();
    const inspect = new DatabaseSync(join(dir, 'store.sqlite'));
    try {
      const schedules = inspect.prepare('SELECT id,next_run,enabled FROM schedules ORDER BY id').all();
      const runs = inspect.prepare('SELECT job_id,scheduled_at,status FROM schedule_runs ORDER BY job_id').all();
      return { enqueued, schedules, runs };
    } finally { inspect.close(); }
  } catch (error) { await scheduler.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { if (store) { store.close(); rmSync(dir, { recursive: true, force: true }); } }
}

test('overdue reminder with offset runAt and UTC nextRun is claimed and enqueued once', async () => {
  const item = job('offset-reminder', 'reminder', '2026-10-12T20:00:00+08:00', '2026-10-12T12:00:00.000Z');
  const { enqueued, schedules, runs } = await runSchedule([item]);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].run.scheduledAt, item.nextRun);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].job_id, item.id);
  assert.equal(runs[0].scheduled_at, item.nextRun);
  assert.equal(runs[0].status, 'completed');
  assert.equal(schedules[0].next_run, null);
});

test('reminder claim accepts equivalent UTC runAt/nextRun forms; disabled overdue reminder is not enqueued', async () => {
  const items = [
    job('utc-reminder', 'reminder', '2026-10-12T12:00:00.000Z', '2026-10-12T12:00:00.000Z'),
    job('disabled-reminder', 'reminder', '2026-10-12T20:00:00+08:00', '2026-10-12T12:00:00.000Z', false),
  ];
  const { enqueued } = await runSchedule(items);
  assert.deepEqual(enqueued.map(x => x.job.id), ['utc-reminder']);
});

test('future cron remains unclaimed and is not affected by reminder handling', async () => {
  const item = job('cron-regression', 'cron', null, '2026-10-13T00:10:00.000Z', true, '0 20 * * *');
  const { enqueued } = await runSchedule([item]);
  assert.equal(enqueued.length, 0);
});
