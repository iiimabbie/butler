import { Cron } from 'croner';

export type ScheduleKind = 'cron' | 'reminder';
export type ScheduleRunStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface ScheduleJob {
  id: string;
  sourceChannelId: string;
  outputChannelId: string;
  creatorId: string;
  kind: ScheduleKind;
  content: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  enabled: boolean;
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: string;
  jobId: string;
  scheduledAt: string;
  status: ScheduleRunStatus;
  claimedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface CreateScheduleInput {
  sourceChannelId: string;
  outputChannelId: string;
  creatorId: string;
  kind: ScheduleKind;
  content: string;
  cron?: string;
  runAt?: string;
  timezone?: string;
}

/** Implement atomically with SQLite: claim inserts unique (job_id, scheduled_at) run and advances nextRun in one transaction. */
export interface SchedulerStore {
  createSchedule(job: ScheduleJob): ScheduleJob;
  getSchedule(id: string): ScheduleJob | undefined;
  listSchedules(sourceChannelId: string): ScheduleJob[];
  updateSchedule(id: string, patch: Partial<Pick<ScheduleJob, 'outputChannelId' | 'content' | 'cron' | 'runAt' | 'timezone' | 'enabled' | 'nextRun'>>): ScheduleJob | undefined;
  deleteSchedule(id: string): boolean;
  /** Transaction: if due and eligible, insert running execution (unique job/time) and update nextRun; return undefined if already claimed/not due/disabled. */
  claimScheduleRun(id: string, scheduledAt: string, nextRun: string | null, now: string): { job: ScheduleJob; run: ScheduleRun } | undefined;
  /** On startup atomically mark all running executions unknown; never return them as runnable. */
  markRunningScheduleRunsUnknown(now: string): ScheduleRun[];
  /** Returns due enabled jobs. For reminders, include those whose runAt is past only while no execution exists. */
  dueSchedules(now: string): ScheduleJob[];
  finishScheduleRun(runId: string, status: 'completed' | 'failed', error?: string): void;
}

export interface ScheduledTaskRequest {
  job: ScheduleJob;
  run: ScheduleRun;
  prompt: string;
  outputChannelId: string;
}

export interface SchedulerOptions {
  store: SchedulerStore;
  enqueue: (request: ScheduledTaskRequest) => Promise<unknown>;
  log: (message: string, error?: unknown) => void;
  pollIntervalMs?: number;
  now?: () => Date;
}

export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Taipei';

export function nextCronRun(expression: string, timezone = DEFAULT_SCHEDULE_TIMEZONE, from = new Date()): Date {
  validateCronExpression(expression);
  const cron = new Cron(expression, { timezone, paused: true });
  const next = cron.nextRun(from);
  cron.stop();
  if (!next) throw new Error('Cron expression has no future occurrence');
  return next;
}

export function validateCronExpression(expression: string): void {
  if (expression.trim().split(/\s+/).length !== 5) throw new Error('Cron expression must contain exactly five fields');
  let cron: Cron | undefined;
  try { cron = new Cron(expression, { timezone: DEFAULT_SCHEDULE_TIMEZONE, paused: true }); }
  catch { throw new Error('Invalid five-field cron expression'); }
  finally { cron?.stop(); }
}

export function scheduleNextRun(input: { kind: ScheduleKind; cron?: string | null; runAt?: string | null; timezone?: string }, from = new Date()): string | null {
  if (input.kind === 'reminder') {
    if (!input.runAt || !Number.isFinite(Date.parse(input.runAt))) throw new Error('Reminder runAt must be a valid ISO date/time');
    return new Date(input.runAt).toISOString();
  }
  if (!input.cron) throw new Error('Cron schedule requires an expression');
  return nextCronRun(input.cron, input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE, from).toISOString();
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private stopped = true;
  private polling = false;
  private readonly now: () => Date;
  private readonly interval: number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.interval = options.pollIntervalMs ?? 15_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const now = this.now().toISOString();
    for (const run of this.options.store.markRunningScheduleRunsUnknown(now)) {
      this.options.log(`Scheduled execution ${run.id} was running at restart; marked unknown and not replayed`);
    }
    // Skip cron ticks missed while offline once, but do not discard overdue ticks
    // caused by ordinary polling/queue delays after this startup reconciliation.
    for (const job of this.options.store.dueSchedules(now)) {
      if (job.kind !== 'cron' || !job.nextRun || Date.parse(job.nextRun) > Date.parse(now)) continue;
      try {
        const nextRun = scheduleNextRun(job, new Date(Date.parse(now) + 1));
        this.options.store.updateSchedule(job.id, { nextRun });
      } catch (error) {
        this.options.log(`Could not advance missed cron schedule ${job.id}; disabling it`, error);
        this.options.store.updateSchedule(job.id, { enabled: false });
      }
    }
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.interval);
  }

  async pause(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.polling) await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.allSettled([...this.pending]);
  }

  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.interval);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.polling) await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.allSettled([...this.pending]);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const nowDate = this.now();
      const now = nowDate.toISOString();
      for (const job of this.options.store.dueSchedules(now)) {
        if (this.stopped) break;
        const scheduled = job.kind === 'reminder' ? job.runAt : job.nextRun;
        if (!scheduled || Date.parse(scheduled) > nowDate.getTime()) continue;
        let nextRun: string | null = null;
        if (job.kind === 'cron') {
          try { nextRun = scheduleNextRun({ kind: 'cron', cron: job.cron ?? undefined, timezone: job.timezone }, new Date(Math.max(nowDate.getTime(), Date.parse(scheduled)) + 1)); }
          catch (error) { this.options.log(`Could not calculate next run for schedule ${job.id}; disabling it`, error); this.options.store.updateSchedule(job.id, { enabled: false }); continue; }
        }
        const claimed = this.options.store.claimScheduleRun(job.id, scheduled, nextRun, now);
        if (!claimed) continue;
        const work = this.execute(claimed.job, claimed.run).finally(() => this.pending.delete(work));
        this.pending.add(work);
      }
    } catch (error) { this.options.log('Scheduler polling failed', error); }
    finally { this.polling = false; }
  }

  private async execute(job: ScheduleJob, run: ScheduleRun): Promise<void> {
    try {
      await this.options.enqueue({ job, run, outputChannelId: job.outputChannelId, prompt: `Scheduled task requested by Discord user ${job.creatorId}, created in channel ${job.sourceChannelId}. Send the result only to the configured output channel.\n\n${job.content}` });
      this.options.store.finishScheduleRun(run.id, 'completed');
    } catch (error) {
      this.options.log(`Scheduled task ${job.id} execution ${run.id} failed`, error);
      try { this.options.store.finishScheduleRun(run.id, 'failed', error instanceof Error ? error.message : String(error)); }
      catch (finishError) { this.options.log(`Could not persist scheduled execution ${run.id} failure`, finishError); }
    }
  }
}
