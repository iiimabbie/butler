/** Only explicitly observational tools may participate in unrestricted recovery.
 * Shell, delegation, new tools and tools with mixed read/write modes default to effectful.
 */
const READ_ONLY_TOOLS = new Set([
  'tools_catalog', 'history_list', 'history_get', 'history_search', 'journal_transcript_by_date',
  'memory_tags_list', 'memory_recall', 'memory_reflect', 'people_list', 'people_get',
  'discord_fetch_message', 'discord_fetch_channel_messages', 'discord_fetch_channel',
  'google_gmail_search', 'google_gmail_read', 'google_calendar_list_events',
  'google_tasks_lists', 'google_tasks_list', 'google_drive_search', 'google_drive_read',
  'local_read', 'local_search', 'local_process_output',
  'web_search', 'web_fetch', 'web_extract', 'web_map', 'web_usage',
  'weather_search', 'weather_forecast', 'skills_list', 'skills_read', 'schedule_list',
  'subagent_list', 'subagent_status', 'deployment_result_status',
  'hledger_accounts', 'hledger_forecast', 'hledger_budget', 'hledger_backup_list',
  'hledger_lock_status', 'hledger_operations_list', 'hledger_schedules_list',
]);
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
