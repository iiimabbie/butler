import { readOnlyTools } from './code-mode.js';

/** Only explicitly observational tools may participate in unrestricted recovery: the shared read-only set
 * plus observational tools kept out of scripts. Shell, delegation, new tools and tools with mixed
 * read/write modes default to effectful.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([...readOnlyTools, 'tools_catalog', 'local_process_output', 'subagent_list', 'subagent_status']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'stopping', 'pending', 'in_progress', 'requires_action', 'requires_approval', 'awaiting_approval']);
const UNCERTAIN_STATUSES = new Set(['failed', 'unknown', 'failed_unknown', 'interrupted', 'cancelled', 'canceled', 'handoff']);

export class IncompleteTurnRecovery {
  private effects = false;
  private unsafe = false;
  private readonly pendingProcesses = new Set<string>();

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
      if ('error' in output || output.ok === false || output.accepted === false || output.timed_out === true || output.stopped === true ||
          (typeof output.status === 'string' && UNCERTAIN_STATUSES.has(output.status))) this.unsafe = true;
      // Background delegates are checked against the live coordinator at decision time.
      // Deployment acceptance deliberately waits for ask completion, so it may be
      // summarized as queued; it must never be represented as completed by this policy.
      if (typeof output.status === 'string' && ACTIVE_STATUSES.has(output.status) && !processTool &&
          !['subagent_run', 'subagent_send', 'subagent_stop', 'butler_deploy'].includes(name)) this.unsafe = true;
    }
  }

  decide(hasUnfinishedDelegate: boolean): 'continue' | 'finalize' {
    if (this.unsafe) throw new Error('Incomplete-turn recovery blocked: a tool outcome is failed, interrupted, awaiting approval or uncertain; completed actions will not be replayed');
    if (this.pendingProcesses.size || hasUnfinishedDelegate) throw new Error('Incomplete-turn recovery blocked: background work or a pending delegate must be resolved before recovery');
    return this.effects ? 'finalize' : 'continue';
  }
}

export function unfinishedDelegateStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status) || UNCERTAIN_STATUSES.has(status);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
