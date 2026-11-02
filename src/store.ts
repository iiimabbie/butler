import { logError } from './log.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { FileBackedSettings, SettingsConflictError, type SettingsSnapshot } from './file-backed-settings.js';
import { nextCronRun, scheduleNextRun } from './scheduler.js';
import type { ScheduleJob, ScheduleRun, SchedulerStore } from './scheduler.js';
import type { TranscriptEntry } from './journal-transcript.js';
import { projectPath } from './paths.js';
import type { NotificationPayload } from './notifications.js';
import type { WorkspaceContext } from './context.js';

// Attachment paths are stored relative to the project root so the project directory can move.
const storedPath = (path: string | undefined): string | null => path === undefined ? null : relative(projectPath('.'), path);

export type ChannelReplyMode = 'all' | 'mention' | 'none';
export interface ChannelPolicy { channelId: string; botReply: boolean | null; hindsightWrite: boolean | null; }
export interface EffectiveChannelPolicy { tracked: boolean; botReply: boolean; hindsightWrite: boolean; replyMode: ChannelReplyMode; mode: 'queue' | 'steer'; }
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'auto';

export interface Message {
  role: string;
  content: string;
}

export interface ForwardedMessage { authorId?: string; authorName?: string; channelId?: string; discordMessageId?: string; eventTime?: string; content?: string; }
export interface MessageSource {
  authorId?: string; authorName?: string; isBot?: boolean; webhookId?: string; sourceKind?: 'discord_external' | 'butler_reply' | 'butler_tool_message' | 'scheduled_input' | 'subagent_event' | 'deployment_result' | 'notification' | 'unknown'; channelId?: string; discordMessageId?: string; eventTime?: string; replyToMessageId?: string; replyToChannelId?: string; forwardedMessage?: ForwardedMessage;
}

export type NotificationStatus = 'pending' | 'processing' | 'completed' | 'unknown';
export interface NotificationEvent { id: string; payload: NotificationPayload; inputMessageId?: string; status: NotificationStatus }
export class NotificationConflictError extends Error {
  constructor() { super('Notification id already has different content'); this.name = 'NotificationConflictError'; }
}

export interface MessageInputAttachment { attachmentId: string; filename: string; mimeType: string; status: 'ready' | 'failed'; localPath?: string; origin?: 'discord_attachment' | 'butler_generated'; memoryDocumentId?: string; transcript?: string; transcriptionError?: string; error?: string; }
export type AttachmentMemoryState = 'queued' | 'submitting' | 'converting' | 'retaining' | 'completed' | 'failed' | 'unknown' | 'suppressed';
export interface AttachmentMemoryJob { messageId: string; attachmentId: string; documentId: string; state: AttachmentMemoryState; conversionOperationId?: string; retainOperationId?: string; attemptedAt?: string; nextPollAt?: string; pollAttempt: number; error?: string; path: string; filename: string; mimeType: string; origin?: 'discord_attachment' | 'butler_generated'; sourceJson: string; }
export interface DiscordSegment { channelId: string; messageId: string; content: string; eventTime: string; replyToMessageId?: string; replyToChannelId?: string; }
export interface StoredMessage extends Message {
  id: string; sessionId: string; createdAt: string; source: MessageSource; attachments: MessageInputAttachment[]; preparationStatus: 'preparing' | 'ready'; discordSegments: DiscordSegment[];
}
export interface AddMessageResult { message: StoredMessage; created: boolean; }
export interface MemoryBatch { operationId: string; payload: string; sourceMessageIds: string[]; documentId: string; sessionId: string; channelId: string; order: number; status: 'frozen' | 'submitting' | 'unknown' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'not_found' | 'needs_clarification' | 'suppressed'; submitIntendedAt?: string; nextPollAt?: string; lastPollAt?: string; error?: string; }

export interface SessionOpeningContext { channelId: string; messageId: string; authorId: string; createdAt: string; content: string; attachments: Array<{ filename: string; mimeType: string }> }

type ScheduleRunDbRow = { id: string; job_id: string; scheduled_at: string; status: 'running' | 'completed' | 'failed' | 'unknown'; claimed_at: string; finished_at: string | null; error: string | null };

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
  private readonly settings: FileBackedSettings;
  private externalStopHooks?: { canStop: (channelId: string) => boolean; archive: (channelId: string) => void };
  private alertChannelIds = new Set<string>();
  private alertModel?: string;
  private readonly ownedSettingsDirectory?: string;
  private closed = false;

  constructor(path: string, options: { settingsDirectory?: string; timezone?: string; alertChannelIds?: string[] } = {}) {
    if (path !== ':memory:') {
      const directory = dirname(path);
      if (!existsSync(directory)) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
    }
    const previousUmask = process.umask(0o077);
    try { this.db = new DatabaseSync(path); }
    finally { process.umask(previousUmask); }
    if (path !== ':memory:') chmodSync(path, 0o600);
    if (options.alertChannelIds) this.alertChannelIds = new Set(options.alertChannelIds);
    const settingsDirectory = options.settingsDirectory ?? (path === ':memory:' ? (this.ownedSettingsDirectory = mkdtempSync(join(tmpdir(), 'butler-settings-'))) : join(dirname(path), 'config'));
    this.settings = new FileBackedSettings(settingsDirectory, options.timezone);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_input_attachments(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attachment_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, local_path TEXT, status TEXT NOT NULL CHECK(status IN ('ready','failed')), error TEXT, origin TEXT, memory_document_id TEXT, transcript TEXT, transcription_error TEXT, PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS attachment_memory_jobs(message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, document_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('queued','submitting','converting','retaining','completed','failed','unknown','suppressed')), conversion_operation_id TEXT, retain_operation_id TEXT, attempted_at TEXT, next_poll_at TEXT, poll_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS message_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, author_id TEXT, channel_id TEXT, discord_message_id TEXT, event_time TEXT, reply_to_message_id TEXT, reply_to_channel_id TEXT, webhook_id TEXT, source_kind TEXT, author_name TEXT, forwarded_message_json TEXT, is_bot INTEGER);
      CREATE TABLE IF NOT EXISTS hindsight_pending(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS discord_outgoing_segments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, discord_message_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, created_at TEXT NOT NULL, reply_to_message_id TEXT, reply_to_channel_id TEXT);
      CREATE TABLE IF NOT EXISTS message_preparation(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('preparing','ready')), updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_batches(operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source_message_ids TEXT NOT NULL, document_id TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, batch_order INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('frozen','submitting','unknown','pending','processing','completed','failed','cancelled','not_found','needs_clarification','suppressed')), submit_intended_at TEXT, last_poll_at TEXT, next_poll_at TEXT, error TEXT, created_at TEXT NOT NULL, UNIQUE(document_id,batch_order));
      CREATE TABLE IF NOT EXISTS memory_batch_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, operation_id TEXT NOT NULL REFERENCES memory_batches(operation_id));
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS subagent_windows(id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subagent_runs(id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subagent_inbox(id TEXT PRIMARY KEY, subagent_id TEXT NOT NULL REFERENCES subagent_windows(id) ON DELETE CASCADE, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','consumed')), created_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS subagent_events(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, subagent_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, parent_input_id TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','processing','delivered','failed_unknown')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_events(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, input_message_id TEXT REFERENCES messages(id), status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','unknown')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_state(channel_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT);
      CREATE TABLE IF NOT EXISTS restart_notice(id INTEGER PRIMARY KEY CHECK(id=1), application_id TEXT NOT NULL, interaction_token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachment_deliveries(tool_call_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_sources(session_id TEXT NOT NULL, channel_id TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('owner','bot')), owner_id TEXT NOT NULL, bot_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(session_id,channel_id,source_type,owner_id,bot_id));
      CREATE TABLE IF NOT EXISTS ask_context(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, items_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_requests(request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ask_id TEXT, trace_id TEXT, turn INTEGER NOT NULL, attempted_at TEXT NOT NULL, body_json TEXT NOT NULL, body_sha256 TEXT NOT NULL, finished_at TEXT, http_status INTEGER, usage_json TEXT, error_type TEXT);
      CREATE INDEX IF NOT EXISTS model_requests_session_ask ON model_requests(session_id,ask_id,turn);
      DROP TABLE IF EXISTS latest_cpa_request;
      CREATE TABLE IF NOT EXISTS schedule_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','unknown')), claimed_at TEXT NOT NULL, finished_at TEXT, error TEXT, UNIQUE(job_id,scheduled_at));
      CREATE INDEX IF NOT EXISTS schedule_runs_status_idx ON schedule_runs(status);
      CREATE TABLE IF NOT EXISTS session_compact_checkpoints(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, summary TEXT NOT NULL, through_message_id TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_workspace(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, context_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_opening_context(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL, attachments_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deploy_notice(id INTEGER PRIMARY KEY CHECK(id=1), channel_id TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hledger_schedules(id TEXT PRIMARY KEY, schedule_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS web_usage(provider TEXT NOT NULL, date TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(provider,date));
      CREATE TABLE IF NOT EXISTS session_context_usage(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, model TEXT NOT NULL, base_url TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, local_count INTEGER NOT NULL, count_source TEXT NOT NULL DEFAULT 'local-count-estimate', context_limit INTEGER NOT NULL, limit_source TEXT NOT NULL, sampled_at TEXT NOT NULL, attachment_signature TEXT NOT NULL, checkpoint_through_message_id TEXT);
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedule_runtime(job_id TEXT PRIMARY KEY,next_run TEXT,schedule_key TEXT NOT NULL);`);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_discord_id_unique ON message_sources(discord_message_id) WHERE discord_message_id IS NOT NULL');
    this.db.exec("UPDATE subagent_events SET status='failed_unknown',updated_at=datetime('now') WHERE status='processing'");
    this.db.exec("UPDATE notification_events SET status='unknown',updated_at=datetime('now') WHERE status='processing'");
    this.initializeFileSettings();
  }

  private initializeFileSettings(): void {
    if (Object.values(this.settings.paths).some(existsSync)) this.settings.activate();
    else this.settings.initialize({ crons: [], reminders: [], channels: {} });
    this.settings.setApply((next, previous) => this.reconcileFileSettings(next, previous), (next, previous) => this.validateFileSettings(next, previous));
    const state = this.settings.current();
    this.validateFileSettings(state, state);
    this.reconcileFileSettings(state, state);
  }

  // The timing fields of a schedule; next_run is recomputed when they change in the settings file.
  private scheduleKey(job: ScheduleJob): string {
    return JSON.stringify({kind:job.kind,cron:job.cron,runAt:job.runAt,timezone:job.timezone,enabled:job.enabled});
  }

  private snapshotTracked(id: string, channels: SettingsSnapshot['channels']): boolean {
    return this.alertChannelIds.has(id) || Object.hasOwn(channels, id);
  }

  private validateFileSettings(next: SettingsSnapshot, previous: SettingsSnapshot): void {
    const overlap = Object.keys(next.channels).filter(id => this.alertChannelIds.has(id));
    if (overlap.length) throw new SettingsConflictError(`Alert channels cannot have general channel settings: ${overlap.join(', ')}`);
    if (!this.externalStopHooks) return;
    const channels = new Set([...Object.keys(previous.channels), ...Object.keys(next.channels), ...this.knownChannelIds()]);
    const affected = [...channels].filter(id => this.snapshotTracked(id, previous.channels) && !this.snapshotTracked(id, next.channels));
    const blocked = affected.filter(id => !this.externalStopHooks!.canStop(id));
    if (blocked.length) throw new SettingsConflictError(`Cannot stop tracking while channel work is active: ${blocked.join(', ')}`);
  }

  private reconcileFileSettings(snapshot: SettingsSnapshot, previous: SettingsSnapshot): void {
    const diskJobs = [...snapshot.crons, ...snapshot.reminders];
    const existing = new Map((this.db.prepare('SELECT job_id,next_run,schedule_key FROM schedule_runtime').all() as Array<{job_id:string;next_run:string|null;schedule_key:string}>).map(row => [row.job_id,row]));
    const archiveIds = [...new Set([...this.knownChannelIds(), ...Object.keys(previous.channels)])].filter(id => (snapshot === previous || this.snapshotTracked(id, previous.channels)) && !this.snapshotTracked(id, snapshot.channels));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare('INSERT INTO schedule_runtime(job_id,next_run,schedule_key) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET next_run=excluded.next_run,schedule_key=excluded.schedule_key');
      for (const job of diskJobs) {
        const runtime = existing.get(job.id);
        const key = this.scheduleKey(job);
        const nextRun = runtime?.schedule_key === key ? runtime.next_run : (job.enabled ? scheduleNextRun(job) : null);
        upsert.run(job.id,nextRun,key);
      }
      const ids = new Set(diskJobs.map(job => job.id));
      for (const id of existing.keys()) if (!ids.has(id)) this.db.prepare('DELETE FROM schedule_runtime WHERE job_id=?').run(id);
      for (const id of archiveIds) this.archiveChannelSession(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setExternalChannelStopHooks(hooks: { canStop: (channelId: string) => boolean; archive: (channelId: string) => void }): void { this.externalStopHooks = hooks; }

  watchFileSettings(onInvalid: (error: Error, file: string) => void): () => void { this.settings.watch(onInvalid); return () => this.settings.close(); }
  setSettingsTimezone(timezone:string):void { this.settings.setTimezone(timezone); }


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

  addMessage(session: string, role: string, content: string, source: MessageSource = {}, attachments: MessageInputAttachment[] = [], memoryWrite?:boolean): StoredMessage {
    return this.addMessageOnce(session, role, content, source, attachments, memoryWrite).message;
  }

  addMessageOnce(session: string, role: string, content: string, source: MessageSource = {}, attachments: MessageInputAttachment[] = [], memoryWrite?:boolean): AddMessageResult {
    const canWrite = memoryWrite ?? this.memoryWriteAllowed(source.channelId);
    const message: StoredMessage = { id: randomUUID(), sessionId: session, role, content, createdAt: source.eventTime ?? new Date().toISOString(), source, attachments, preparationStatus: 'preparing', discordSegments: [] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (source.discordMessageId) {
        const existing = this.db.prepare('SELECT message_id FROM message_sources WHERE discord_message_id=?').get(source.discordMessageId) as { message_id: string } | undefined;
        if (existing) { this.db.exec('COMMIT'); return { message: this.messagesWithSourcesForId(existing.message_id), created: false }; }
      }
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(message.id, session, role, content, message.createdAt);
      this.db.prepare('INSERT INTO message_sources(message_id,author_id,channel_id,discord_message_id,event_time,reply_to_message_id,reply_to_channel_id,webhook_id,source_kind,author_name,forwarded_message_json,is_bot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(message.id, source.authorId ?? null, source.channelId ?? null, source.discordMessageId ?? null, source.eventTime ?? null, source.replyToMessageId ?? null, source.replyToChannelId ?? null, source.webhookId ?? null, source.sourceKind ?? null, source.authorName ?? null, source.forwardedMessage ? JSON.stringify(source.forwardedMessage) : null, source.isBot === undefined ? null : source.isBot ? 1 : 0);
      if (source.sourceKind !== 'subagent_event' && source.sourceKind !== 'scheduled_input' && source.sourceKind !== 'notification') {
        this.db.prepare("INSERT INTO hindsight_pending(message_id,status,updated_at,error) VALUES(?,?,?,?)").run(message.id,canWrite?'pending':'suppressed',message.createdAt,canWrite?null:'Memory writing is disabled for this channel');
      }
      this.db.prepare("INSERT INTO message_preparation(message_id,status,updated_at) VALUES(?,'preparing',?)").run(message.id, message.createdAt);
      const insertAttachment = this.db.prepare('INSERT INTO message_input_attachments(message_id,attachment_id,filename,mime_type,local_path,status,error,origin,memory_document_id,transcript,transcription_error) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const attachment of attachments) insertAttachment.run(message.id, attachment.attachmentId, attachment.filename, attachment.mimeType, storedPath(attachment.localPath), attachment.status, attachment.error ?? null, attachment.origin ?? null, attachment.memoryDocumentId ?? null, attachment.transcript ?? null, attachment.transcriptionError ?? null);
      this.db.exec('COMMIT');
      return { message, created: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateAttachments(messageId: string, attachments: MessageInputAttachment[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM message_input_attachments WHERE message_id=?').run(messageId);
      const insert = this.db.prepare('INSERT INTO message_input_attachments(message_id,attachment_id,filename,mime_type,local_path,status,error,origin,memory_document_id,transcript,transcription_error) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const a of attachments) {
        const documentId = a.status === 'ready' && a.localPath ? a.memoryDocumentId ?? `attachment:${messageId}:${a.attachmentId}` : undefined;
        insert.run(messageId, a.attachmentId, a.filename, a.mimeType, storedPath(a.localPath), a.status, a.error ?? null, a.origin ?? null, documentId ?? null, a.transcript ?? null, a.transcriptionError ?? null);
        if (documentId) {
          const channelId = (this.db.prepare('SELECT channel_id FROM message_sources WHERE message_id=?').get(messageId) as { channel_id: string | null } | undefined)?.channel_id ?? undefined;
          const eligible = this.memoryWriteAllowed(channelId);
          this.db.prepare(`INSERT OR IGNORE INTO attachment_memory_jobs(message_id,attachment_id,document_id,state,error) VALUES(?,?,?,?,?)`).run(messageId,a.attachmentId,documentId,eligible?'queued':'suppressed',eligible?null:'Memory writing was disabled when this message was captured');
        }
      }
      this.markPreparationReady(messageId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  recoverMessagePreparations(): void {
    const rows = this.db.prepare(`SELECT m.id,m.role,s.source_kind FROM messages m JOIN message_preparation p ON p.message_id=m.id LEFT JOIN message_sources s ON s.message_id=m.id WHERE p.status='preparing' ORDER BY m.rowid`).all() as Array<{ id: string; role: string; source_kind: MessageSource['sourceKind'] | null }>;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (row.role === 'assistant' && (row.source_kind === 'butler_reply' || row.source_kind === 'butler_tool_message')) {
          const segments = this.db.prepare('SELECT content FROM discord_outgoing_segments WHERE message_id=? ORDER BY rowid').all(row.id) as Array<{ content: string }>;
          if (segments.length) {
            this.db.prepare('UPDATE messages SET content=? WHERE id=?').run(segments.map(segment => segment.content).join('\n'), row.id);
            this.markPreparationReady(row.id, now);
          } else {
            logError(`Outgoing message ${row.id} remains preparing after restart; no successful Discord segments exist, so its actual delivered content needs manual clarification.`);
          }
          continue;
        }
        this.db.prepare("UPDATE message_input_attachments SET status='failed',error='Attachment preparation interrupted by process restart; file was not read or downloaded during recovery.' WHERE message_id=? AND status='ready'").run(row.id);
        this.markPreparationReady(row.id, now);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  attachmentMemoryJobs(): AttachmentMemoryJob[] {
    const rows = this.db.prepare(`SELECT j.*,a.local_path,a.filename,a.mime_type,a.origin,s.author_id,s.author_name,s.channel_id,s.discord_message_id,s.event_time,s.source_kind,s.forwarded_message_json,m.created_at
      FROM attachment_memory_jobs j JOIN message_input_attachments a USING(message_id,attachment_id) JOIN message_sources s ON s.message_id=j.message_id JOIN messages m ON m.id=j.message_id
      WHERE j.state IN ('queued','submitting','converting','retaining','unknown') ORDER BY j.rowid`).all() as Array<Record<string, unknown>>;
    return rows.flatMap(row => typeof row.local_path === 'string' ? [{ messageId: String(row.message_id), attachmentId: String(row.attachment_id), documentId: String(row.document_id), state: row.state as AttachmentMemoryState,
      ...(typeof row.conversion_operation_id === 'string' ? { conversionOperationId: row.conversion_operation_id } : {}), ...(typeof row.retain_operation_id === 'string' ? { retainOperationId: row.retain_operation_id } : {}),
      ...(typeof row.attempted_at === 'string' ? { attemptedAt: row.attempted_at } : {}), ...(typeof row.next_poll_at === 'string' ? { nextPollAt: row.next_poll_at } : {}), pollAttempt: Number(row.poll_attempt), ...(typeof row.error === 'string' ? { error: row.error } : {}), path: projectPath(row.local_path), filename: String(row.filename), mimeType: String(row.mime_type), ...(row.origin === 'discord_attachment' || row.origin === 'butler_generated' ? { origin: row.origin } : {}),
      sourceJson: JSON.stringify({ authorId: row.author_id, authorName: row.author_name, channelId: row.channel_id, discordMessageId: row.discord_message_id, eventTime: row.event_time, sourceKind: row.source_kind, forwardedMessage: typeof row.forwarded_message_json === 'string' ? JSON.parse(row.forwarded_message_json) : undefined, createdAt: row.created_at }) }] : []);
  }

  updateAttachmentMemoryJob(messageId: string, attachmentId: string, state: AttachmentMemoryState, fields: { conversionOperationId?: string; retainOperationId?: string; attemptedAt?: string; nextPollAt?: string | null; pollAttempt?: number; error?: string | null }): void {
    this.db.prepare(`UPDATE attachment_memory_jobs SET state=?,conversion_operation_id=COALESCE(?,conversion_operation_id),retain_operation_id=COALESCE(?,retain_operation_id),attempted_at=COALESCE(?,attempted_at),next_poll_at=?,poll_attempt=COALESCE(?,poll_attempt),error=? WHERE message_id=? AND attachment_id=?`)
      .run(state, fields.conversionOperationId ?? null, fields.retainOperationId ?? null, fields.attemptedAt ?? null, fields.nextPollAt === undefined ? null : fields.nextPollAt, fields.pollAttempt ?? null, fields.error === undefined ? null : fields.error, messageId, attachmentId);
  }

  private markPreparationReady(messageId: string, updatedAt = new Date().toISOString()): void {
    this.db.prepare("UPDATE message_preparation SET status='ready',updated_at=? WHERE message_id=? AND status='preparing'").run(updatedAt, messageId);
  }

  private messagesWithSourcesForId(id: string): StoredMessage {
    const row = this.db.prepare('SELECT session_id FROM messages WHERE id=?').get(id) as { session_id: string } | undefined;
    const message = row && this.messagesWithSources(row.session_id).find(item => item.id === id);
    if (!message) throw new Error(`Stored message ${id} is missing`);
    return message;
  }

  saveOutgoingSegment(message: StoredMessage, segment: { channelId: string; messageId: string; content: string; createdAt?: string; replyToMessageId?: string; replyToChannelId?: string }): void {
    this.db.prepare('INSERT INTO discord_outgoing_segments(id,message_id,channel_id,discord_message_id,content,created_at,reply_to_message_id,reply_to_channel_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), message.id, segment.channelId, segment.messageId, segment.content, segment.createdAt ?? new Date().toISOString(), segment.replyToMessageId ?? null, segment.replyToChannelId ?? null);
  }

  finalizeOutgoing(messageId: string, deliveredContent: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE messages SET content=? WHERE id=?').run(deliveredContent, messageId);
      this.markPreparationReady(messageId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createOutgoing(session: string, content: string, source: MessageSource, memoryWrite?: boolean): StoredMessage {
    return this.addMessage(session, 'assistant', content, source, [], memoryWrite);
  }

  createMemoryBatch(input: { operationId?: string; payload: string; sourceMessageIds: string[]; documentId: string; sessionId: string; channelId: string }): MemoryBatch {
    if (!input.sourceMessageIds.length || input.sourceMessageIds.length > 25) throw new Error('A memory batch must contain 1–25 source turns');
    const operationId = input.operationId ?? randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = new Set(input.sourceMessageIds);
      if (ids.size !== input.sourceMessageIds.length) throw new Error('Duplicate source message ID in batch');
      const alreadyBatched = this.db.prepare(`SELECT message_id FROM memory_batch_sources WHERE message_id IN (${input.sourceMessageIds.map(() => '?').join(',')}) LIMIT 1`).get(...input.sourceMessageIds) as { message_id: string } | undefined;
      if (alreadyBatched) throw new Error(`Source message ${alreadyBatched.message_id} is already in a frozen batch`);
      const eligible = this.db.prepare(`SELECT m.id,mp.status FROM messages m LEFT JOIN message_preparation mp ON mp.message_id=m.id LEFT JOIN hindsight_pending hp ON hp.message_id=m.id WHERE m.id IN (${input.sourceMessageIds.map(() => '?').join(',')}) AND hp.status='pending'`).all(...input.sourceMessageIds) as Array<{ id: string; status: string | null }>;
      if (eligible.length !== input.sourceMessageIds.length || eligible.some(row => row.status !== 'ready')) throw new Error('Batch sources must be pending and ready');
      if (!this.memoryWriteAllowed(input.channelId)) throw new Error('Memory writing is disabled for this channel');
      const order = Number((this.db.prepare('SELECT COALESCE(MAX(batch_order),0)+1 AS next FROM memory_batches WHERE document_id=?').get(input.documentId) as { next: number }).next);
      this.db.prepare("INSERT INTO memory_batches(operation_id,payload,source_message_ids,document_id,session_id,channel_id,batch_order,status,created_at) VALUES(?,?,?,?,?,?,?,'frozen',?)").run(operationId, input.payload, JSON.stringify(input.sourceMessageIds), input.documentId, input.sessionId, input.channelId, order, new Date().toISOString());
      const link = this.db.prepare('INSERT INTO memory_batch_sources(message_id,operation_id) VALUES(?,?)');
      for (const id of input.sourceMessageIds) link.run(id, operationId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.memoryBatch(operationId)!;
  }

  memoryBatch(operationId: string): MemoryBatch | undefined {
    const row = this.db.prepare('SELECT * FROM memory_batches WHERE operation_id=?').get(operationId) as any;
    return row && this.batchFromRow(row);
  }

  private batchFromRow(row: any): MemoryBatch {
    return { operationId: row.operation_id, payload: row.payload, sourceMessageIds: JSON.parse(row.source_message_ids), documentId: row.document_id, sessionId: row.session_id, channelId: row.channel_id, order: row.batch_order, status: row.status, ...(row.submit_intended_at ? { submitIntendedAt: row.submit_intended_at } : {}), ...(row.next_poll_at ? { nextPollAt: row.next_poll_at } : {}), ...(row.last_poll_at ? { lastPollAt: row.last_poll_at } : {}), ...(row.error ? { error: row.error } : {}) };
  }

  readyMemoryPrefixes(): Array<{ documentId: string; sessionId: string; channelId: string; messages: StoredMessage[] }> {
    const docs = this.db.prepare("SELECT DISTINCT s.channel_id,m.session_id FROM messages m JOIN message_sources s ON s.message_id=m.id JOIN hindsight_pending hp ON hp.message_id=m.id WHERE hp.status='pending' ORDER BY m.rowid").all() as Array<{ channel_id: string; session_id: string }>;
    return docs.flatMap(({ channel_id, session_id }) => {
      const all = this.messagesWithSources(session_id).filter(m => m.source.channelId === channel_id);
      const messages: StoredMessage[] = [];
      for (const m of all) {
        const pending = this.db.prepare("SELECT hp.status,mp.status preparation FROM hindsight_pending hp LEFT JOIN message_preparation mp ON mp.message_id=hp.message_id WHERE hp.message_id=?").get(m.id) as { status: string; preparation: string | null } | undefined;
        if (!pending || pending.status !== 'pending') continue;
        if (this.db.prepare('SELECT message_id FROM memory_batch_sources WHERE message_id=?').get(m.id)) continue;
        if (m.source.sourceKind === 'scheduled_input') { this.db.prepare("UPDATE hindsight_pending SET status='suppressed',updated_at=?,error='Scheduled instruction is not retained as conversation memory' WHERE message_id=? AND status='pending'").run(new Date().toISOString(),m.id); continue; }
        if(!this.memoryWriteAllowed(m.source.channelId)){this.db.prepare("UPDATE hindsight_pending SET status='suppressed',updated_at=?,error='Memory writing is disabled for this channel' WHERE message_id=? AND status='pending'").run(new Date().toISOString(),m.id);continue;}
        if (pending.preparation !== 'ready') break;
        messages.push(m); if (messages.length >= 25) break;
      }
      if (!messages.length) return [];
      return [{ documentId: `butler:discord:${channel_id}:${session_id}`, sessionId: session_id, channelId: channel_id, messages }];
    });
  }

  setMemorySubmitIntent(operationId: string): void { this.db.prepare("UPDATE memory_batches SET submit_intended_at=?,status='submitting' WHERE operation_id=? AND status='frozen' AND submit_intended_at IS NULL").run(new Date().toISOString(), operationId); }
  frozenNeverAttempted(): MemoryBatch[] { return (this.db.prepare("SELECT * FROM memory_batches WHERE status='frozen' AND submit_intended_at IS NULL ORDER BY created_at").all() as any[]).map(row => this.batchFromRow(row)); }
  updateMemoryBatch(operationId: string, status: MemoryBatch['status'], input: { error?: string; lastPollAt?: string; nextPollAt?: string } = {}): void {
    this.db.prepare('UPDATE memory_batches SET status=?,error=?,last_poll_at=COALESCE(?,last_poll_at),next_poll_at=? WHERE operation_id=?').run(status, input.error ?? null, input.lastPollAt ?? null, input.nextPollAt ?? null, operationId);
  }
  inFlightMemoryBatches(): MemoryBatch[] { return (this.db.prepare("SELECT * FROM memory_batches WHERE status IN ('submitting','unknown','pending','processing') ORDER BY created_at").all() as any[]).map(row => this.batchFromRow(row)); }
  blockingMemoryBatch(documentId: string): MemoryBatch | undefined { const row = this.db.prepare("SELECT * FROM memory_batches WHERE document_id=? AND status NOT IN ('completed','suppressed') ORDER BY batch_order LIMIT 1").get(documentId) as any; return row && this.batchFromRow(row); }
  completeMemoryBatch(operationId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE memory_batches SET status='completed',error=NULL,next_poll_at=NULL WHERE operation_id=?").run(operationId);
      this.db.prepare("UPDATE hindsight_pending SET status='completed',updated_at=?,error=NULL WHERE message_id IN (SELECT message_id FROM memory_batch_sources WHERE operation_id=?)").run(new Date().toISOString(), operationId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  clarifyMemoryBatch(operationId: string, resolution: 'completed' | 'failed' | 'cancelled' | 'not_found', note: string): void {
    if (resolution === 'completed') { this.completeMemoryBatch(operationId); return; }
    this.updateMemoryBatch(operationId, resolution, { error: note });
  }


  messages(session: string): Message[] {
    return this.db.prepare('SELECT role,content FROM messages WHERE session_id=? ORDER BY rowid').all(session) as unknown as Message[];
  }

  transcriptCandidates(start: string, end: string): TranscriptEntry[] {
    return this.db.prepare(`
      SELECT m.id,m.session_id AS sessionId,COALESCE(s.channel_id,'') AS channelId,
        COALESCE(s.discord_message_id,'') AS discordMessageId,COALESCE(s.author_id,'') AS authorId,
        COALESCE(s.author_name,s.author_id,'未知作者') AS authorName,
        COALESCE(s.event_time,m.created_at) AS timestamp,m.content
      FROM messages m JOIN message_sources s ON s.message_id=m.id
      WHERE m.role='user' AND s.source_kind='discord_external'
        AND julianday(COALESCE(s.event_time,m.created_at)) >= julianday(?)
        AND julianday(COALESCE(s.event_time,m.created_at)) < julianday(?)
        AND s.discord_message_id IS NOT NULL
      UNION ALL
      SELECT m.id,m.session_id AS sessionId,seg.channel_id AS channelId,
        seg.discord_message_id AS discordMessageId,COALESCE(s.author_id,'') AS authorId,
        COALESCE(s.author_name,s.author_id,'Butler') AS authorName,seg.created_at AS timestamp,seg.content
      FROM messages m JOIN message_sources s ON s.message_id=m.id
        JOIN discord_outgoing_segments seg ON seg.message_id=m.id
      WHERE m.role='assistant' AND s.source_kind IN ('butler_reply','butler_tool_message')
        AND julianday(seg.created_at) >= julianday(?) AND julianday(seg.created_at) < julianday(?)
      ORDER BY timestamp,sessionId,discordMessageId
    `).all(start, end, start, end) as unknown as TranscriptEntry[];
  }

  messagesWithSources(session: string): StoredMessage[] {
    const rows = this.db.prepare(`SELECT m.id,m.session_id,m.role,m.content,m.created_at,s.author_id,s.channel_id,s.discord_message_id,s.event_time,s.reply_to_message_id,s.reply_to_channel_id,s.webhook_id,s.source_kind,s.author_name,s.forwarded_message_json,s.is_bot,mp.status preparation
      FROM messages m LEFT JOIN message_sources s ON s.message_id=m.id LEFT JOIN message_preparation mp ON mp.message_id=m.id WHERE m.session_id=? ORDER BY m.rowid`).all(session) as Array<{ id: string; session_id: string; role: string; content: string; created_at: string; author_id: string | null; channel_id: string | null; discord_message_id: string | null; event_time: string | null; reply_to_message_id: string | null; reply_to_channel_id: string | null; webhook_id: string | null; source_kind: MessageSource['sourceKind'] | null; author_name: string | null; forwarded_message_json: string | null; is_bot: number | null; preparation: 'preparing' | 'ready' | null }>;
    const attachments = this.db.prepare('SELECT message_id,attachment_id,filename,mime_type,local_path,status,error,origin,memory_document_id,transcript,transcription_error FROM message_input_attachments WHERE message_id=?');
    const segments = this.db.prepare('SELECT channel_id,discord_message_id,content,created_at,reply_to_message_id,reply_to_channel_id FROM discord_outgoing_segments WHERE message_id=? ORDER BY rowid');
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, createdAt: row.created_at, preparationStatus: row.preparation ?? 'ready',
      source: { ...(row.author_id === null ? {} : { authorId: row.author_id }), ...(row.author_name === null ? {} : { authorName: row.author_name }), ...(row.is_bot === null ? {} : { isBot: row.is_bot === 1 }), ...(row.webhook_id === null ? {} : { webhookId: row.webhook_id }), ...(row.source_kind === null ? {} : { sourceKind: row.source_kind }), ...(row.channel_id === null ? {} : { channelId: row.channel_id }), ...(row.discord_message_id === null ? {} : { discordMessageId: row.discord_message_id }), ...(row.event_time === null ? {} : { eventTime: row.event_time }), ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }), ...(row.reply_to_channel_id === null ? {} : { replyToChannelId: row.reply_to_channel_id }), ...(row.forwarded_message_json === null ? {} : { forwardedMessage: JSON.parse(row.forwarded_message_json) as ForwardedMessage }) },
      attachments: (attachments.all(row.id) as Array<{ attachment_id: string; filename: string; mime_type: string; local_path: string | null; status: 'ready' | 'failed'; error: string | null; origin: 'discord_attachment' | 'butler_generated' | null; memory_document_id: string | null; transcript: string | null; transcription_error: string | null }>).map(item => ({ attachmentId: item.attachment_id, filename: item.filename, mimeType: item.mime_type, ...(item.local_path ? { localPath: projectPath(item.local_path) } : {}), status: item.status, ...(item.origin ? { origin: item.origin } : {}), ...(item.memory_document_id ? { memoryDocumentId: item.memory_document_id } : {}), ...(item.transcript ? { transcript: item.transcript } : {}), ...(item.transcription_error ? { transcriptionError: item.transcription_error } : {}), ...(item.error ? { error: item.error } : {}) })),
      discordSegments: (segments.all(row.id) as Array<{ channel_id: string; discord_message_id: string; content: string; created_at: string; reply_to_message_id: string | null; reply_to_channel_id: string | null }>).map(item => ({ channelId: item.channel_id, messageId: item.discord_message_id, content: item.content, eventTime: item.created_at, ...(item.reply_to_message_id ? { replyToMessageId: item.reply_to_message_id } : {}), ...(item.reply_to_channel_id ? { replyToChannelId: item.reply_to_channel_id } : {}) })) }));
  }

  sessionOpeningContext(sessionId: string): SessionOpeningContext | undefined {
    const row = this.db.prepare('SELECT channel_id,message_id,author_id,created_at,content,attachments_json FROM session_opening_context WHERE session_id=?').get(sessionId) as { channel_id: string; message_id: string; author_id: string; created_at: string; content: string; attachments_json: string } | undefined;
    return row && { channelId: row.channel_id, messageId: row.message_id, authorId: row.author_id, createdAt: row.created_at, content: row.content, attachments: JSON.parse(row.attachments_json) as SessionOpeningContext['attachments'] };
  }

  saveSessionOpeningContext(sessionId: string, context: SessionOpeningContext): void {
    this.db.prepare(`INSERT INTO session_opening_context(session_id,channel_id,message_id,author_id,created_at,content,attachments_json) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,author_id=excluded.author_id,created_at=excluded.created_at,content=excluded.content,attachments_json=excluded.attachments_json`).run(sessionId, context.channelId, context.messageId, context.authorId, context.createdAt, context.content, JSON.stringify(context.attachments));
  }

  // Per-ask context items exactly as first sent after their input message; later asks replay them so the prefix stays cacheable.
  saveAskContext(messageId: string, items: unknown[]): void {
    this.db.prepare('INSERT INTO ask_context(message_id,items_json) VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET items_json=excluded.items_json').run(messageId, JSON.stringify(items));
  }

  askContexts(messageIds: string[]): Map<string, unknown[]> {
    const select = this.db.prepare('SELECT items_json FROM ask_context WHERE message_id=?');
    const contexts = new Map<string, unknown[]>();
    for (const id of messageIds) { const row = select.get(id) as { items_json: string } | undefined; if (row) contexts.set(id, JSON.parse(row.items_json) as unknown[]); }
    return contexts;
  }

  saveContextUsage(sessionId: string, usage: { model: string; baseUrl: string; inputTokens: number; outputTokens: number; localCount: number; countSource: string; contextLimit: number; limitSource: string; sampledAt: string; attachmentSignature: string; checkpointThroughMessageId?: string }): void {
    this.db.prepare(`INSERT INTO session_context_usage(session_id,model,base_url,input_tokens,output_tokens,local_count,count_source,context_limit,limit_source,sampled_at,attachment_signature,checkpoint_through_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET model=excluded.model,base_url=excluded.base_url,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,local_count=excluded.local_count,count_source=excluded.count_source,context_limit=excluded.context_limit,limit_source=excluded.limit_source,sampled_at=excluded.sampled_at,attachment_signature=excluded.attachment_signature,checkpoint_through_message_id=excluded.checkpoint_through_message_id`).run(sessionId, usage.model, usage.baseUrl, usage.inputTokens, usage.outputTokens, usage.localCount, usage.countSource, usage.contextLimit, usage.limitSource, usage.sampledAt, usage.attachmentSignature, usage.checkpointThroughMessageId ?? null);
  }

  contextUsage(sessionId: string): { model: string; baseUrl: string; inputTokens: number; outputTokens: number; localCount: number; countSource: string; contextLimit: number; limitSource: string; sampledAt: string; attachmentSignature: string; checkpointThroughMessageId: string | null } | undefined {
    const row = this.db.prepare('SELECT model,base_url,input_tokens,output_tokens,local_count,count_source,context_limit,limit_source,sampled_at,attachment_signature,checkpoint_through_message_id FROM session_context_usage WHERE session_id=?').get(sessionId) as { model: string; base_url: string; input_tokens: number; output_tokens: number; local_count: number; count_source: string; context_limit: number; limit_source: string; sampled_at: string; attachment_signature: string; checkpoint_through_message_id: string | null } | undefined;
    return row && { model: row.model, baseUrl: row.base_url, inputTokens: row.input_tokens, outputTokens: row.output_tokens, localCount: row.local_count, countSource: row.count_source, contextLimit: row.context_limit, limitSource: row.limit_source, sampledAt: row.sampled_at, attachmentSignature: row.attachment_signature, checkpointThroughMessageId: row.checkpoint_through_message_id };
  }

  clearContextUsage(sessionId: string): void { this.db.prepare('DELETE FROM session_context_usage WHERE session_id=?').run(sessionId); }

  compactCheckpoint(sessionId: string): { summary: string; throughMessageId: string; updatedAt: string } | undefined {
    const row = this.db.prepare('SELECT summary,through_message_id,updated_at FROM session_compact_checkpoints WHERE session_id=?').get(sessionId) as { summary: string; through_message_id: string; updated_at: string } | undefined;
    return row && { summary: row.summary, throughMessageId: row.through_message_id, updatedAt: row.updated_at };
  }

  saveCompactCheckpoint(sessionId: string, summary: string, throughMessageId: string): void {
    this.db.prepare(`INSERT INTO session_compact_checkpoints(session_id,summary,through_message_id,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET summary=excluded.summary,through_message_id=excluded.through_message_id,updated_at=excluded.updated_at`).run(sessionId, summary, throughMessageId, new Date().toISOString());
    // Compaction already rewrites the history after the prefix, so the next ask re-reads the workspace files almost for free.
    this.db.prepare('DELETE FROM session_workspace WHERE session_id=?').run(sessionId);
  }

  // Workspace files as first read for this session; reused until compaction so edits to them do not invalidate the cached prefix every ask.
  workspaceSnapshot(sessionId: string): WorkspaceContext | undefined {
    const row = this.db.prepare('SELECT context_json FROM session_workspace WHERE session_id=?').get(sessionId) as { context_json: string } | undefined;
    return row && JSON.parse(row.context_json) as WorkspaceContext;
  }

  saveWorkspaceSnapshot(sessionId: string, context: WorkspaceContext): void {
    this.db.prepare('INSERT INTO session_workspace(session_id,context_json) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET context_json=excluded.context_json').run(sessionId, JSON.stringify(context));
  }

  createSubagentWindow(parentSessionId: string, model: string, cwd: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO subagent_windows(id,parent_session_id,model,cwd,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, parentSessionId, model, cwd, now, now);
    return id;
  }

  getSubagentWindow(id: string, parentSessionId: string): { id: string; parent_session_id: string; model: string; cwd: string; thread_id: string | null; created_at: string; updated_at: string } | undefined {
    return this.db.prepare('SELECT * FROM subagent_windows WHERE id=? AND parent_session_id=?').get(id, parentSessionId) as ReturnType<Store['getSubagentWindow']>;
  }

  setSubagentThread(id: string, threadId: string): void {
    const result = this.db.prepare('UPDATE subagent_windows SET thread_id=?,updated_at=? WHERE id=?').run(threadId, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error(`Could not persist subagent thread ${id}`);
  }

  setSubagentModel(id: string, model: string): void {
    const result = this.db.prepare('UPDATE subagent_windows SET model=?,updated_at=? WHERE id=?').run(model, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error(`Could not persist subagent model ${id}`);
  }

  enqueueSubagentMessage(id: string, message: string): string {
    const inboxId = randomUUID();
    this.db.prepare("INSERT INTO subagent_inbox(id,subagent_id,message,status,created_at) VALUES(?,?,?,'pending',?)").run(inboxId, id, message, new Date().toISOString());
    return inboxId;
  }

  pendingSubagentMessages(id: string): Array<{ id: string; message: string }> {
    return this.db.prepare("SELECT id,message FROM subagent_inbox WHERE subagent_id=? AND status='pending' ORDER BY created_at,rowid").all(id) as Array<{ id: string; message: string }>;
  }

  consumeSubagentInbox(id: string, messageIds: string[]): void {
    if (!messageIds.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = messageIds.map(messageId => this.db.prepare("SELECT id,message FROM subagent_inbox WHERE id=? AND subagent_id=? AND status='pending'").get(messageId, id) as { id: string; message: string } | undefined);
      if (rows.some(row => !row)) throw new Error('Subagent inbox changed before consumption');
      const mark = this.db.prepare("UPDATE subagent_inbox SET status='consumed',consumed_at=? WHERE id=? AND subagent_id=? AND status='pending'");
      for (const messageId of messageIds) mark.run(new Date().toISOString(), messageId, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveSubagentRun(snapshot: { id: string; parentSession: string; runId: string; status: string; updatedAt: string }): void {
    this.db.prepare('INSERT INTO subagent_runs(id,parent_session_id,run_id,status,snapshot_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at WHERE subagent_runs.parent_session_id=excluded.parent_session_id AND (subagent_runs.run_id=excluded.run_id OR excluded.status=\'queued\')')
      .run(snapshot.id, snapshot.parentSession, snapshot.runId, snapshot.status, JSON.stringify(snapshot), snapshot.updatedAt);
  }

  allSubagentRuns(): Array<Record<string, unknown>> {
    return (this.db.prepare('SELECT snapshot_json FROM subagent_runs ORDER BY updated_at DESC').all() as Array<{ snapshot_json: string }>).map(row => JSON.parse(row.snapshot_json) as Record<string, unknown>);
  }

  acceptNotification(payload: NotificationPayload): { duplicate: boolean; status: NotificationStatus } {
    const { id, source, title, body, occurred_at } = payload;
    const content = JSON.stringify({ id, source, title, body, occurred_at });
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT payload_json,status FROM notification_events WHERE id=?').get(id) as { payload_json: string; status: NotificationStatus } | undefined;
      if (existing && existing.payload_json !== content) throw new NotificationConflictError();
      if (!existing) this.db.prepare("INSERT INTO notification_events(id,payload_json,status,created_at,updated_at) VALUES(?,?,'pending',?,?)").run(id, content, now, now);
      this.db.exec('COMMIT');
      return { duplicate: Boolean(existing), status: existing?.status ?? 'pending' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  notificationEvent(id: string): NotificationEvent | undefined {
    const row = this.db.prepare('SELECT * FROM notification_events WHERE id=?').get(id) as { id: string; payload_json: string; input_message_id: string | null; status: NotificationStatus } | undefined;
    return row ? { id: row.id, payload: JSON.parse(row.payload_json) as NotificationPayload, inputMessageId: row.input_message_id ?? undefined, status: row.status } : undefined;
  }

  pendingNotificationIds(): string[] {
    return (this.db.prepare("SELECT id FROM notification_events WHERE status='pending' ORDER BY rowid").all() as Array<{ id: string }>).map(row => row.id);
  }

  claimNotification(id: string, session: string, channelId: string): StoredMessage | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.notificationEvent(id);
      if (!event || event.status !== 'pending') { this.db.exec('COMMIT'); return undefined; }
      if (!this.hasSession(session)) throw new Error('Unknown notification session');
      const inputId = randomUUID();
      const now = new Date().toISOString();
      const content = JSON.stringify(event.payload);
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(inputId, session, 'user', content, now);
      this.db.prepare('INSERT INTO message_sources(message_id,channel_id,event_time,source_kind) VALUES(?,?,?,?)').run(inputId, channelId, event.payload.occurred_at, 'notification');
      this.db.prepare("INSERT INTO message_preparation(message_id,status,updated_at) VALUES(?,'ready',?)").run(inputId, now);
      this.db.prepare("UPDATE notification_events SET status='processing',input_message_id=?,updated_at=? WHERE id=? AND status='pending'").run(inputId, now, id);
      this.db.exec('COMMIT');
      return { id: inputId, sessionId: session, role: 'user', content, createdAt: now, source: { sourceKind: 'notification', channelId, eventTime: event.payload.occurred_at }, attachments: [], preparationStatus: 'ready', discordSegments: [] };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finishNotification(id: string, status: 'completed' | 'unknown'): void {
    const result = this.db.prepare("UPDATE notification_events SET status=?,updated_at=? WHERE id=? AND status='processing'").run(status, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error('Notification state changed before completion');
  }

  saveSubagentEvent(event: { id: string; runId: string; subagentId: string; parentSession: string; parentInputId?: string; message: string; kind?: string; status: string }): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO subagent_events(id,run_id,subagent_id,parent_session_id,parent_input_id,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(event.id, event.runId, event.subagentId, event.parentSession, event.parentInputId ?? null, JSON.stringify({ message: event.message, kind: event.kind }), event.status, now, now);
  }

  pendingSubagentEvents(): Array<{ id: string; runId: string; subagentId: string; parentSession: string; parentInputId?: string; message: string; kind?: string; status: string }> {
    return (this.db.prepare("SELECT id,run_id,subagent_id,parent_session_id,parent_input_id,payload_json,status FROM subagent_events WHERE status IN ('pending','failed_unknown') ORDER BY created_at,rowid").all() as Array<{ id: string; run_id: string; subagent_id: string; parent_session_id: string; parent_input_id: string | null; payload_json: string; status: string }>).map(row => {
      const payload = JSON.parse(row.payload_json) as { message: string; kind?: string };
      return { id: row.id, runId: row.run_id, subagentId: row.subagent_id, parentSession: row.parent_session_id, ...(row.parent_input_id ? { parentInputId: row.parent_input_id } : {}), ...payload, status: row.status };
    });
  }

  subagentEventInput(eventId: string, session: string, content: string, source: MessageSource): StoredMessage {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.db.prepare('SELECT parent_input_id FROM subagent_events WHERE id=? AND parent_session_id=?').get(eventId, session) as { parent_input_id: string | null } | undefined;
      if (!event) throw new Error('Unknown subagent event');
      const existing = event.parent_input_id ? this.messagesWithSources(session).find(message => message.id === event.parent_input_id) : undefined;
      let input = existing;
      if (!input) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(id, session, 'user', content, now);
        this.db.prepare('INSERT INTO message_sources(message_id,author_id,channel_id,event_time,source_kind) VALUES(?,?,?,?,?)').run(id, source.authorId ?? null, source.channelId ?? null, now, 'subagent_event');
        this.db.prepare("INSERT INTO message_preparation(message_id,status,updated_at) VALUES(?,'ready',?)").run(id, now);
        input = { id, sessionId: session, role: 'user', content, createdAt: now, source: { ...source, sourceKind: 'subagent_event' }, attachments: [], preparationStatus: 'ready', discordSegments: [] };
      }
      this.db.prepare('UPDATE subagent_events SET parent_input_id=? WHERE id=?').run(input.id, eventId);
      this.db.exec('COMMIT');
      return input;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setSubagentEventStatus(id: string, expected: 'pending' | 'processing', status: 'processing' | 'delivered' | 'failed_unknown'): boolean {
    const result = this.db.prepare('UPDATE subagent_events SET status=?,updated_at=? WHERE id=? AND status=?').run(status, new Date().toISOString(), id, expected);
    return Number(result.changes) === 1;
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

  // Private diagnostic snapshots: retain at most 1,000 requests and 24 hours.
  saveModelRequest(record: { requestId: string; sessionId: string; askId?: string; traceId?: string; turn: number; bodyJson: string; bodySha256: string }, attemptedAt = new Date().toISOString()): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO model_requests(request_id,session_id,ask_id,trace_id,turn,attempted_at,body_json,body_sha256) VALUES(?,?,?,?,?,?,?,?)')
        .run(record.requestId, record.sessionId, record.askId ?? null, record.traceId ?? null, record.turn, attemptedAt, record.bodyJson, record.bodySha256);
      this.db.prepare('DELETE FROM model_requests WHERE attempted_at < ? OR rowid NOT IN (SELECT rowid FROM model_requests ORDER BY rowid DESC LIMIT 1000)')
        .run(new Date(Date.parse(attemptedAt) - 24 * 60 * 60 * 1000).toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finishModelRequest(requestId: string, result: { httpStatus?: number; usage?: unknown; errorType?: string }): void {
    this.db.prepare('UPDATE model_requests SET finished_at=?,http_status=?,usage_json=?,error_type=? WHERE request_id=?')
      .run(new Date().toISOString(), result.httpStatus ?? null, result.usage === undefined ? null : JSON.stringify(result.usage), result.errorType ?? null, requestId);
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

  knownChannelIds(): string[] {
    return [...new Set([...Object.keys(this.settings.current().channels), ...(this.db.prepare('SELECT channel_id FROM channel_state').all() as Array<{channel_id:string}>).map(row => row.channel_id)])];
  }

  isTrackedChannel(channelId: string): boolean { return this.alertChannelIds.has(channelId) || Object.hasOwn(this.settings.current().channels, channelId); }

  channelPolicy(channelId: string): ChannelPolicy | undefined {
    const config=this.settings.current().channels[channelId];
    if(!config)return undefined;
    return {channelId,botReply:(config.botReply as boolean|null|undefined)??null,hindsightWrite:(config.hindsightWrite as boolean|null|undefined)??null};
  }

  setAlertChannelIds(ids: string[], model?: string): void {
    this.alertModel = model;
    const next = new Set(ids);
    const channels = this.settings.current().channels;
    const overlap = [...next].filter(id => Object.hasOwn(channels, id));
    if (overlap.length) throw new SettingsConflictError(`Alert channels cannot have general channel settings: ${overlap.join(', ')}`);
    const previous = this.alertChannelIds;
    const changed = [...new Set([...previous, ...next])].filter(id => previous.has(id) !== next.has(id));
    if (!changed.length) return;
    const stopped = [...previous].filter(id => !next.has(id) && !Object.hasOwn(channels, id));
    const blocked = stopped.filter(id => this.externalStopHooks && !this.externalStopHooks.canStop(id));
    if (blocked.length) throw new SettingsConflictError(`Cannot stop tracking while channel work is active: ${blocked.join(', ')}`);
    this.db.exec('BEGIN IMMEDIATE');
    this.alertChannelIds = next;
    try {
      for (const id of stopped) this.archiveChannelSession(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.alertChannelIds = previous;
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  isAlertChannel(channelId: string, _parentChannelId?: string): boolean { return this.alertChannelIds.has(channelId); }

  effectiveChannelPolicy(channelId:string,_parentChannelId?:string):EffectiveChannelPolicy {
    if (this.alertChannelIds.has(channelId)) return { tracked:true, botReply:true, hindsightWrite:true, replyMode:'all', mode:'steer' };
    const config = this.settings.current().channels[channelId];
    const tracked = Object.hasOwn(this.settings.current().channels, channelId);
    const bool = (key: 'botReply'|'hindsightWrite', fallback: boolean) => typeof config?.[key] === 'boolean' ? config[key] as boolean : fallback;
    return { tracked, botReply:bool('botReply',false), hindsightWrite:bool('hindsightWrite',false), replyMode:this.channelReplyMode(channelId) ?? 'mention', mode:this.channelModeOverride(channelId) ?? 'steer' };
  }

  setChannelPolicy(channelId:string,patch:Partial<Pick<ChannelPolicy,'botReply'|'hindsightWrite'>>):ChannelPolicy {
    this.settings.patchChannel(channelId,patch as Record<string,unknown>);
    return this.channelPolicy(channelId)!;
  }

  // Counts a web provider request against its daily limit (UTC date); false when the limit is reached.
  reserveWebRequest(provider: string, limit: number): boolean {
    const date = new Date().toISOString().slice(0, 10);
    const used = (this.db.prepare('SELECT requests FROM web_usage WHERE provider=? AND date=?').get(provider, date) as { requests: number } | undefined)?.requests ?? 0;
    if (used >= limit) return false;
    this.db.prepare('INSERT INTO web_usage(provider,date,requests) VALUES(?,?,1) ON CONFLICT(provider,date) DO UPDATE SET requests=requests+1').run(provider, date);
    return true;
  }

  memoryWriteAllowed(channelId: string | undefined): boolean {
    if (!channelId) return false;
    const policy = this.effectiveChannelPolicy(channelId);
    return policy.tracked && policy.hindsightWrite;
  }

  channelSettings(channelId:string,defaultModel:string):{sessionId?:string;model:string} {
    const row=this.db.prepare('SELECT session_id FROM channel_state WHERE channel_id=?').get(channelId) as {session_id:string}|undefined;
    return { ...(row?{sessionId:row.session_id}:{}), model: this.effectiveChannelModel(channelId, defaultModel) };
  }

  effectiveChannelModel(channelId: string, defaultModel: string): string { return this.isAlertChannel(channelId) ? this.alertModel ?? defaultModel : this.channelModelOverride(channelId) ?? defaultModel; }

  effectiveChannelReasoningEffort(channelId: string): ReasoningEffort | undefined { return this.isAlertChannel(channelId) ? undefined : this.channelReasoningEffort(channelId); }

  effectiveChannelImageModel(channelId: string): string | undefined { return this.isAlertChannel(channelId) ? undefined : this.channelImageModel(channelId); }

  channelState(channelId: string, defaultModel: string, ownerId = 'unknown'): { sessionId: string; model: string } {
    const row = this.db.prepare('SELECT session_id FROM channel_state WHERE channel_id=?').get(channelId) as { session_id: string } | undefined;
    if (row) return { sessionId: row.session_id, model: this.effectiveChannelModel(channelId, defaultModel) };
    const sessionId = this.newSession();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO channel_state(channel_id,session_id,model) VALUES(?,?,NULL)').run(channelId, sessionId);
      this.db.prepare("INSERT INTO session_sources VALUES(?,?,'owner',?,'')").run(sessionId, channelId, ownerId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { sessionId, model: this.effectiveChannelModel(channelId, defaultModel) };
  }

  setChannelSession(channelId: string, sessionId: string, ownerId = 'unknown'): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE channel_state SET session_id=? WHERE channel_id=?').run(sessionId, channelId);
      this.db.prepare("INSERT OR IGNORE INTO session_sources VALUES(?,?,'owner',?,'')").run(sessionId, channelId, ownerId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setChannelModel(channelId: string, model: string | null): void { this.settings.patchChannel(channelId,{model}); }
  channelModelOverride(channelId:string):string|null|undefined { const config=this.settings.current().channels[channelId];return config&&Object.hasOwn(config,'model')?config.model as string|null:undefined; }
  archiveChannelSession(channelId:string):boolean { return Number(this.db.prepare('DELETE FROM channel_state WHERE channel_id=?').run(channelId).changes)===1; }
  channelModeOverride(channelId: string): 'queue' | 'steer' | undefined { return (this.settings.current().channels[channelId]?.mode as 'queue'|'steer'|null|undefined)??undefined; }
  channelMode(channelId: string): 'queue' | 'steer' { return this.effectiveChannelPolicy(channelId).mode; }
  setChannelMode(channelId: string, mode: 'queue' | 'steer' | undefined): void { this.settings.patchChannel(channelId,{mode}); }

  // The /restart interaction whose ephemeral reply is edited once Butler is back.
  setRestartNotice(notice: { applicationId: string; interactionToken: string } | null): void {
    if (notice === null) this.db.prepare('DELETE FROM restart_notice WHERE id=1').run();
    else this.db.prepare('INSERT INTO restart_notice(id,application_id,interaction_token) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET application_id=excluded.application_id,interaction_token=excluded.interaction_token').run(notice.applicationId, notice.interactionToken);
  }

  // Written by scripts/butler-deploy.mjs before it starts a build; the started Butler posts and clears it.
  takeDeployNotice(): { channelId: string; text: string } | undefined {
    const row = this.db.prepare('DELETE FROM deploy_notice WHERE id=1 RETURNING channel_id,text').get() as { channel_id: string; text: string } | undefined;
    return row && { channelId: row.channel_id, text: row.text };
  }

  hledgerSchedules(): unknown[] {
    return (this.db.prepare('SELECT schedule_json FROM hledger_schedules ORDER BY id').all() as Array<{ schedule_json: string }>).map(row => JSON.parse(row.schedule_json));
  }

  saveHledgerSchedules(schedules: Array<{ id: string }>): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM hledger_schedules');
      const insert = this.db.prepare('INSERT INTO hledger_schedules(id,schedule_json) VALUES(?,?)');
      for (const schedule of schedules) insert.run(schedule.id, JSON.stringify(schedule));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  takeRestartNotice(): { applicationId: string; interactionToken: string } | undefined {
    const row = this.db.prepare('DELETE FROM restart_notice WHERE id=1 RETURNING application_id,interaction_token').get() as { application_id: string; interaction_token: string } | undefined;
    return row && { applicationId: row.application_id, interactionToken: row.interaction_token };
  }

  attachmentDelivery(toolCallId: string): unknown {
    return this.db.prepare('SELECT status,updated_at FROM attachment_deliveries WHERE tool_call_id=?').get(toolCallId) ?? null;
  }

  updateAttachmentDelivery(toolCallIds: string[], status: 'delivered' | 'failed_or_unknown' | 'not_sent'): void {
    const update = this.db.prepare('INSERT INTO attachment_deliveries(tool_call_id,status,updated_at) VALUES(?,?,?) ON CONFLICT(tool_call_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at');
    for (const id of toolCallIds) update.run(id, status, new Date().toISOString());
  }

  effectiveReplyMode(channelId: string, parentChannelId?: string): ChannelReplyMode { return this.effectiveChannelPolicy(channelId, parentChannelId).replyMode; }

  channelReplyMode(channelId:string):ChannelReplyMode|undefined { return (this.settings.current().channels[channelId]?.replyMode as ChannelReplyMode|null|undefined)??undefined; }
  setChannelReplyMode(channelId:string,mode:ChannelReplyMode|undefined):void { this.settings.patchChannel(channelId,{replyMode:mode}); }
  channelReasoningEffort(channelId:string):ReasoningEffort|undefined { return (this.settings.current().channels[channelId]?.effort as ReasoningEffort|null|undefined)??undefined; }
  setChannelReasoningEffort(channelId:string,effort:ReasoningEffort|undefined):void { this.settings.patchChannel(channelId,{effort}); }
  channelImageModel(channelId:string):string|undefined { return (this.settings.current().channels[channelId]?.imageModel as string|null|undefined)??undefined; }
  channelMemoryBank(channelId:string):string|undefined { return (this.settings.current().channels[channelId]?.memoryBank as string|null|undefined)??undefined; }
  setChannelImageModel(channelId:string,model:string|undefined):void { this.settings.patchChannel(channelId,{imageModel:model}); }

  createSchedule(job:ScheduleJob):ScheduleJob { this.settings.refresh();if(this.getSchedule(job.id))throw new SettingsConflictError(`Schedule ${job.id} already exists`);this.settings.upsertSchedule(job);this.db.prepare('UPDATE schedule_runtime SET next_run=? WHERE job_id=?').run(job.nextRun,job.id);return this.getSchedule(job.id)!; }
  getSchedule(id:string):ScheduleJob|undefined { const snapshot=this.settings.current();const job=[...snapshot.crons,...snapshot.reminders].find(item=>item.id===id);if(!job)return undefined;const runtime=this.db.prepare('SELECT next_run FROM schedule_runtime WHERE job_id=?').get(id) as {next_run:string|null}|undefined;return {...job,nextRun:runtime?runtime.next_run:null}; }
  listSchedules():ScheduleJob[] { const snapshot=this.settings.current();return [...snapshot.crons,...snapshot.reminders].map(job=>this.getSchedule(job.id)!).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)); }
  updateSchedule(id:string,patch:Partial<Pick<ScheduleJob,'outputChannelId'|'content'|'cron'|'runAt'|'timezone'|'enabled'|'nextRun'|'notify'>>):ScheduleJob|undefined { this.settings.refresh();const current=this.getSchedule(id);if(!current)return undefined;const {nextRun,...definitionPatch}=patch;if(Object.keys(definitionPatch).length)this.settings.patchSchedule(id,{...definitionPatch,updatedAt:new Date().toISOString()});if(Object.hasOwn(patch,'nextRun'))this.db.prepare('UPDATE schedule_runtime SET next_run=? WHERE job_id=?').run(nextRun??null,id);return this.getSchedule(id); }
  deleteSchedule(id:string):boolean { return Boolean(this.settings.deleteSchedule(id)); }

  claimScheduleRun(id:string,scheduledAt:string,nextRun:string|null,now:string):{job:ScheduleJob;run:ScheduleRun}|undefined {
    this.db.exec('BEGIN IMMEDIATE');try{const job=this.getSchedule(id);const row=this.db.prepare('SELECT next_run FROM schedule_runtime WHERE job_id=?').get(id) as {next_run:string|null}|undefined;if(!job||!job.enabled||!row||row.next_run!==scheduledAt||scheduledAt>now){this.db.exec('COMMIT');return undefined;}const run:ScheduleRun={id:randomUUID(),jobId:id,scheduledAt,status:'running',claimedAt:now,finishedAt:null,error:null};try{this.db.prepare('INSERT INTO schedule_runs(id,job_id,scheduled_at,status,claimed_at) VALUES(?,?,?,?,?)').run(run.id,id,scheduledAt,'running',now);}catch(error){if(error instanceof Error&&/UNIQUE constraint failed: schedule_runs\.job_id, schedule_runs\.scheduled_at/.test(error.message)){this.db.exec('ROLLBACK');return undefined;}throw error;}const updated=this.db.prepare('UPDATE schedule_runtime SET next_run=? WHERE job_id=? AND next_run=?').run(nextRun,id,scheduledAt);if(Number(updated.changes)!==1)throw new Error(`Could not advance schedule ${id}`);this.db.exec('COMMIT');return {job:{...job,nextRun},run};}catch(error){this.db.exec('ROLLBACK');throw error;}
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
    return this.listSchedules().filter(job=>job.enabled&&job.nextRun!==null&&job.nextRun<=now&&(job.kind!=='reminder'||!this.db.prepare('SELECT 1 FROM schedule_runs WHERE job_id=? AND scheduled_at=?').get(job.id,job.nextRun))).sort((a,b)=>a.nextRun!.localeCompare(b.nextRun!)||a.id.localeCompare(b.id));
  }

  finishScheduleRun(runId: string, status: 'completed' | 'failed', error?: string): void {
    const result = this.db.prepare("UPDATE schedule_runs SET status=?,finished_at=?,error=? WHERE id=? AND status='running'").run(status, new Date().toISOString(), error ?? null, runId);
    if (Number(result.changes) !== 1) throw new Error(`Could not persist schedule execution result for ${runId}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settings.close(); this.db.close(); if(this.ownedSettingsDirectory)rmSync(this.ownedSettingsDirectory,{recursive:true,force:true});
  }
}
