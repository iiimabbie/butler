import { randomUUID } from 'node:crypto';
import type { MemoryWriteToken } from './store.js';

export type SubagentStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'stopping' | 'stopped' | 'handoff';
export type SubagentEvent = { id: string; runId: string; subagentId: string; parentSession: string; parentInputId?: string; questionId: string; message: string; waitForReply: boolean; kind?: 'question' | 'progress' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'handoff'; status: 'pending' | 'processing' | 'delivered' | 'failed_unknown' };
export type SubagentSnapshot = { id: string; parentSession: string; runId: string; status: SubagentStatus; task: string; createdAt: string; updatedAt: string; origin?: { channelId: string; outputChannelId: string; entryKind: 'normal' | 'scheduled'; requesterId?: string; triggerInputId?: string; memoryWriteToken?: MemoryWriteToken | null }; result?: unknown; error?: string; question?: { id: string; message: string; callId?: string }; turns?: number; currentTool?: string; currentCallId?: string; activity?: string; stopRequested?: { reason: string; requestedAt: string } };
type Execute = (signal: AbortSignal, runId: string, task: string, resume: boolean) => Promise<unknown>;
type Entry = { snapshot: SubagentSnapshot; abort: AbortController; answer?: (value: string) => void };
type Options = {
  onEvent?: (event: SubagentEvent) => void | Promise<void>;
  persistEvent?: (event: SubagentEvent) => void;
  setEventStatus?: (id: string, expected: 'pending' | 'processing', status: Exclude<SubagentEvent['status'], 'pending'>) => boolean;
  persistMessage: (id: string, message: string) => string;
  loadMessages: (id: string) => Array<{ id: string; message: string }>;
  consumeMessages: (id: string, messages: string[], input: unknown[]) => void;
  persistAnswer: (id: string, callId: string, answer: string, stopRequested?: SubagentSnapshot['stopRequested']) => void;
  onIdle?: () => void;
};

export class SubagentCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<void>>();
  private readonly events = new Map<string, SubagentEvent>();
  private frozen = false;

  constructor(private readonly persist: (snapshot: SubagentSnapshot) => void, private readonly options: Options, restored: SubagentSnapshot[] = [], restoredEvents: SubagentEvent[] = []) {
    for (const snapshot of restored) {
      const recovered = { ...snapshot, status: ['queued', 'running', 'stopping'].includes(snapshot.status) ? 'interrupted' as const : snapshot.status };
      this.entries.set(snapshot.id, { snapshot: recovered, abort: new AbortController() });
      this.persist(recovered);
    }
    for (const event of restoredEvents) this.events.set(event.id, event);
    for (const { snapshot } of this.entries.values()) {
      if (snapshot.status !== 'waiting' || !snapshot.question) continue;
      if (![...this.events.values()].some(event => event.subagentId === snapshot.id && event.questionId === snapshot.question!.id && ['pending', 'failed_unknown'].includes(event.status))) {
        this.publish({ id: randomUUID(), runId: snapshot.runId, subagentId: snapshot.id, parentSession: snapshot.parentSession, questionId: snapshot.question.id, message: snapshot.question.message, waitForReply: true, kind: 'question', status: 'pending' }, false);
      }
    }
  }

  start(input: { id: string; parentSession: string; task: string; origin?: SubagentSnapshot['origin']; execute: Execute; resume?: boolean; stopRequested?: SubagentSnapshot['stopRequested'] }): { subagent_id: string; run_id: string; accepted: true; status: SubagentStatus } {
    if (this.frozen) throw new Error('Subagents are frozen');
    const current = this.entries.get(input.id);
    if (current && current.snapshot.parentSession !== input.parentSession) throw new Error('Unknown subagent window for this parent session');
    if (current && ['queued', 'running', 'waiting', 'stopping'].includes(current.snapshot.status)) throw Object.assign(new Error('This subagent window is active; use subagent_send'), { subagent_id: input.id });
    const runId = randomUUID();
    const now = new Date().toISOString();
    const entry: Entry = { snapshot: { id: input.id, parentSession: input.parentSession, runId, status: 'queued', task: input.task, origin: input.origin ?? current?.snapshot.origin, createdAt: current?.snapshot.createdAt ?? now, updatedAt: now, stopRequested: input.stopRequested }, abort: new AbortController() };
    this.entries.set(input.id, entry);
    this.persist(entry.snapshot);
    const work = Promise.resolve().then(async () => {
      try {
        entry.abort.signal.throwIfAborted();
        this.update(entry, entry.snapshot.stopRequested ? 'stopping' : 'running');
        let resume = input.resume ?? false;
        let result: unknown;
        do {
          result = await input.execute(entry.abort.signal, runId, input.task, resume);
          entry.abort.signal.throwIfAborted();
          resume = true;
        } while (!entry.snapshot.stopRequested && this.options.loadMessages(input.id).length);
        entry.snapshot.result = result;
        const status = entry.snapshot.stopRequested ? ((result as { stop_status?: string })?.stop_status === 'stopped' ? 'stopped' : 'handoff') : 'completed';
        this.update(entry, status);
        this.emit(entry, status, typeof result === 'string' ? result : JSON.stringify(result));
      } catch (error) {
        entry.snapshot.error = error instanceof Error ? error.message : String(error);
        if (entry.abort.signal.aborted && entry.snapshot.question) this.update(entry, 'waiting');
        else {
          const status = entry.abort.signal.aborted ? 'interrupted' : entry.snapshot.stopRequested ? 'handoff' : 'failed';
          this.update(entry, status);
          this.emit(entry, status, entry.snapshot.error);
        }
      } finally { entry.answer = undefined; }
    });
    this.running.add(work);
    void work.finally(() => { this.running.delete(work); this.options.onIdle?.(); }).catch(() => undefined);
    return { subagent_id: input.id, run_id: runId, accepted: true, status: 'queued' };
  }

  list(parentSession: string, offset = 0, limit = 20) {
    return [...this.entries.values()].map(entry => entry.snapshot).filter(snapshot => snapshot.parentSession === parentSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(offset, offset + limit).map(({ result, error, ...snapshot }) => ({ ...snapshot, hasResult: result !== undefined, hasError: error !== undefined }));
  }

  status(id: string, parentSession: string, offset = 0, limit = 20) {
    const snapshot = this.entries.get(id)?.snapshot;
    if (!snapshot || snapshot.parentSession !== parentSession) return undefined;
    const text = typeof snapshot.result === 'string' ? snapshot.result : JSON.stringify(snapshot.result ?? snapshot.error ?? '');
    return { ...snapshot, result: text.slice(offset, offset + limit * 1000), resultLength: text.length, nextOffset: offset + limit * 1000 < text.length ? offset + limit * 1000 : undefined };
  }

  message(id: string, parentSession: string, message: string, questionId: string | undefined, resume: Execute) {
    if (this.frozen) throw new Error('Subagents are frozen');
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.parentSession !== parentSession) throw new Error('Unknown subagent window for this parent session');
    if (entry.snapshot.stopRequested && ['stopping', 'interrupted', 'handoff'].includes(entry.snapshot.status)) return { accepted: false, error: 'Stop requested; use subagent_run with an explicit revised brief to resume after the run ends', status: entry.snapshot.status };
    if (entry.snapshot.status === 'waiting') {
      const question = entry.snapshot.question;
      if (!question || question.id !== questionId) return { accepted: false, question };
      if (!question.callId) throw new Error('Pending question has no tool call ID');
      this.options.persistAnswer(id, question.callId, message);
      delete entry.snapshot.question;
      const answer = entry.answer;
      entry.answer = undefined;
      if (answer) { this.update(entry, 'running'); answer(message); }
      else { this.update(entry, 'interrupted'); this.start({ id, parentSession, task: entry.snapshot.task, origin: entry.snapshot.origin, execute: resume, resume: true }); }
      return { accepted: true, subagent_id: id };
    }
    if (questionId) return { accepted: false, error: 'There is no matching pending question' };
    this.options.persistMessage(id, message);
    if (!['queued', 'running'].includes(entry.snapshot.status)) this.start({ id, parentSession, task: entry.snapshot.task, origin: entry.snapshot.origin, execute: resume, resume: true });
    return { accepted: true, subagent_id: id };
  }

  // Cooperative control: never abort an HTTP request or an in-flight host tool.
  stop(id: string, parentSession: string, reason: string, resume: Execute) {
    if (this.frozen) throw new Error('Subagents are frozen');
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.parentSession !== parentSession) throw new Error('Unknown subagent window for this parent session');
    if (!['queued', 'running', 'waiting', 'stopping'].includes(entry.snapshot.status)) return { accepted: true, subagent_id: id, status: entry.snapshot.status, already_finished: true };
    if (entry.snapshot.stopRequested) return { accepted: true, subagent_id: id, status: entry.snapshot.status };
    const stopRequested = { reason, requestedAt: new Date().toISOString() };
    // A pending parent question is released with a durable answer, not an abort.
    if (entry.snapshot.question) {
      const question = entry.snapshot.question;
      if (!question.callId) throw new Error('Pending question has no tool call ID');
      const answer = `Parent requested cooperative stop: ${reason}. Do not start new work; report a safe handoff.`;
      this.options.persistAnswer(id, question.callId, answer, stopRequested);
      entry.snapshot.stopRequested = stopRequested;
      delete entry.snapshot.question;
      const resolve = entry.answer;
      entry.answer = undefined;
      this.update(entry, 'stopping');
      if (resolve) resolve(answer);
      else {
        // Restored waiting runs have no live executor; resume only to close out.
        const stopRequested = entry.snapshot.stopRequested;
        this.update(entry, 'interrupted');
        this.start({ id, parentSession, task: entry.snapshot.task, origin: entry.snapshot.origin, execute: resume, resume: true, stopRequested });
      }
    } else { entry.snapshot.stopRequested = stopRequested; this.update(entry, 'stopping'); }
    return { accepted: true, subagent_id: id, status: 'stopping' };
  }

  stopRequest(id: string, runId: string) {
    const snapshot = this.entries.get(id)?.snapshot;
    return snapshot?.runId === runId ? snapshot.stopRequested : undefined;
  }

  takeMessages(id: string, runId: string, input: unknown[]): string[] {
    if (this.entries.get(id)?.snapshot.runId !== runId) return [];
    const rows = this.options.loadMessages(id);
    this.options.consumeMessages(id, rows.map(row => row.id), input);
    return rows.map(row => row.message);
  }

  async askParent(id: string, runId: string, message: string, wait: boolean, callId: string): Promise<string | undefined> {
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.runId !== runId) throw new Error('Subagent run is no longer active');
    entry.abort.signal.throwIfAborted();
    if (entry.snapshot.stopRequested) return `Parent requested stop: ${entry.snapshot.stopRequested.reason}. Finish the handoff without waiting for an answer.`;
    const questionId = randomUUID();
    let response: Promise<string> | undefined;
    if (wait) {
      response = new Promise<string>((resolve, reject) => {
        const aborted = () => reject(new Error('Subagent run was interrupted'));
        entry.answer = value => { entry.abort.signal.removeEventListener('abort', aborted); resolve(value); };
        entry.abort.signal.addEventListener('abort', aborted, { once: true });
      });
      entry.snapshot.question = { id: questionId, message, callId };
      this.update(entry, 'waiting');
    }
    this.publish({ id: randomUUID(), runId, subagentId: id, parentSession: entry.snapshot.parentSession, questionId, message, waitForReply: wait, kind: wait ? 'question' : 'progress', status: 'pending' });
    return response;
  }

  event(id: string) { const event = this.events.get(id); return event && { ...event }; }
  updateEvent(id: string, status: Exclude<SubagentEvent['status'], 'pending'>) {
    const event = this.events.get(id);
    if (!event || !['pending', 'processing'].includes(event.status)) return;
    if (this.options.setEventStatus && !this.options.setEventStatus(id, event.status as 'pending' | 'processing', status)) return;
    event.status = status;
  }
  pendingEvents() { return [...this.events.values()].filter(event => event.status === 'pending').map(event => ({ ...event })); }
  prepareQueuedDeploy() {
    if ([...this.entries.values()].some(entry => ['queued', 'running', 'stopping'].includes(entry.snapshot.status))) return false;
    for (const entry of this.entries.values()) if (entry.snapshot.status === 'waiting') entry.abort.abort();
    return this.activeCount === 0;
  }
  freeze() { this.frozen = true; for (const entry of this.entries.values()) entry.abort.abort(); }
  async drain() { await Promise.allSettled([...this.running]); }
  unfreeze() { this.frozen = false; }
  get activeCount() { return this.running.size; }
  updateActivity(id: string, runId: string, patch: Pick<SubagentSnapshot, 'turns' | 'currentTool' | 'currentCallId' | 'activity'>) {
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.runId !== runId) return;
    Object.assign(entry.snapshot, patch, { updatedAt: new Date().toISOString() });
    this.persist(entry.snapshot);
  }
  private emit(entry: Entry, kind: 'completed' | 'failed' | 'interrupted' | 'stopped' | 'handoff', message: string) {
    this.publish({ id: randomUUID(), runId: entry.snapshot.runId, subagentId: entry.snapshot.id, parentSession: entry.snapshot.parentSession, questionId: randomUUID(), message, waitForReply: false, kind, status: 'pending' });
  }
  private publish(event: SubagentEvent, notify = true) {
    this.options.persistEvent?.(event);
    this.events.set(event.id, event);
    if (notify) void Promise.resolve().then(() => this.options.onEvent?.(event)).catch(() => undefined);
  }
  private update(entry: Entry, status: SubagentStatus) { entry.snapshot.status = status; entry.snapshot.updatedAt = new Date().toISOString(); this.persist(entry.snapshot); }
}
