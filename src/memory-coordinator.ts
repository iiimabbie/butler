import { randomUUID } from 'node:crypto';
import { Store, type MemoryBatch } from './store.js';
import { Hindsight, ConversationSubmissionError } from './hindsight.js';
import { buildConversationPayload } from './conversation-format.js';

const MAX_TURNS = 20;
const POLL_DELAYS = [5_000, 15_000, 30_000, 60_000] as const;

type Prefix = ReturnType<Store['readyMemoryPrefixes']>[number];
type Work = { documentId: string; kind: 'poll' | 'submit'; batch: MemoryBatch };

export class MemoryCoordinator {
  private started = false;
  private passive = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeHttp?: Promise<void>;
  private readonly pollDelays = new Map<string, number>();
  private readonly recoveryPending = new Set<string>();
  private roundRobinAfter = '';

  constructor(private readonly store: Store, private readonly hindsight: Hindsight) {}

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.store.recoverMessagePreparations();
    this.started = true;
    this.passive = false;
    for (const batch of this.store.inFlightMemoryBatches()) {
      this.recoveryPending.add(batch.operationId);
      if (batch.lastPollAt && batch.nextPollAt) {
        const interval = Date.parse(batch.nextPollAt) - Date.parse(batch.lastPollAt);
        const index = POLL_DELAYS.findIndex(delay => delay === interval);
        this.pollDelays.set(batch.operationId, Math.max(0, index));
      }
      this.store.updateMemoryBatch(batch.operationId, batch.status === 'submitting' ? 'unknown' : batch.status, {
        ...(batch.status === 'submitting' ? { error: 'Restarted after persistent submit intent; checking original operation ID.' } : {}),
        nextPollAt: new Date().toISOString(),
      });
    }
    this.schedule(0);
  }

  notifyReady(): void {
    if (!this.passive && !this.closed) this.schedule(0);
  }

  flushSession(channelId: string, sessionId: string): void {
    this.freezePrefixes(prefix => prefix.channelId === channelId && prefix.sessionId === sessionId, true);
    this.kick();
  }

  async quiesce(): Promise<void> {
    if (this.closed) return;
    this.passive = true;
    this.clearTimer();
    await this.activeHttp?.catch(() => undefined);
    this.freezePrefixes(() => true, true);
  }

  async resume(): Promise<void> {
    if (this.closed) return;
    this.passive = false;
    this.schedule();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.quiesce();
    this.closed = true;
    this.clearTimer();
  }

  private freezePrefixes(matches: (prefix: Prefix) => boolean, force = false): void {
    while (true) {
      const prefix = this.store.readyMemoryPrefixes().find(candidate =>
        matches(candidate) && (force || candidate.messages.length >= MAX_TURNS),
      );
      if (!prefix) return;
      const messages = prefix.messages.slice(0, MAX_TURNS);
      const operationId = randomUUID();
      const payload = buildConversationPayload(operationId, prefix.channelId, prefix.sessionId, messages);
      this.store.createMemoryBatch({
        operationId,
        payload: JSON.stringify(payload),
        sourceMessageIds: messages.map(message => message.id),
        documentId: prefix.documentId,
        sessionId: prefix.sessionId,
        channelId: prefix.channelId,
      });
    }
  }

  private kick(): void {
    if (!this.started || this.passive || this.closed || this.activeHttp) return;
    this.activeHttp = this.drainOne().catch(error => {
      console.error('Memory coordinator drain failed:', error);
    }).finally(() => {
      this.activeHttp = undefined;
      if (!this.passive && !this.closed) this.schedule();
    });
    this.schedule();
  }

  private schedule(delay?: number): void {
    if (this.passive || this.closed || !this.started) return;
    this.clearTimer();
    const wait = delay ?? this.nextDelay();
    if (wait === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let freezeFailed = false;
      try {
        this.freezePrefixes(() => true);
      } catch (error) {
        freezeFailed = true;
        console.error('Memory coordinator freeze failed:', error);
      } finally {
        if (this.activeHttp) this.schedule(freezeFailed ? 1_000 : undefined);
        else if (freezeFailed) this.schedule(1_000);
        else this.kick();
      }
    }, Math.max(0, wait));
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private nextDelay(): number | undefined {
    const now = Date.now();
    const prefixes = this.store.readyMemoryPrefixes();
    const hasFullPrefix = prefixes.some(prefix => prefix.messages.length >= MAX_TURNS);
    if (this.activeHttp) return hasFullPrefix ? 1_000 : undefined;

    const recovery = this.store.inFlightMemoryBatches().filter(batch => this.recoveryPending.has(batch.operationId));
    const pollBatches = this.store.inFlightMemoryBatches().filter(batch => !this.recoveryPending.has(batch.operationId));
    const candidates = this.store.frozenNeverAttempted()
      .filter(batch => this.store.blockingMemoryBatch(batch.documentId)?.operationId === batch.operationId);
    const times: number[] = [];
    if (hasFullPrefix || recovery.length || candidates.length) times.push(now);
    times.push(...pollBatches.map(batch => batch.nextPollAt ? Date.parse(batch.nextPollAt) : now));
    return times.length ? Math.max(0, Math.min(...times) - now) : undefined;
  }

  private async drainOne(): Promise<void> {
    const inFlight = this.store.inFlightMemoryBatches();
    let work: Work | undefined;

    if (this.recoveryPending.size) {
      const recovery = inFlight.filter(batch => this.recoveryPending.has(batch.operationId));
      work = recovery.map(batch => ({ documentId: batch.documentId, kind: 'poll' as const, batch }))
        .sort((a, b) => this.documentOrder(a.documentId, b.documentId))[0];
    } else {
      const now = Date.now();
      const duePolls = inFlight.filter(batch => !batch.nextPollAt || Date.parse(batch.nextPollAt) <= now);
      const submissions = this.store.frozenNeverAttempted()
        .filter(batch => this.store.blockingMemoryBatch(batch.documentId)?.operationId === batch.operationId);
      work = [
        ...duePolls.map(batch => ({ documentId: batch.documentId, kind: 'poll' as const, batch })),
        ...submissions.map(batch => ({ documentId: batch.documentId, kind: 'submit' as const, batch })),
      ].sort((a, b) => this.documentOrder(a.documentId, b.documentId))[0];
    }

    if (!work) return;
    if (work.kind === 'poll') await this.poll(work.batch);
    else await this.submit(work.batch);
    this.roundRobinAfter = work.documentId;
  }

  private async submit(batch: MemoryBatch): Promise<void> {
    this.store.setMemorySubmitIntent(batch.operationId);
    try {
      await this.hindsight.submitConversationBatch(JSON.parse(batch.payload));
      this.store.updateMemoryBatch(batch.operationId, 'pending', {
        nextPollAt: new Date(Date.now() + POLL_DELAYS[0]).toISOString(),
      });
      this.pollDelays.set(batch.operationId, 0);
    } catch (error) {
      const rejection = error instanceof ConversationSubmissionError && error.classification === 'rejection';
      this.store.updateMemoryBatch(batch.operationId, rejection ? 'failed' : 'unknown', {
        error: this.errorText(error),
        ...(!rejection ? { nextPollAt: new Date().toISOString() } : {}),
      });
      if (rejection) this.pollDelays.delete(batch.operationId);
    }
  }

  private async poll(batch: MemoryBatch): Promise<void> {
    const now = new Date().toISOString();
    try {
      const result = await this.hindsight.getOperationStatus(batch.operationId);
      this.recoveryPending.delete(batch.operationId);
      if (result.status === 'completed') {
        this.store.completeMemoryBatch(batch.operationId);
        this.pollDelays.delete(batch.operationId);
      } else if (result.status === 'pending' || result.status === 'processing') {
        const index = this.pollDelays.get(batch.operationId) ?? (batch.lastPollAt ? 1 : 0);
        const nextIndex = Math.min(index + 1, POLL_DELAYS.length - 1);
        this.pollDelays.set(batch.operationId, nextIndex);
        this.store.updateMemoryBatch(batch.operationId, result.status, {
          lastPollAt: now,
          nextPollAt: new Date(Date.now() + POLL_DELAYS[nextIndex]).toISOString(),
        });
      } else if (result.status === 'not_found') {
        this.store.updateMemoryBatch(batch.operationId, 'needs_clarification', {
          lastPollAt: now,
          error: 'Operation not found after persistent submit intent; automatic resubmission is unsafe.',
        });
        this.pollDelays.delete(batch.operationId);
      } else {
        this.store.updateMemoryBatch(batch.operationId, result.status, {
          lastPollAt: now,
          error: JSON.stringify(result.response),
        });
        this.pollDelays.delete(batch.operationId);
      }
    } catch (error) {
      this.recoveryPending.delete(batch.operationId);
      const index = this.pollDelays.get(batch.operationId) ?? (batch.lastPollAt ? 1 : 0);
      const nextIndex = Math.min(index + 1, POLL_DELAYS.length - 1);
      this.pollDelays.set(batch.operationId, nextIndex);
      this.store.updateMemoryBatch(batch.operationId, 'unknown', {
        error: this.errorText(error),
        lastPollAt: now,
        nextPollAt: new Date(Date.now() + POLL_DELAYS[nextIndex]).toISOString(),
      });
    }
    this.roundRobinAfter = batch.documentId;
  }

  private documentOrder(a: string, b: string): number {
    const compare = (value: string): number => value > this.roundRobinAfter ? 0 : 1;
    return compare(a) - compare(b) || a.localeCompare(b);
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
