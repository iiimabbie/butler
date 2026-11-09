import { randomUUID } from 'node:crypto';

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'stopping' | 'stopped';
export type SubagentEvent = { id: string; runId: string; subagentId: string; parentSession: string; parentInputId?: string; message: string; kind?: 'completed' | 'failed' | 'interrupted' | 'stopped'; status: 'pending' | 'processing' | 'delivered' | 'failed_unknown' };
export type SubagentSnapshot = { id: string; parentSession: string; runId: string; status: SubagentStatus; task: string; createdAt: string; updatedAt: string; origin?: { channelId: string; outputChannelId: string; entryKind: 'normal' | 'scheduled' | 'notification'; requesterId?: string; triggerInputId?: string }; result?: unknown; error?: string; turns?: number; currentTool?: string; currentCallId?: string; activity?: string; stopRequested?: { reason: string; requestedAt: string } };
type Execute = (signal: AbortSignal, runId: string, task: string, resume: boolean) => Promise<string>;
// resumeAfterStop: a message arrived while stopping; the window resumes once the stopped run ends.
type Entry = { snapshot: SubagentSnapshot; abort: AbortController; resumeAfterStop?: Execute };
type Options = {
  onEvent: (event: SubagentEvent) => void | Promise<void>;
  persistEvent: (event: SubagentEvent) => void;
  setEventStatus: (id: string, expected: 'pending' | 'processing', status: Exclude<SubagentEvent['status'], 'pending'>) => boolean;
  getEventStatus: (id: string) => string | undefined;
  pendingEvents: () => SubagentEvent[];
  persistMessage: (id: string, message: string) => string;
  loadMessages: (id: string) => Array<{ id: string; message: string }>;
  consumeMessages: (id: string, messages: string[]) => void;
  onIdle: () => void;
};

export class SubagentCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<void>>();
  private frozen = false;

  constructor(private readonly persist: (snapshot: SubagentSnapshot) => void, private readonly options: Options, restored: SubagentSnapshot[] = []) {
    for (const snapshot of restored) {
      const recovered = { ...snapshot, status: ['queued', 'running', 'stopping'].includes(snapshot.status) ? 'interrupted' as const : snapshot.status };
      this.entries.set(snapshot.id, { snapshot: recovered, abort: new AbortController() });
      this.persist(recovered);
    }
  }

  start(input: { id: string; parentSession: string; task: string; origin?: SubagentSnapshot['origin']; execute: Execute; resume?: boolean }): { subagent_id: string; run_id: string; accepted: true; status: SubagentStatus } {
    if (this.frozen) throw new Error('Subagents are frozen');
    const current = this.entries.get(input.id);
    if (current && current.snapshot.parentSession !== input.parentSession) throw new Error('Unknown subagent window for this parent session');
    if (current && ['queued', 'running', 'stopping'].includes(current.snapshot.status)) throw Object.assign(new Error('This subagent window is active; use subagent_send'), { subagent_id: input.id });
    const runId = randomUUID();
    const now = new Date().toISOString();
    const entry: Entry = { snapshot: { id: input.id, parentSession: input.parentSession, runId, status: 'queued', task: input.task, origin: input.origin ?? current?.snapshot.origin, createdAt: current?.snapshot.createdAt ?? now, updatedAt: now }, abort: new AbortController() };
    this.entries.set(input.id, entry);
    this.persist(entry.snapshot);
    const work = Promise.resolve().then(async () => {
      try {
        entry.abort.signal.throwIfAborted();
        this.update(entry, 'running');
        let resume = input.resume ?? false;
        let result: string;
        do {
          result = await input.execute(entry.abort.signal, runId, input.task, resume);
          entry.abort.signal.throwIfAborted();
          resume = true;
        } while (!entry.snapshot.stopRequested && this.options.loadMessages(input.id).length);
        entry.snapshot.result = result;
        this.update(entry, 'completed');
        this.emit(entry, 'completed', result);
      } catch (error) {
        entry.snapshot.error = error instanceof Error ? error.message : String(error);
        if (entry.snapshot.stopRequested) {
          this.update(entry, 'stopped');
          this.emit(entry, 'stopped', `Stopped by parent: ${entry.snapshot.stopRequested.reason}. The worker process was terminated; work may be partially applied. Use subagent_send on this ID to request a status report.`);
        } else {
          const status = entry.abort.signal.aborted ? 'interrupted' : 'failed';
          this.update(entry, status);
          this.emit(entry, status, entry.snapshot.error);
        }
      }
    });
    this.running.add(work);
    void work.finally(() => {
      this.running.delete(work);
      if (entry.resumeAfterStop && !this.frozen) this.start({ id: input.id, parentSession: input.parentSession, task: entry.snapshot.task, origin: entry.snapshot.origin, execute: entry.resumeAfterStop, resume: true });
      this.options.onIdle();
    }).catch(() => undefined);
    return { subagent_id: input.id, run_id: runId, accepted: true, status: 'queued' };
  }

  list(parentSession: string, offset = 0, limit = 20) {
    return [...this.entries.values()].map(entry => entry.snapshot).filter(snapshot => snapshot.parentSession === parentSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(offset, offset + limit).map(({ result, error, ...snapshot }) => ({ ...snapshot, hasResult: result !== undefined, hasError: error !== undefined }));
  }

  status(id: string, parentSession: string, offset = 0, limit = 20) {
    const snapshot = this.entries.get(id)?.snapshot;
    if (!snapshot || snapshot.parentSession !== parentSession) return undefined;
    const text = typeof snapshot.result === 'string' ? snapshot.result : typeof snapshot.result === 'object' && snapshot.result !== null && 'text' in snapshot.result && typeof snapshot.result.text === 'string' ? snapshot.result.text : snapshot.error ?? '';
    return { ...snapshot, result: text.slice(offset, offset + limit * 1000), resultLength: text.length, nextOffset: offset + limit * 1000 < text.length ? offset + limit * 1000 : undefined };
  }

  message(id: string, parentSession: string, message: string, resume: Execute) {
    if (this.frozen) throw new Error('Subagents are frozen');
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.parentSession !== parentSession) throw new Error('Unknown subagent window for this parent session');
    this.options.persistMessage(id, message);
    if (entry.snapshot.status === 'stopping') entry.resumeAfterStop = resume;
    else if (!['queued', 'running'].includes(entry.snapshot.status)) this.start({ id, parentSession, task: entry.snapshot.task, origin: entry.snapshot.origin, execute: resume, resume: true });
    return { accepted: true, subagent_id: id };
  }

  stop(id: string, parentSession: string, reason: string) {
    if (this.frozen) throw new Error('Subagents are frozen');
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.parentSession !== parentSession) throw new Error('Unknown subagent window for this parent session');
    if (!['queued', 'running', 'stopping'].includes(entry.snapshot.status)) return { accepted: true, subagent_id: id, status: entry.snapshot.status, already_finished: true };
    if (!entry.snapshot.stopRequested) entry.snapshot.stopRequested = { reason, requestedAt: new Date().toISOString() };
    this.update(entry, 'stopping');
    entry.abort.abort();
    return { accepted: true, subagent_id: id, status: 'stopping' };
  }

  loadMessages(id: string, runId: string): Array<{ id: string; message: string }> {
    return this.entries.get(id)?.snapshot.runId === runId ? this.options.loadMessages(id) : [];
  }
  consumeMessages(id: string, runId: string, messages: string[]): void {
    if (this.entries.get(id)?.snapshot.runId === runId) this.options.consumeMessages(id, messages);
  }

  event(id: string) { const status = this.options.getEventStatus(id); return status ? { status } : undefined; }
  updateEvent(id: string, status: Exclude<SubagentEvent['status'], 'pending'>) {
    const expected = this.options.getEventStatus(id);
    if (expected === 'pending' || expected === 'processing') this.options.setEventStatus(id, expected, status);
  }
  pendingEvents() { return this.options.pendingEvents().filter(event => event.status === 'pending'); }
  prepareQueuedDeploy() {
    return this.activeCount === 0;
  }
  freeze() { this.frozen = true; for (const entry of this.entries.values()) entry.abort.abort(); }
  async drain() { await Promise.allSettled([...this.running]); }
  get activeCount() { return this.running.size; }
  updateActivity(id: string, runId: string, patch: Pick<SubagentSnapshot, 'turns' | 'currentTool' | 'currentCallId' | 'activity'>) {
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.runId !== runId) return;
    Object.assign(entry.snapshot, patch, { updatedAt: new Date().toISOString() });
    this.persist(entry.snapshot);
  }
  private emit(entry: Entry, kind: 'completed' | 'failed' | 'interrupted' | 'stopped', message: string) {
    this.publish({ id: randomUUID(), runId: entry.snapshot.runId, subagentId: entry.snapshot.id, parentSession: entry.snapshot.parentSession, message, kind, status: 'pending' });
  }
  private publish(event: SubagentEvent) {
    this.options.persistEvent(event);
    void Promise.resolve().then(() => this.options.onEvent(event)).catch(() => undefined);
  }
  private update(entry: Entry, status: SubagentStatus) { entry.snapshot.status = status; entry.snapshot.updatedAt = new Date().toISOString(); this.persist(entry.snapshot); }
}
