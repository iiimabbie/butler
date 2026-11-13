import { readOnlyTools } from '../subagent/code-mode.js';

/** Only explicitly observational tools may participate in unrestricted recovery: the shared read-only set
 * plus observational tools kept out of scripts. Shell, delegation, new tools and tools with mixed
 * read/write modes default to effectful.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([...readOnlyTools, 'local_process_output', 'subagent_list', 'subagent_status']);
const ACTIVE_TOOL_STATUSES = new Set(['queued', 'running', 'waiting', 'stopping', 'pending', 'in_progress', 'requires_action', 'requires_approval', 'awaiting_approval']);
const UNCERTAIN_TOOL_STATUSES = new Set(['failed', 'unknown', 'failed_unknown', 'interrupted', 'cancelled', 'canceled', 'handoff']);

export const MAX_REASONING_ONLY_CONTINUATIONS = 2;

export class IncompleteTurnRecovery {
  private effects = false;
  private unsafe = false;
  private readonly pendingProcesses = new Set<string>();
  private continuations = 0;
  private finalTextRetryUsed = false;
  private finalText = false;

  recordToolResult(name: string, value: unknown): void {
    const effectful = !READ_ONLY_TOOLS.has(name);
    this.effects ||= effectful;
    const output = record(value);
    // A read of a process result is evidence of an earlier shell invocation too.
    const processTool = ['local_shell', 'local_process_output', 'local_process_stop'].includes(name);
    if (processTool) this.effects = true;
    if (!output) { if (effectful || processTool) this.unsafe = true; return; }
    if (processTool) {
      if (typeof output.task_id !== 'string') this.unsafe = true;
      else if (output.status === 'completed' && output.exit_code === 0 && !output.timed_out && !output.stopped && !output.signal) this.pendingProcesses.delete(output.task_id);
      else if (output.status === 'running') this.pendingProcesses.add(output.task_id);
      else this.unsafe = true;
    }
    if (effectful || processTool) {
      if ((output.error !== undefined && output.error !== null) || output.ok === false || output.accepted === false || output.timed_out === true || output.stopped === true ||
          (typeof output.status === 'string' && UNCERTAIN_TOOL_STATUSES.has(output.status))) this.unsafe = true;
      // Background delegates are checked against the live coordinator at decision time.
      // Deployment acceptance deliberately waits for ask completion, so it may be
      // summarized as queued; it must never be represented as completed by this policy.
      if (typeof output.status === 'string' && ACTIVE_TOOL_STATUSES.has(output.status) && !processTool &&
          !['subagent_run', 'subagent_send', 'subagent_stop', 'butler_deploy'].includes(name)) this.unsafe = true;
    }
  }

  private decide(hasUnfinishedDelegate: boolean): 'continue' | 'finalize' {
    if (this.unsafe) throw new Error('Incomplete-turn recovery blocked: a tool outcome is failed, interrupted, awaiting approval or uncertain; completed actions will not be replayed');
    if (this.pendingProcesses.size || hasUnfinishedDelegate) throw new Error('Incomplete-turn recovery blocked: background work or a pending delegate must be resolved before recovery');
    return this.effects ? 'finalize' : 'continue';
  }

  /** Whether the remaining turns may only produce the final text, with tools disabled. */
  get finalTextOnly(): boolean { return this.finalText; }

  /** A steer gives the model new work, so tools are allowed again; the attempt counts are kept. */
  resumeToolUse(): void { this.finalText = false; }

  /** Decides how to continue after a completed response with no text and no tool calls; throws when no further attempt is allowed. */
  continueAfterEmptyText(input: { reasoningOnly: boolean; afterImageSave: boolean; hasUnfinishedDelegate: boolean; toolsDisabled: boolean }): { attempt: number; finalTextOnly: boolean } {
    const mode = this.decide(input.hasUnfinishedDelegate);
    if (input.afterImageSave && !input.reasoningOnly) {
      if (this.finalTextRetryUsed) throw new Error('LLM completed image_save but did not provide the required final text reply');
      this.finalTextRetryUsed = true;
    }
    if (this.continuations >= MAX_REASONING_ONLY_CONTINUATIONS) {
      throw new Error(`LLM returned only reasoning after ${MAX_REASONING_ONLY_CONTINUATIONS} continuation attempts; no assistant text or tool calls`);
    }
    this.continuations++;
    // Finalization is latched across every retry and compaction. tool_choice
    // is also enforced locally before executeCall, not merely requested upstream.
    this.finalText ||= mode === 'finalize' || input.toolsDisabled || input.afterImageSave;
    return { attempt: this.continuations, finalTextOnly: this.finalText };
  }
}

export function unfinishedDelegateStatus(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'stopping';
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
