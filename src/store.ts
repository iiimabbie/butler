import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScheduleJob, ScheduleRun, SchedulerStore } from './scheduler.js';

export type ChannelReplyMode = 'all' | 'mention';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'auto';

export interface Message {
  role: string;
  content: string;
}

export interface MessageSource {
  authorId?: string; isBot?: boolean; channelId?: string; discordMessageId?: string; eventTime?: string;
}

export interface StoredMessage extends Message {
  id: string; sessionId: string; createdAt: string; source: MessageSource;
}

type ScheduleDbRow = { id: string; source_channel_id: string; output_channel_id: string; creator_id: string; kind: 'cron' | 'reminder'; content: string; cron: string | null; run_at: string | null; timezone: string; enabled: number; next_run: string | null; created_at: string; updated_at: string };
type ScheduleRunDbRow = { id: string; job_id: string; scheduled_at: string; status: 'running' | 'completed' | 'failed' | 'unknown'; claimed_at: string; finished_at: string | null; error: string | null };

function scheduleFromRow(row: ScheduleDbRow): ScheduleJob {
  return { id: row.id, sourceChannelId: row.source_channel_id, outputChannelId: row.output_channel_id, creatorId: row.creator_id, kind: row.kind, content: row.content, cron: row.cron, runAt: row.run_at, timezone: row.timezone, enabled: row.enabled === 1, nextRun: row.next_run, createdAt: row.created_at, updatedAt: row.updated_at };
}

function runFromRow(row: ScheduleRunDbRow): ScheduleRun {
  return { id: row.id, jobId: row.job_id, scheduledAt: row.scheduled_at, status: row.status, claimedAt: row.claimed_at, finishedAt: row.finished_at, error: row.error };
}

export interface ToolRecord {
  id: string;
  session_id: string;
  name: string;
  arguments: string;
  status: string;
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

export class Store implements SchedulerStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      const directory = dirname(path);
      if (!existsSync(directory)) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
    }
    const previousUmask = process.umask(0o077);
    try { this.db = new DatabaseSync(path); }
    finally { process.umask(previousUmask); }
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, author_id TEXT, is_bot INTEGER, channel_id TEXT, discord_message_id TEXT, event_time TEXT);
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS channel_state(channel_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT);
      CREATE TABLE IF NOT EXISTS channel_modes(channel_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('queue','steer')));
      CREATE TABLE IF NOT EXISTS restart_notice(id INTEGER PRIMARY KEY CHECK(id=1), channel_id TEXT NOT NULL, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_actions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, buttons TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_action_claims(custom_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL, result TEXT, claimed_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS attachment_deliveries(tool_call_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_settings(id INTEGER PRIMARY KEY CHECK(id=1), bot_reply INTEGER NOT NULL CHECK(bot_reply IN (0,1)));
      CREATE TABLE IF NOT EXISTS bot_channel_state(channel_id TEXT NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(channel_id,bot_id));
      CREATE TABLE IF NOT EXISTS session_sources(session_id TEXT NOT NULL, channel_id TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('owner','bot')), owner_id TEXT NOT NULL, bot_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(session_id,channel_id,source_type,owner_id,bot_id));
      CREATE TABLE IF NOT EXISTS latest_cpa_request(id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL, attempted_at TEXT NOT NULL, body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, source_channel_id TEXT NOT NULL, output_channel_id TEXT NOT NULL, creator_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cron','reminder')), content TEXT NOT NULL, cron TEXT, run_at TEXT, timezone TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled,next_run);
      CREATE TABLE IF NOT EXISTS schedule_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','unknown')), claimed_at TEXT NOT NULL, finished_at TEXT, error TEXT, UNIQUE(job_id,scheduled_at));
      CREATE INDEX IF NOT EXISTS schedule_runs_status_idx ON schedule_runs(status);
      CREATE TABLE IF NOT EXISTS channel_reply_modes(channel_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('all','mention')));
      CREATE TABLE IF NOT EXISTS channel_reasoning_efforts(channel_id TEXT PRIMARY KEY, effort TEXT NOT NULL CHECK(effort IN ('none','minimal','low','medium','high','xhigh','auto')));
      CREATE TABLE IF NOT EXISTS channel_image_models(channel_id TEXT PRIMARY KEY, model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_compact_checkpoints(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, summary TEXT NOT NULL, through_message_id TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    this.db.exec(`
      INSERT INTO session_sources(session_id,channel_id,source_type,owner_id,bot_id)
        SELECT cs.session_id,cs.channel_id,'owner','unknown','' FROM channel_state cs
        WHERE NOT EXISTS (SELECT 1 FROM session_sources ss WHERE ss.session_id=cs.session_id AND ss.channel_id=cs.channel_id AND ss.source_type='owner' AND ss.bot_id='');
    `);
  }

  newSession(): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(id, new Date().toISOString());
    return id;
  }

  hasSession(id: string): boolean {
    return Boolean(this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id));
  }

  ensureSession(id?: string): string {
    if (id) {
      if (!this.hasSession(id)) throw new Error(`Unknown session: ${id}`);
      return id;
    }
    return this.newSession();
  }

  addMessage(session: string, role: string, content: string, source: MessageSource = {}): StoredMessage {
    const message: StoredMessage = { id: randomUUID(), sessionId: session, role, content, createdAt: new Date().toISOString(), source };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(message.id, session, role, content, message.createdAt);
      this.db.prepare('INSERT INTO message_sources(message_id,author_id,is_bot,channel_id,discord_message_id,event_time) VALUES(?,?,?,?,?,?)')
        .run(message.id, source.authorId ?? null, source.isBot === undefined ? null : source.isBot ? 1 : 0, source.channelId ?? null, source.discordMessageId ?? null, source.eventTime ?? null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return message;
  }

  messages(session: string): Message[] {
    return this.db.prepare('SELECT role,content FROM messages WHERE session_id=? ORDER BY rowid').all(session) as unknown as Message[];
  }

  messagesWithSources(session: string): StoredMessage[] {
    const rows = this.db.prepare(`SELECT m.id,m.session_id,m.role,m.content,m.created_at,s.author_id,s.is_bot,s.channel_id,s.discord_message_id,s.event_time
      FROM messages m LEFT JOIN message_sources s ON s.message_id=m.id WHERE m.session_id=? ORDER BY m.rowid`).all(session) as Array<{ id: string; session_id: string; role: string; content: string; created_at: string; author_id: string | null; is_bot: number | null; channel_id: string | null; discord_message_id: string | null; event_time: string | null }>;
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, createdAt: row.created_at,
      source: { ...(row.author_id === null ? {} : { authorId: row.author_id }), ...(row.is_bot === null ? {} : { isBot: row.is_bot === 1 }), ...(row.channel_id === null ? {} : { channelId: row.channel_id }), ...(row.discord_message_id === null ? {} : { discordMessageId: row.discord_message_id }), ...(row.event_time === null ? {} : { eventTime: row.event_time }) } }));
  }

  compactCheckpoint(sessionId: string): { summary: string; throughMessageId: string; updatedAt: string } | undefined {
    const row = this.db.prepare('SELECT summary,through_message_id,updated_at FROM session_compact_checkpoints WHERE session_id=?').get(sessionId) as { summary: string; through_message_id: string; updated_at: string } | undefined;
    return row && { summary: row.summary, throughMessageId: row.through_message_id, updatedAt: row.updated_at };
  }

  saveCompactCheckpoint(sessionId: string, summary: string, throughMessageId: string): void {
    this.db.prepare(`INSERT INTO session_compact_checkpoints(session_id,summary,through_message_id,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET summary=excluded.summary,through_message_id=excluded.through_message_id,updated_at=excluded.updated_at`).run(sessionId, summary, throughMessageId, new Date().toISOString());
  }

  beginTool(session: string, name: string, args: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO tool_calls(id,session_id,name,arguments,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, session, name, JSON.stringify(args), 'pending', new Date().toISOString());
    return id;
  }

  finishTool(id: string, status: 'completed' | 'failed', result: unknown): void {
    const update = this.db.prepare('UPDATE tool_calls SET status=?,result=?,finished_at=? WHERE id=?')
      .run(status, JSON.stringify(result), new Date().toISOString(), id);
    if (Number(update.changes) !== 1) throw new Error(`Could not persist tool result for ${id}`);
  }

  listSessions(): unknown[] {
    return this.db.prepare('SELECT s.id,s.created_at,(SELECT content FROM messages m WHERE m.session_id=s.id ORDER BY rowid DESC LIMIT 1) latest FROM sessions s ORDER BY s.rowid DESC LIMIT 50').all();
  }

  saveLatestRequest(sessionId: string, bodyJson: string, attemptedAt = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO latest_cpa_request(id,session_id,attempted_at,body_json) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,attempted_at=excluded.attempted_at,body_json=excluded.body_json')
      .run(sessionId, attemptedAt, bodyJson);
  }

  history(sessionId: string, offset = 0, limit = 20): ToolRecord[] {
    return this.db.prepare('SELECT id,session_id,name,arguments,status,result,created_at,finished_at FROM tool_calls WHERE session_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(sessionId, limit, offset) as unknown as ToolRecord[];
  }

  search(query: string, offset = 0, limit = 20): ToolRecord[] {
    const like = `%${query}%`;
    return this.db.prepare('SELECT id,session_id,name,arguments,status,result,created_at,finished_at FROM tool_calls WHERE name LIKE ? OR arguments LIKE ? OR result LIKE ? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(like, like, like, limit, offset) as unknown as ToolRecord[];
  }

  toolById(id: string): ToolRecord | undefined {
    return this.db.prepare('SELECT * FROM tool_calls WHERE id=?').get(id) as ToolRecord | undefined;
  }

  channelState(channelId: string, defaultModel: string, ownerId = 'unknown'): { sessionId: string; model: string } {
    const row = this.db.prepare('SELECT session_id,model FROM channel_state WHERE channel_id=?').get(channelId) as { session_id: string; model: string | null } | undefined;
    if (row) return { sessionId: row.session_id, model: row.model ?? defaultModel };
    const sessionId = this.newSession();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO channel_state(channel_id,session_id,model) VALUES(?,?,NULL)').run(channelId, sessionId);
      this.db.prepare("INSERT INTO session_sources VALUES(?,?,'owner',?,'')").run(sessionId, channelId, ownerId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { sessionId, model: defaultModel };
  }

  setChannelSession(channelId: string, sessionId: string, ownerId = 'unknown'): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE channel_state SET session_id=? WHERE channel_id=?').run(sessionId, channelId);
      this.db.prepare("INSERT OR IGNORE INTO session_sources VALUES(?,?,'owner',?,'')").run(sessionId, channelId, ownerId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setChannelModel(channelId: string, model: string): void {
    this.db.prepare('UPDATE channel_state SET model=? WHERE channel_id=?').run(model, channelId);
  }

  channelMode(channelId: string): 'queue' | 'steer' {
    const row = this.db.prepare('SELECT mode FROM channel_modes WHERE channel_id=?').get(channelId) as { mode: 'queue' | 'steer' } | undefined;
    return row?.mode ?? 'queue';
  }

  setChannelMode(channelId: string, mode: 'queue' | 'steer'): void {
    this.db.prepare('INSERT INTO channel_modes(channel_id,mode) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET mode=excluded.mode').run(channelId, mode);
  }

  setRestartNotice(channelId: string | null, messageId?: string): void {
    if (channelId === null) this.db.prepare('DELETE FROM restart_notice WHERE id=1').run();
    else {
      if (!messageId) throw new Error('Restart notice message ID is required');
      this.db.prepare('INSERT INTO restart_notice(id,channel_id,message_id) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id').run(channelId, messageId);
    }
  }

  restartNotice(): { channelId: string; messageId: string } | undefined {
    const row = this.db.prepare('SELECT channel_id,message_id FROM restart_notice WHERE id=1').get() as { channel_id: string; message_id: string } | undefined;
    return row ? { channelId: row.channel_id, messageId: row.message_id } : undefined;
  }

  botReplyEnabled(): boolean {
    const row = this.db.prepare('SELECT bot_reply FROM discord_settings WHERE id=1').get() as { bot_reply: number } | undefined;
    return row?.bot_reply === 1;
  }

  setBotReplyEnabled(enabled: boolean): void {
    this.db.prepare('INSERT INTO discord_settings(id,bot_reply) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET bot_reply=excluded.bot_reply').run(enabled ? 1 : 0);
  }

  attachmentDelivery(toolCallId: string): unknown {
    return this.db.prepare('SELECT status,updated_at FROM attachment_deliveries WHERE tool_call_id=?').get(toolCallId) ?? null;
  }

  updateAttachmentDelivery(toolCallIds: string[], status: 'delivered' | 'failed_or_unknown' | 'not_sent'): void {
    const update = this.db.prepare('INSERT INTO attachment_deliveries(tool_call_id,status,updated_at) VALUES(?,?,?) ON CONFLICT(tool_call_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at');
    for (const id of toolCallIds) update.run(id, status, new Date().toISOString());
  }

  createDiscordAction(input: { id: string; sessionId: string; channelId: string; ownerId: string; expiresAt: string; buttons: unknown }): void {
    this.db.prepare('INSERT INTO discord_actions(id,session_id,channel_id,owner_id,expires_at,status,buttons,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.id, input.sessionId, input.channelId, input.ownerId, input.expiresAt, 'pending', JSON.stringify(input.buttons), new Date().toISOString());
  }

  bindDiscordActionMessage(id: string, messageId: string): void {
    const result = this.db.prepare("UPDATE discord_actions SET message_id=? WHERE id=? AND status='pending'").run(messageId, id);
    if (Number(result.changes) !== 1) throw new Error('Could not persist Discord action message');
  }

  discordAction(id: string): { id: string; session_id: string; channel_id: string; message_id: string | null; owner_id: string; expires_at: string; status: string; buttons: string } | undefined {
    return this.db.prepare('SELECT * FROM discord_actions WHERE id=?').get(id) as ReturnType<Store['discordAction']>;
  }

  claimDiscordAction(customId: string, actionId: string, actorId: string): boolean {
    try {
      this.db.prepare('INSERT INTO discord_action_claims(custom_id,action_id,status,actor_id,claimed_at) VALUES(?,?,?,?,?)')
        .run(customId, actionId, 'pending', actorId, new Date().toISOString());
      return true;
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: discord_action_claims\.custom_id/.test(error.message)) return false;
      throw error;
    }
  }

  finishDiscordAction(customId: string, status: 'completed' | 'failed', result: unknown): void {
    const update = this.db.prepare('UPDATE discord_action_claims SET status=?,result=?,finished_at=? WHERE custom_id=? AND status=\'pending\'')
      .run(status, JSON.stringify(result), new Date().toISOString(), customId);
    if (Number(update.changes) !== 1) throw new Error('Could not persist Discord action result');
  }

  effectiveReplyMode(channelId: string, parentChannelId?: string): 'all' | 'mention' {
    return this.channelReplyMode(channelId) ?? (parentChannelId ? this.channelReplyMode(parentChannelId) : undefined) ?? 'all';
  }

  channelReplyMode(channelId: string): ChannelReplyMode | undefined {
    const row = this.db.prepare('SELECT mode FROM channel_reply_modes WHERE channel_id=?').get(channelId) as { mode: ChannelReplyMode } | undefined;
    return row?.mode;
  }

  setChannelReplyMode(channelId: string, mode: ChannelReplyMode | undefined): void {
    if (mode === undefined) { this.db.prepare('DELETE FROM channel_reply_modes WHERE channel_id=?').run(channelId); return; }
    this.db.prepare('INSERT INTO channel_reply_modes(channel_id,mode) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET mode=excluded.mode').run(channelId, mode);
  }

  channelReasoningEffort(channelId: string): ReasoningEffort | undefined {
    const row = this.db.prepare('SELECT effort FROM channel_reasoning_efforts WHERE channel_id=?').get(channelId) as { effort: ReasoningEffort } | undefined;
    return row?.effort;
  }

  setChannelReasoningEffort(channelId: string, effort: ReasoningEffort | undefined): void {
    if (effort === undefined) { this.db.prepare('DELETE FROM channel_reasoning_efforts WHERE channel_id=?').run(channelId); return; }
    this.db.prepare('INSERT INTO channel_reasoning_efforts(channel_id,effort) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET effort=excluded.effort').run(channelId, effort);
  }

  channelImageModel(channelId: string): string | undefined {
    const row = this.db.prepare('SELECT model FROM channel_image_models WHERE channel_id=?').get(channelId) as { model: string } | undefined;
    return row?.model;
  }

  setChannelImageModel(channelId: string, model: string | undefined): void {
    if (model === undefined) { this.db.prepare('DELETE FROM channel_image_models WHERE channel_id=?').run(channelId); return; }
    this.db.prepare('INSERT INTO channel_image_models(channel_id,model) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET model=excluded.model').run(channelId, model);
  }

  createSchedule(job: ScheduleJob): ScheduleJob {
    this.db.prepare(`INSERT INTO schedules(id,source_channel_id,output_channel_id,creator_id,kind,content,cron,run_at,timezone,enabled,next_run,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.sourceChannelId, job.outputChannelId, job.creatorId, job.kind, job.content, job.cron, job.runAt, job.timezone, job.enabled ? 1 : 0, job.nextRun, job.createdAt, job.updatedAt);
    return job;
  }

  getSchedule(id: string): ScheduleJob | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as ScheduleDbRow | undefined;
    return row && scheduleFromRow(row);
  }

  listSchedules(sourceChannelId: string): ScheduleJob[] {
    return (this.db.prepare('SELECT * FROM schedules WHERE source_channel_id=? ORDER BY created_at,id').all(sourceChannelId) as ScheduleDbRow[]).map(scheduleFromRow);
  }

  updateSchedule(id: string, patch: Partial<Pick<ScheduleJob, 'outputChannelId' | 'content' | 'cron' | 'runAt' | 'timezone' | 'enabled' | 'nextRun'>>): ScheduleJob | undefined {
    const fields: Array<[keyof typeof patch, string]> = [['outputChannelId','output_channel_id'],['content','content'],['cron','cron'],['runAt','run_at'],['timezone','timezone'],['enabled','enabled'],['nextRun','next_run']];
    const selected = fields.filter(([key]) => Object.prototype.hasOwnProperty.call(patch, key));
    if (!selected.length) return this.getSchedule(id);
    const assignments = selected.map(([, column]) => `${column}=?`).join(',');
    const values = selected.map(([key]) => key === 'enabled' ? (patch.enabled ? 1 : 0) : (patch[key as keyof typeof patch] == null ? null : String(patch[key as keyof typeof patch])));
    const result = this.db.prepare(`UPDATE schedules SET ${assignments},updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) return undefined;
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM schedules WHERE id=?').run(id).changes) === 1;
  }

  claimScheduleRun(id: string, scheduledAt: string, nextRun: string | null, now: string): { job: ScheduleJob; run: ScheduleRun } | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM schedules WHERE id=? AND enabled=1 AND next_run=? AND next_run<=?').get(id, scheduledAt, now) as ScheduleDbRow | undefined;
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      const run: ScheduleRun = { id: randomUUID(), jobId: id, scheduledAt, status: 'running', claimedAt: now, finishedAt: null, error: null };
      try {
        this.db.prepare('INSERT INTO schedule_runs(id,job_id,scheduled_at,status,claimed_at) VALUES(?,?,?,?,?)').run(run.id, id, scheduledAt, 'running', now);
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: schedule_runs\.job_id, schedule_runs\.scheduled_at/.test(error.message)) { this.db.exec('ROLLBACK'); return undefined; }
        throw error;
      }
      const updated = this.db.prepare('UPDATE schedules SET next_run=?,updated_at=? WHERE id=? AND enabled=1 AND next_run=?').run(nextRun, now, id, scheduledAt);
      if (Number(updated.changes) !== 1) throw new Error(`Could not advance schedule ${id}`);
      this.db.exec('COMMIT');
      return { job: scheduleFromRow({ ...row, next_run: nextRun, updated_at: now }), run };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markRunningScheduleRunsUnknown(now: string): ScheduleRun[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT * FROM schedule_runs WHERE status='running'").all() as ScheduleRunDbRow[];
      const result = this.db.prepare("UPDATE schedule_runs SET status='unknown',finished_at=?,error='Process stopped before completion' WHERE status='running'").run(now);
      if (Number(result.changes) !== rows.length) throw new Error('Could not mark all running schedule executions unknown');
      this.db.exec('COMMIT');
      return rows.map(row => ({ ...runFromRow(row), status: 'unknown', finishedAt: now, error: 'Process stopped before completion' }));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  dueSchedules(now: string): ScheduleJob[] {
    const rows = this.db.prepare(`SELECT s.* FROM schedules s WHERE s.enabled=1 AND s.next_run IS NOT NULL AND s.next_run<=?
      AND (s.kind!='reminder' OR NOT EXISTS (SELECT 1 FROM schedule_runs r WHERE r.job_id=s.id AND r.scheduled_at=s.next_run)) ORDER BY s.next_run,s.id`).all(now) as ScheduleDbRow[];
    return rows.map(scheduleFromRow);
  }

  finishScheduleRun(runId: string, status: 'completed' | 'failed', error?: string): void {
    const result = this.db.prepare("UPDATE schedule_runs SET status=?,finished_at=?,error=? WHERE id=? AND status='running'").run(status, new Date().toISOString(), error ?? null, runId);
    if (Number(result.changes) !== 1) throw new Error(`Could not persist schedule execution result for ${runId}`);
  }

  close(): void {
    this.db.close();
  }
}
