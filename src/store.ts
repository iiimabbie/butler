import { logError } from './log.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScheduleJob, ScheduleRun, SchedulerStore } from './scheduler.js';
import type { TranscriptEntry } from './journal-transcript.js';

export type ChannelReplyMode = 'all' | 'mention' | 'none';
export interface ChannelPolicy { channelId: string; parentChannelId: string | null; tracked: boolean | null; botReply: boolean | null; hindsightWrite: boolean | null; revision: number; }
export interface EffectiveChannelPolicy { tracked: boolean; botReply: boolean; hindsightWrite: boolean; replyMode: ChannelReplyMode; trackedSource: string; botReplySource: string; hindsightWriteSource: string; replyModeSource: string; }
export interface MemoryWriteToken { originChannelId: string; sourceChannelId: string; originPolicyChannelId: string; originRevision: number; sourcePolicyChannelId: string; sourceRevision: number; }
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'auto';

export interface Message {
  role: string;
  content: string;
}

export interface ForwardedMessage { authorId?: string; authorName?: string; channelId?: string; discordMessageId?: string; eventTime?: string; content?: string; }
export interface MessageSource {
  authorId?: string; authorName?: string; isBot?: boolean; webhookId?: string; sourceKind?: 'discord_external' | 'butler_reply' | 'butler_tool_message' | 'scheduled_input' | 'subagent_event' | 'deployment_result' | 'unknown'; channelId?: string; discordMessageId?: string; eventTime?: string; replyToMessageId?: string; replyToChannelId?: string; forwardedMessage?: ForwardedMessage;
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

type ScheduleDbRow = { id: string; output_channel_id: string; creator_id: string; kind: 'cron' | 'reminder'; content: string; cron: string | null; run_at: string | null; timezone: string; enabled: number; next_run: string | null; created_at: string; updated_at: string };
type ScheduleRunDbRow = { id: string; job_id: string; scheduled_at: string; status: 'running' | 'completed' | 'failed' | 'unknown'; claimed_at: string; finished_at: string | null; error: string | null };

function scheduleFromRow(row: ScheduleDbRow): ScheduleJob {
  return { id: row.id, outputChannelId: row.output_channel_id, creatorId: row.creator_id, kind: row.kind, content: row.content, cron: row.cron, runAt: row.run_at, timezone: row.timezone, enabled: row.enabled === 1, nextRun: row.next_run, createdAt: row.created_at, updatedAt: row.updated_at };
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

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sortJsonValue(item)]));
  return value;
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
      CREATE TABLE IF NOT EXISTS message_input_attachments(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attachment_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, local_path TEXT, status TEXT NOT NULL CHECK(status IN ('ready','failed')), error TEXT, origin TEXT, memory_document_id TEXT, transcript TEXT, transcription_error TEXT, PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS attachment_memory_jobs(message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, document_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('queued','submitting','converting','retaining','completed','failed','unknown','suppressed')), conversion_operation_id TEXT, retain_operation_id TEXT, attempted_at TEXT, next_poll_at TEXT, poll_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS message_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, author_id TEXT, channel_id TEXT, discord_message_id TEXT, event_time TEXT, reply_to_message_id TEXT, reply_to_channel_id TEXT, webhook_id TEXT, source_kind TEXT, author_name TEXT, forwarded_message_json TEXT, is_bot INTEGER);
      CREATE TABLE IF NOT EXISTS hindsight_pending(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS discord_outgoing_segments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, discord_message_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, created_at TEXT NOT NULL, reply_to_message_id TEXT, reply_to_channel_id TEXT);
      CREATE TABLE IF NOT EXISTS message_preparation(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('preparing','ready')), updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_batches(operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source_message_ids TEXT NOT NULL, document_id TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, batch_order INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('frozen','submitting','unknown','pending','processing','completed','failed','cancelled','not_found','needs_clarification','suppressed')), submit_intended_at TEXT, last_poll_at TEXT, next_poll_at TEXT, error TEXT, created_at TEXT NOT NULL, UNIQUE(document_id,batch_order));
      CREATE TABLE IF NOT EXISTS memory_batch_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, operation_id TEXT NOT NULL REFERENCES memory_batches(operation_id));
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS subagent_windows(id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, model TEXT NOT NULL, input_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subagent_runs(id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subagent_inbox(id TEXT PRIMARY KEY, subagent_id TEXT NOT NULL REFERENCES subagent_windows(id) ON DELETE CASCADE, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','consumed')), created_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS subagent_events(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, subagent_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, parent_input_id TEXT, question_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','processing','delivered','failed_unknown')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deployment_requests(id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, requester_id TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted','needs_reconciliation')), result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_one_active_idx ON deployment_requests((1)) WHERE status IN ('queued','running','needs_reconciliation');
      CREATE TABLE IF NOT EXISTS deployment_result_events(id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL UNIQUE REFERENCES deployment_requests(id), status TEXT NOT NULL CHECK(status IN ('pending','processing','delivered','failed_unknown','needs_reconciliation')), parent_input_id TEXT, delivery_message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, target_version TEXT, claimed_version TEXT, parent_input_version TEXT, delivered_version TEXT, send_attempt_id TEXT, send_phase TEXT);
      CREATE TABLE IF NOT EXISTS channel_state(channel_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT);
      CREATE TABLE IF NOT EXISTS channel_modes(channel_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('queue','steer')));
      CREATE TABLE IF NOT EXISTS restart_notice(id INTEGER PRIMARY KEY CHECK(id=1), channel_id TEXT NOT NULL, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_actions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, buttons TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_action_claims(custom_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL, result TEXT, claimed_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS attachment_deliveries(tool_call_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_settings(id INTEGER PRIMARY KEY CHECK(id=1), bot_reply INTEGER NOT NULL CHECK(bot_reply IN (0,1)));
      CREATE TABLE IF NOT EXISTS session_sources(session_id TEXT NOT NULL, channel_id TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('owner','bot')), owner_id TEXT NOT NULL, bot_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(session_id,channel_id,source_type,owner_id,bot_id));
      CREATE TABLE IF NOT EXISTS latest_cpa_request(id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL, attempted_at TEXT NOT NULL, body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, output_channel_id TEXT NOT NULL, creator_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cron','reminder')), content TEXT NOT NULL, cron TEXT, run_at TEXT, timezone TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled,next_run);
      CREATE TABLE IF NOT EXISTS schedule_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','unknown')), claimed_at TEXT NOT NULL, finished_at TEXT, error TEXT, UNIQUE(job_id,scheduled_at));
      CREATE INDEX IF NOT EXISTS schedule_runs_status_idx ON schedule_runs(status);
      CREATE TABLE IF NOT EXISTS channel_reply_modes(channel_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('all','mention','none')));
      CREATE TABLE IF NOT EXISTS channel_reasoning_efforts(channel_id TEXT PRIMARY KEY, effort TEXT NOT NULL CHECK(effort IN ('none','minimal','low','medium','high','xhigh','auto')));
      CREATE TABLE IF NOT EXISTS channel_image_models(channel_id TEXT PRIMARY KEY, model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_compact_checkpoints(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, summary TEXT NOT NULL, through_message_id TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_opening_context(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL, attachments_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_context_usage(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, model TEXT NOT NULL, base_url TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, local_count INTEGER NOT NULL, count_source TEXT NOT NULL DEFAULT 'local-count-estimate', context_limit INTEGER NOT NULL, limit_source TEXT NOT NULL, sampled_at TEXT NOT NULL, attachment_signature TEXT NOT NULL, checkpoint_through_message_id TEXT);
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS channel_policies(channel_id TEXT PRIMARY KEY,parent_channel_id TEXT,tracked INTEGER CHECK(tracked IN (0,1)),bot_reply INTEGER CHECK(bot_reply IN (0,1)),hindsight_write INTEGER CHECK(hindsight_write IN (0,1)),revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS channel_model_overrides(channel_id TEXT PRIMARY KEY,model TEXT); CREATE TABLE IF NOT EXISTS message_memory_tokens(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,token_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_policy_migrations(name TEXT PRIMARY KEY,completed_at TEXT NOT NULL);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const scheduleColumns = new Set((this.db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>).map(column => column.name));
    if (scheduleColumns.has('source_channel_id')) this.db.exec('ALTER TABLE schedules DROP COLUMN source_channel_id');
    const jobColumns = new Set((this.db.prepare('PRAGMA table_info(attachment_memory_jobs)').all() as Array<{ name: string }>).map(column => column.name));
    if (jobColumns.size && !String((this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachment_memory_jobs'").get() as {sql:string}|undefined)?.sql??'').includes("'suppressed'")) {
      this.db.exec(`ALTER TABLE attachment_memory_jobs RENAME TO attachment_memory_jobs_old; CREATE TABLE attachment_memory_jobs(message_id TEXT NOT NULL,attachment_id TEXT NOT NULL,document_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('queued','submitting','converting','retaining','completed','failed','unknown','suppressed')),conversion_operation_id TEXT,retain_operation_id TEXT,attempted_at TEXT,next_poll_at TEXT,poll_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(message_id,attachment_id)); INSERT INTO attachment_memory_jobs SELECT * FROM attachment_memory_jobs_old; DROP TABLE attachment_memory_jobs_old;`);
    }
    const batchColumnsBeforeMigration=new Set((this.db.prepare('PRAGMA table_info(memory_batches)').all() as Array<{name:string}>).map(column=>column.name));
    if(batchColumnsBeforeMigration.has('deadline'))this.db.exec('ALTER TABLE memory_batches DROP COLUMN deadline');
    const batchSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_batches'").get() as {sql:string}).sql;
    if (!batchSql.includes("'suppressed'")) {
      this.db.exec(`ALTER TABLE memory_batch_sources RENAME TO memory_batch_sources_old; ALTER TABLE memory_batches RENAME TO memory_batches_old; CREATE TABLE memory_batches(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,source_message_ids TEXT NOT NULL,document_id TEXT NOT NULL,session_id TEXT NOT NULL,channel_id TEXT NOT NULL,batch_order INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('frozen','submitting','unknown','pending','processing','completed','failed','cancelled','not_found','needs_clarification','suppressed')),submit_intended_at TEXT,last_poll_at TEXT,next_poll_at TEXT,error TEXT,created_at TEXT NOT NULL,UNIQUE(document_id,batch_order)); INSERT INTO memory_batches SELECT * FROM memory_batches_old; CREATE TABLE memory_batch_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,operation_id TEXT NOT NULL REFERENCES memory_batches(operation_id)); INSERT INTO memory_batch_sources SELECT * FROM memory_batch_sources_old; DROP TABLE memory_batch_sources_old; DROP TABLE memory_batches_old;`);
    }
    const replySql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_reply_modes'").get() as {sql:string}).sql;
    if (!replySql.includes("'none'")) {
      this.db.exec(`ALTER TABLE channel_reply_modes RENAME TO channel_reply_modes_old; CREATE TABLE channel_reply_modes(channel_id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN ('all','mention','none'))); INSERT INTO channel_reply_modes SELECT * FROM channel_reply_modes_old; DROP TABLE channel_reply_modes_old;`);
    }
    const deploymentEventColumns = new Set((this.db.prepare('PRAGMA table_info(deployment_result_events)').all() as Array<{ name: string }>).map(column => column.name));
    for (const [name, definition] of [['target_version', 'TEXT'], ['claimed_version', 'TEXT'], ['parent_input_version', 'TEXT'], ['delivered_version', 'TEXT'], ['send_attempt_id', 'TEXT'], ['send_phase', 'TEXT']] as const) {
      if (!deploymentEventColumns.has(name)) this.db.exec(`ALTER TABLE deployment_result_events ADD COLUMN ${name} ${definition}`);
    }
    // Existing events are baselined without replay: their current parent result is the known target.
    for (const row of this.db.prepare('SELECT e.id,e.status,r.status AS result_status,r.result_json FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id WHERE e.target_version IS NULL').all() as Array<{id:string;status:string;result_status:string;result_json:string|null}>) {
      const version=this.deploymentResultVersion(row.result_status,row.result_json);
      this.db.prepare('UPDATE deployment_result_events SET target_version=?,delivered_version=CASE WHEN status=\'delivered\' THEN ? ELSE delivered_version END WHERE id=?').run(version,version,row.id);
    }
    const attachmentColumns = new Set((this.db.prepare('PRAGMA table_info(message_input_attachments)').all() as Array<{ name: string }>).map(column => column.name));
    if (!attachmentColumns.has('origin')) this.db.exec('ALTER TABLE message_input_attachments ADD COLUMN origin TEXT');
    if (!attachmentColumns.has('memory_document_id')) this.db.exec('ALTER TABLE message_input_attachments ADD COLUMN memory_document_id TEXT');
    if (!attachmentColumns.has('transcript')) this.db.exec('ALTER TABLE message_input_attachments ADD COLUMN transcript TEXT');
    if (!attachmentColumns.has('transcription_error')) this.db.exec('ALTER TABLE message_input_attachments ADD COLUMN transcription_error TEXT');
    const usageColumns = new Set((this.db.prepare('PRAGMA table_info(session_context_usage)').all() as Array<{ name: string }>).map(column => column.name));
    if (!usageColumns.has('count_source')) this.db.exec("ALTER TABLE session_context_usage ADD COLUMN count_source TEXT NOT NULL DEFAULT 'local-count-estimate'");
    const batchColumns = new Set((this.db.prepare('PRAGMA table_info(memory_batches)').all() as Array<{ name: string }>).map(column => column.name));
    if (batchColumns.has('deadline')) this.db.exec('ALTER TABLE memory_batches DROP COLUMN deadline');
    const sourceColumns = new Set((this.db.prepare('PRAGMA table_info(message_sources)').all() as Array<{ name: string }>).map(column => column.name));
    if (!sourceColumns.has('is_bot')) this.db.exec('ALTER TABLE message_sources ADD COLUMN is_bot INTEGER');
    if (!sourceColumns.has('reply_to_message_id')) this.db.exec('ALTER TABLE message_sources ADD COLUMN reply_to_message_id TEXT');
    if (!sourceColumns.has('reply_to_channel_id')) this.db.exec('ALTER TABLE message_sources ADD COLUMN reply_to_channel_id TEXT');
    if (!sourceColumns.has('webhook_id')) this.db.exec('ALTER TABLE message_sources ADD COLUMN webhook_id TEXT');
    if (!sourceColumns.has('source_kind')) this.db.exec('ALTER TABLE message_sources ADD COLUMN source_kind TEXT');
    if (!sourceColumns.has('author_name')) this.db.exec('ALTER TABLE message_sources ADD COLUMN author_name TEXT');
    if (!sourceColumns.has('forwarded_message_json')) this.db.exec('ALTER TABLE message_sources ADD COLUMN forwarded_message_json TEXT');
    this.db.exec("UPDATE subagent_events SET status='failed_unknown',updated_at=datetime('now') WHERE status='processing'");
    // A claimed event without a durable send intent is safe to retry; intent-bearing rows are ambiguous.
    this.db.exec("UPDATE deployment_result_events SET status=CASE WHEN send_phase='pre_send' THEN 'pending' ELSE 'needs_reconciliation' END,claimed_version=NULL,send_attempt_id=CASE WHEN send_phase='pre_send' THEN NULL ELSE send_attempt_id END,send_phase=CASE WHEN send_phase='pre_send' THEN NULL ELSE send_phase END,updated_at=datetime('now') WHERE status='processing'");
    const segmentColumns = new Set((this.db.prepare('PRAGMA table_info(discord_outgoing_segments)').all() as Array<{ name: string }>).map(column => column.name));
    if (!segmentColumns.has('reply_to_message_id')) this.db.exec('ALTER TABLE discord_outgoing_segments ADD COLUMN reply_to_message_id TEXT');
    if (!segmentColumns.has('reply_to_channel_id')) this.db.exec('ALTER TABLE discord_outgoing_segments ADD COLUMN reply_to_channel_id TEXT');
    const legacyMessages=this.db.prepare(`SELECT m.id,s.channel_id FROM messages m JOIN message_sources s ON s.message_id=m.id LEFT JOIN message_memory_tokens t ON t.message_id=m.id WHERE t.message_id IS NULL AND s.channel_id IS NOT NULL`).all() as Array<{id:string;channel_id:string}>;
    for(const message of legacyMessages){const token=this.memoryWriteToken(message.channel_id,message.channel_id);this.db.prepare('INSERT OR IGNORE INTO message_memory_tokens(message_id,token_json) VALUES(?,?)').run(message.id,JSON.stringify(token));}
    const messageIds = new Set((this.db.prepare('PRAGMA table_info(message_sources)').all() as Array<{ name: string }>).map(column => column.name));
    if (messageIds.has('discord_message_id')) {
      const duplicate = this.db.prepare('SELECT discord_message_id,COUNT(*) count FROM message_sources WHERE discord_message_id IS NOT NULL GROUP BY discord_message_id HAVING COUNT(*)>1 LIMIT 1').get() as { discord_message_id: string; count: number } | undefined;
      if (duplicate) throw new Error(`Duplicate Discord message ID ${duplicate.discord_message_id} exists in stored sources; preserved all messages and did not add the unique index`);
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_discord_id_unique ON message_sources(discord_message_id) WHERE discord_message_id IS NOT NULL');
    }
    this.db.exec(`
      INSERT INTO session_sources(session_id,channel_id,source_type,owner_id,bot_id)
        SELECT cs.session_id,cs.channel_id,'owner','unknown','' FROM channel_state cs
        WHERE NOT EXISTS (SELECT 1 FROM session_sources ss WHERE ss.session_id=cs.session_id AND ss.channel_id=cs.channel_id AND ss.source_type='owner' AND ss.bot_id='');
    `);
    this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
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

  addMessage(session: string, role: string, content: string, source: MessageSource = {}, attachments: MessageInputAttachment[] = [], writeToken?:MemoryWriteToken|null): StoredMessage {
    return this.addMessageOnce(session, role, content, source, attachments, writeToken).message;
  }

  addMessageOnce(session: string, role: string, content: string, source: MessageSource = {}, attachments: MessageInputAttachment[] = [], writeToken?:MemoryWriteToken|null): AddMessageResult {
    const sourceChannel=source.channelId??'';
    const capturedToken=writeToken===undefined?(sourceChannel?this.memoryWriteToken(sourceChannel,sourceChannel):null):writeToken;
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
      this.db.prepare('INSERT INTO message_memory_tokens(message_id,token_json) VALUES(?,?)').run(message.id,JSON.stringify(capturedToken));
      if (source.sourceKind !== 'subagent_event' && source.sourceKind !== 'scheduled_input') {
        const canWrite=Boolean(capturedToken&&this.validMemoryWriteToken(capturedToken));
        this.db.prepare("INSERT INTO hindsight_pending(message_id,status,updated_at,error) VALUES(?,?,?,?)").run(message.id,canWrite?'pending':'suppressed',message.createdAt,canWrite?null:'No valid captured memory-write permission');
      }
      this.db.prepare("INSERT INTO message_preparation(message_id,status,updated_at) VALUES(?,'preparing',?)").run(message.id, message.createdAt);
      const insertAttachment = this.db.prepare('INSERT INTO message_input_attachments(message_id,attachment_id,filename,mime_type,local_path,status,error,origin,memory_document_id,transcript,transcription_error) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const attachment of attachments) insertAttachment.run(message.id, attachment.attachmentId, attachment.filename, attachment.mimeType, attachment.localPath ?? null, attachment.status, attachment.error ?? null, attachment.origin ?? null, attachment.memoryDocumentId ?? null, attachment.transcript ?? null, attachment.transcriptionError ?? null);
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
        insert.run(messageId, a.attachmentId, a.filename, a.mimeType, a.localPath ?? null, a.status, a.error ?? null, a.origin ?? null, documentId ?? null, a.transcript ?? null, a.transcriptionError ?? null);
        if (documentId) {
          const token=this.messageMemoryWriteToken(messageId);
          const eligible=Boolean(token&&this.validMemoryWriteToken(token));
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
      ...(typeof row.attempted_at === 'string' ? { attemptedAt: row.attempted_at } : {}), ...(typeof row.next_poll_at === 'string' ? { nextPollAt: row.next_poll_at } : {}), pollAttempt: Number(row.poll_attempt), ...(typeof row.error === 'string' ? { error: row.error } : {}), path: row.local_path, filename: String(row.filename), mimeType: String(row.mime_type), ...(row.origin === 'discord_attachment' || row.origin === 'butler_generated' ? { origin: row.origin } : {}),
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

  createOutgoing(session: string, content: string, source: MessageSource, writeToken?: MemoryWriteToken | null): StoredMessage {
    return this.addMessage(session, 'assistant', content, source, [], writeToken);
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
      for(const id of input.sourceMessageIds){const token=this.messageMemoryWriteToken(id);if(!token||!this.validMemoryWriteToken(token))throw new Error('Batch source no longer has valid captured memory-write permission');}
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
        const token=this.messageMemoryWriteToken(m.id);
        if(!token||!this.validMemoryWriteToken(token)){this.db.prepare("UPDATE hindsight_pending SET status='suppressed',updated_at=?,error='Captured memory-write policy is no longer valid' WHERE message_id=? AND status='pending'").run(new Date().toISOString(),m.id);continue;}
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
      attachments: (attachments.all(row.id) as Array<{ attachment_id: string; filename: string; mime_type: string; local_path: string | null; status: 'ready' | 'failed'; error: string | null; origin: 'discord_attachment' | 'butler_generated' | null; memory_document_id: string | null; transcript: string | null; transcription_error: string | null }>).map(item => ({ attachmentId: item.attachment_id, filename: item.filename, mimeType: item.mime_type, ...(item.local_path ? { localPath: item.local_path } : {}), status: item.status, ...(item.origin ? { origin: item.origin } : {}), ...(item.memory_document_id ? { memoryDocumentId: item.memory_document_id } : {}), ...(item.transcript ? { transcript: item.transcript } : {}), ...(item.transcription_error ? { transcriptionError: item.transcription_error } : {}), ...(item.error ? { error: item.error } : {}) })),
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
  }

  createSubagentWindow(parentSessionId: string, model: string, input: unknown[], requestedId?: string): string {
    if (requestedId !== undefined && (typeof requestedId !== 'string' || !requestedId.trim() || requestedId.includes('\0'))) throw new Error('Invalid subagent window ID');
    const id = requestedId ?? randomUUID();
    const existing = this.db.prepare('SELECT parent_session_id FROM subagent_windows WHERE id=?').get(id) as { parent_session_id: string } | undefined;
    if (existing) {
      if (existing.parent_session_id !== parentSessionId) throw new Error('Subagent window belongs to another parent session');
      return id;
    }
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO subagent_windows(id,parent_session_id,model,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, parentSessionId, model, JSON.stringify(input), now, now);
    return id;
  }

  getSubagentWindow(id: string, parentSessionId: string): { id: string; parent_session_id: string; model: string; input_json: string; created_at: string; updated_at: string } | undefined {
    return this.db.prepare('SELECT * FROM subagent_windows WHERE id=? AND parent_session_id=?').get(id, parentSessionId) as ReturnType<Store['getSubagentWindow']>;
  }

  saveSubagentWindow(id: string, input: unknown[]): void {
    const result = this.db.prepare('UPDATE subagent_windows SET input_json=?,updated_at=? WHERE id=?').run(JSON.stringify(input), new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error(`Could not persist subagent window ${id}`);
  }

  enqueueSubagentMessage(id: string, message: string): string {
    const inboxId = randomUUID();
    this.db.prepare("INSERT INTO subagent_inbox(id,subagent_id,message,status,created_at) VALUES(?,?,?,'pending',?)").run(inboxId, id, message, new Date().toISOString());
    return inboxId;
  }

  pendingSubagentMessages(id: string): Array<{ id: string; message: string }> {
    return this.db.prepare("SELECT id,message FROM subagent_inbox WHERE subagent_id=? AND status='pending' ORDER BY created_at,rowid").all(id) as Array<{ id: string; message: string }>;
  }

  consumeSubagentInbox(id: string, messageIds: string[], input: unknown[]): void {
    if (!messageIds.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = messageIds.map(messageId => this.db.prepare("SELECT id,message FROM subagent_inbox WHERE id=? AND subagent_id=? AND status='pending'").get(messageId, id) as { id: string; message: string } | undefined);
      if (rows.some(row => !row)) throw new Error('Subagent inbox changed before consumption');
      const next = [...input, { role: 'user', content: `Parent supplemental message(s):\n${rows.map(row => row!.message).join('\n\n')}` }];
      this.saveSubagentWindow(id, next);
      const mark = this.db.prepare("UPDATE subagent_inbox SET status='consumed',consumed_at=? WHERE id=? AND subagent_id=? AND status='pending'");
      for (const messageId of messageIds) mark.run(new Date().toISOString(), messageId, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  answerSubagentQuestion(id: string, callId: string, answer: string, stopRequested?: { reason: string; requestedAt: string }): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT input_json FROM subagent_windows WHERE id=?').get(id) as { input_json: string } | undefined;
      if (!row) throw new Error(`Unknown subagent window ${id}`);
      const input = JSON.parse(row.input_json) as Array<Record<string, unknown>>;
      const hasOutput = input.some(item => item.type === 'function_call_output' && item.call_id === callId);
      const now = new Date().toISOString();
      if (!hasOutput) {
        const hasCall = input.some(item => item.type === 'function_call' && item.call_id === callId && item.name === 'subagent_parent_message');
        if (!hasCall) throw new Error(`Parent message call ${callId} is not pending in subagent window ${id}`);
        input.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify(answer) });
        this.db.prepare('UPDATE subagent_windows SET input_json=?,updated_at=? WHERE id=?').run(JSON.stringify(input), now, id);
      }
      const run = this.db.prepare('SELECT parent_session_id,snapshot_json FROM subagent_runs WHERE id=?').get(id) as { parent_session_id: string; snapshot_json: string } | undefined;
      if (run) {
        const snapshot = JSON.parse(run.snapshot_json) as Record<string, unknown>;
        delete snapshot.question;
        if (stopRequested) snapshot.stopRequested = stopRequested;
        snapshot.status = snapshot.stopRequested ? 'stopping' : 'running';
        snapshot.updatedAt = now;
        this.db.prepare('UPDATE subagent_runs SET status=?,snapshot_json=?,updated_at=? WHERE id=?').run(snapshot.status as string, JSON.stringify(snapshot), now, id);
      }
      this.db.exec('COMMIT');
      return !hasOutput;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveSubagentRun(snapshot: { id: string; parentSession: string; runId: string; status: string; updatedAt: string }): void {
    this.db.prepare('INSERT INTO subagent_runs(id,parent_session_id,run_id,status,snapshot_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at WHERE subagent_runs.parent_session_id=excluded.parent_session_id AND (subagent_runs.run_id=excluded.run_id OR excluded.status=\'queued\')')
      .run(snapshot.id, snapshot.parentSession, snapshot.runId, snapshot.status, JSON.stringify(snapshot), snapshot.updatedAt);
  }

  allSubagentRuns(): Array<Record<string, unknown>> {
    return (this.db.prepare('SELECT snapshot_json FROM subagent_runs ORDER BY updated_at DESC').all() as Array<{ snapshot_json: string }>).map(row => JSON.parse(row.snapshot_json) as Record<string, unknown>);
  }

  saveSubagentEvent(event: { id: string; runId: string; subagentId: string; parentSession: string; parentInputId?: string; questionId: string; message: string; waitForReply: boolean; kind?: string; status: string }): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO subagent_events(id,run_id,subagent_id,parent_session_id,parent_input_id,question_id,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(event.id, event.runId, event.subagentId, event.parentSession, event.parentInputId ?? null, event.questionId, JSON.stringify({ message: event.message, waitForReply: event.waitForReply, kind: event.kind }), event.status, now, now);
  }

  pendingSubagentEvents(): Array<{ id: string; runId: string; subagentId: string; parentSession: string; parentInputId?: string; questionId: string; message: string; waitForReply: boolean; kind?: string; status: string }> {
    return (this.db.prepare("SELECT id,run_id,subagent_id,parent_session_id,parent_input_id,question_id,payload_json,status FROM subagent_events WHERE status IN ('pending','failed_unknown') ORDER BY created_at,rowid").all() as Array<{ id: string; run_id: string; subagent_id: string; parent_session_id: string; parent_input_id: string | null; question_id: string; payload_json: string; status: string }>).map(row => ({ id: row.id, runId: row.run_id, subagentId: row.subagent_id, parentSession: row.parent_session_id, ...(row.parent_input_id ? { parentInputId: row.parent_input_id } : {}), questionId: row.question_id, ...JSON.parse(row.payload_json) as { message: string; waitForReply: boolean; kind?: string }, status: row.status }));
  }

  subagentEventInput(eventId: string, session: string, content: string, source: MessageSource, writeToken: MemoryWriteToken | null = null): StoredMessage {
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
        this.db.prepare('INSERT INTO message_memory_tokens(message_id,token_json) VALUES(?,?)').run(id, JSON.stringify(writeToken));
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

  createDeploymentRequest(input: { id: string; parentSession: string; channelId: string; messageId?: string; requesterId?: string }): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO deployment_requests(id,parent_session_id,channel_id,message_id,requester_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(input.id,input.parentSession,input.channelId,input.messageId ?? null,input.requesterId ?? null,now,now);
    return Number(result.changes) === 1;
  }
  deploymentRequest(id: string): Record<string, unknown> | undefined { return this.db.prepare('SELECT * FROM deployment_requests WHERE id=?').get(id) as Record<string, unknown> | undefined; }
  deploymentResultEvidence(id: string): { id: string; status: string; result_json: string | null; created_at: string; updated_at: string; version: string } | undefined {
    const row = this.db.prepare('SELECT id,status,result_json,created_at,updated_at FROM deployment_requests WHERE id=?').get(id) as {id:string;status:string;result_json:string|null;created_at:string;updated_at:string}|undefined;
    if (!row) return undefined;
    return { ...row, version: this.deploymentResultVersion(row.status, row.result_json) };
  }
  private deploymentResultVersion(status: string, resultJson: string | null): string {
    let normalized = resultJson;
    if (resultJson !== null) {
      try { normalized = JSON.stringify(sortJsonValue(JSON.parse(resultJson))); } catch { /* Preserve malformed evidence bytes as a distinct version. */ }
    }
    return createHash('sha256').update(JSON.stringify([status, normalized])).digest('hex');
  }
  activeDeploymentRequest(): Record<string, unknown> | undefined { return this.db.prepare("SELECT * FROM deployment_requests WHERE status IN ('queued','running','needs_reconciliation') ORDER BY created_at LIMIT 1").get() as Record<string, unknown> | undefined; }
  queuedDeploymentRequest(): Record<string, unknown> | undefined { return this.db.prepare("SELECT * FROM deployment_requests WHERE status='queued' ORDER BY created_at LIMIT 1").get() as Record<string, unknown> | undefined; }
  recoverRunningDeployments(): void {
    this.db.exec('BEGIN IMMEDIATE'); try {
      const rows=this.db.prepare("SELECT id FROM deployment_requests WHERE status='running'").all() as Array<{id:string}>;
      const now=new Date().toISOString();
      for (const row of rows) {
        this.db.prepare("UPDATE deployment_requests SET status='needs_reconciliation',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({status:'needs_reconciliation',reason:'Service restarted while deployment was running; automatic replay refused'}),now,row.id);
        this.db.prepare("INSERT OR IGNORE INTO deployment_result_events(id,deployment_id,status,created_at,updated_at) VALUES(?,?,'pending',?,?)").run(randomUUID(),row.id,now,now);
      }
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  claimDeploymentRequest(id: string): boolean { return Number(this.db.prepare("UPDATE deployment_requests SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(),id).changes)===1; }
  setDeploymentStatus(id: string, status: 'queued'|'running'|'completed'|'failed'|'interrupted'|'needs_reconciliation', result?: unknown): void {
    this.db.prepare('UPDATE deployment_requests SET status=?,result_json=COALESCE(?,result_json),updated_at=? WHERE id=?').run(status,result === undefined ? null : JSON.stringify(result),new Date().toISOString(),id);
  }
  completeDeployment(id: string, status: 'completed'|'failed'|'interrupted'|'needs_reconciliation', result: unknown): void {
    this.db.exec('BEGIN IMMEDIATE'); try {
      const now = new Date().toISOString(), resultJson = JSON.stringify(result);
      const before = this.db.prepare('SELECT status,result_json FROM deployment_requests WHERE id=?').get(id) as {status:string;result_json:string|null}|undefined;
      if (!before) throw new Error(`Unknown deployment ${id}`);
      const priorFinal = before.status === 'completed' || before.status === 'failed';
      if (before.status === 'needs_reconciliation' && before.result_json) {
        try { const prior = JSON.parse(before.result_json); if (prior.reason === 'Conflicting terminal deployment evidence' && prior.incomingStatus === status && prior.incomingResult === resultJson) { this.db.exec('COMMIT'); return; } } catch { /* continue with explicit evidence */ }
      }
      if (priorFinal && (before.status !== status || before.result_json !== resultJson)) {
        const conflict = JSON.stringify({status:'needs_reconciliation',reason:'Conflicting terminal deployment evidence',priorStatus:before.status,priorResult:before.result_json,incomingStatus:status,incomingResult:resultJson});
        this.db.prepare("UPDATE deployment_requests SET status='needs_reconciliation',result_json=?,updated_at=? WHERE id=?").run(conflict,now,id);
        const version=this.deploymentResultVersion('needs_reconciliation',conflict);
        this.db.prepare("UPDATE deployment_result_events SET target_version=?,status=CASE WHEN status='delivered' THEN 'pending' ELSE status END,updated_at=? WHERE deployment_id=?").run(version,now,id);
        this.db.exec('COMMIT');
        return;
      }
      const version = this.deploymentResultVersion(status, resultJson);
      this.db.prepare('UPDATE deployment_requests SET status=?,result_json=?,updated_at=? WHERE id=?').run(status,resultJson,now,id);
      const event = this.db.prepare('SELECT status,target_version,delivered_version FROM deployment_result_events WHERE deployment_id=?').get(id) as {status:string;target_version:string|null;delivered_version:string|null}|undefined;
      if (!event) this.db.prepare("INSERT INTO deployment_result_events(id,deployment_id,status,created_at,updated_at,target_version) VALUES(?,?,'pending',?,?,?)").run(randomUUID(),id,now,now,version);
      else if (event.target_version !== version) {
        const finalResult = status === 'completed' || status === 'failed';
        const wasDelivered = event.delivered_version === event.target_version;
        const eligible = finalResult && (event.status === 'processing' || wasDelivered || event.status === 'pending' || event.status === 'failed_unknown');
        this.db.prepare("UPDATE deployment_result_events SET target_version=?,status=CASE WHEN status='processing' THEN status WHEN ? THEN 'pending' ELSE status END,next_attempt_at=CASE WHEN ? THEN NULL ELSE next_attempt_at END,updated_at=? WHERE deployment_id=?")
          .run(version, eligible ? 1 : 0, eligible ? 1 : 0, now, id);
      }
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  pendingDeploymentEvents(): Array<Record<string, unknown>> { return this.db.prepare("SELECT e.*,r.parent_session_id,r.channel_id,r.message_id,r.requester_id,r.result_json,r.status AS result_status FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id WHERE e.status IN ('pending','failed_unknown') AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=?) ORDER BY e.created_at").all(new Date().toISOString()) as Array<Record<string, unknown>>; }
  claimDeploymentEvent(id: string): { version: string; attempts: number; attemptId: string } | undefined {
    this.db.exec('BEGIN IMMEDIATE'); try {
      const row=this.db.prepare("SELECT r.status,r.result_json FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id WHERE e.id=? AND e.status IN ('pending','failed_unknown')").get(id) as {status:string;result_json:string|null}|undefined;
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      const version=this.deploymentResultVersion(row.status,row.result_json), now=new Date().toISOString(), attemptId=randomUUID();
      this.db.prepare("UPDATE deployment_result_events SET status='processing',claimed_version=?,target_version=?,send_attempt_id=?,send_phase='pre_send',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('pending','failed_unknown')").run(version,version,attemptId,now,id);
      const attempts=(this.db.prepare('SELECT attempts FROM deployment_result_events WHERE id=?').get(id) as {attempts:number}).attempts;
      this.db.exec('COMMIT'); return {version,attempts,attemptId};
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  releaseDeploymentEventBeforeSend(id:string, version:string, attemptId:string): boolean {
    const result=this.db.prepare("UPDATE deployment_result_events SET status='pending',claimed_version=NULL,send_attempt_id=NULL,send_phase=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND status='processing' AND claimed_version=? AND send_attempt_id=? AND send_phase='pre_send'").run(new Date().toISOString(),id,version,attemptId);
    return Number(result.changes)===1;
  }
  persistDeploymentSendIntent(id:string, version:string, attemptId:string): boolean {
    const result=this.db.prepare("UPDATE deployment_result_events SET send_phase='send_intent',updated_at=? WHERE id=? AND status='processing' AND claimed_version=? AND send_attempt_id=? AND send_phase='pre_send'").run(new Date().toISOString(),id,version,attemptId);
    return Number(result.changes)===1;
  }
  deploymentResultIsCurrent(id:string,version:string):boolean {
    const row=this.db.prepare('SELECT e.status,e.claimed_version,r.status AS result_status,r.result_json FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id WHERE e.id=?').get(id) as {status:string;claimed_version:string|null;result_status:string;result_json:string|null}|undefined;
    return Boolean(row&&row.status==='processing'&&row.claimed_version===version&&this.deploymentResultVersion(row.result_status,row.result_json)===version);
  }
  finishDeploymentEvent(id:string,version:string,messageId:string):void {
    this.db.exec('BEGIN IMMEDIATE'); try {
      const row=this.db.prepare('SELECT e.status,e.claimed_version,r.status AS result_status,r.result_json FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id WHERE e.id=?').get(id) as {status:string;claimed_version:string|null;result_status:string;result_json:string|null}|undefined;
      if(!row||row.status!=='processing'||row.claimed_version!==version) throw new Error('Deployment event claim changed before delivery persistence');
      const latest=this.deploymentResultVersion(row.result_status,row.result_json), newerFinal=latest!==version&&(row.result_status==='completed'||row.result_status==='failed');
      this.db.prepare("UPDATE deployment_result_events SET status=?,delivered_version=?,delivery_message_id=?,target_version=?,claimed_version=NULL,send_phase='delivered',next_attempt_at=NULL,updated_at=? WHERE id=?").run(newerFinal?'pending':'delivered',version,messageId,latest,new Date().toISOString(),id);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  setDeploymentEvent(id:string,status:'pending'|'processing'|'delivered'|'failed_unknown'|'needs_reconciliation',inputId?:string,messageId?:string,nextAttemptAt?:string,inputVersion?:string):void {
    this.db.prepare("UPDATE deployment_result_events SET status=?,parent_input_id=COALESCE(?,parent_input_id),parent_input_version=COALESCE(?,parent_input_version),delivery_message_id=COALESCE(?,delivery_message_id),claimed_version=CASE WHEN ?='processing' THEN claimed_version ELSE NULL END,next_attempt_at=?,updated_at=? WHERE id=?").run(status,inputId??null,inputVersion??null,messageId??null,status,nextAttemptAt??null,new Date().toISOString(),id);
  }
  deploymentEventInput(eventId:string,session:string,content:string,source:MessageSource,version?:string):StoredMessage {
    this.db.exec('BEGIN IMMEDIATE'); try {
      const event=this.db.prepare('SELECT e.parent_input_id,e.parent_input_version,e.status AS event_status,r.status,r.result_json FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id WHERE e.id=? AND r.parent_session_id=?').get(eventId,session) as {parent_input_id:string|null;parent_input_version:string|null;event_status:string;status:string;result_json:string|null}|undefined;
      if(!event) throw new Error('Unknown deployment result event');
      version ??= this.deploymentResultVersion(event.status,event.result_json);
      const currentVersion=this.deploymentResultVersion(event.status,event.result_json);
      if(currentVersion!==version) throw new Error('Deployment result changed before notification input was stored');
      if(event.event_status==='processing') this.db.prepare("UPDATE deployment_result_events SET claimed_version=?,target_version=? WHERE id=? AND status='processing'").run(version,version,eventId);
      if(event.parent_input_id&&event.parent_input_version===version){const message=this.messagesWithSourcesForId(event.parent_input_id);this.db.exec('COMMIT');return message;}
      const id=randomUUID(),now=new Date().toISOString();
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(id,session,'user',content,now);
      this.db.prepare('INSERT INTO message_sources(message_id,author_id,channel_id,event_time,source_kind) VALUES(?,?,?,?,?)').run(id,source.authorId??null,source.channelId??null,now,'deployment_result');
      const trigger = this.db.prepare('SELECT ms.message_id FROM deployment_result_events e JOIN deployment_requests r ON r.id=e.deployment_id JOIN message_sources ms ON ms.discord_message_id=r.message_id WHERE e.id=?').get(eventId) as { message_id: string } | undefined;
      const writeToken = trigger ? this.messageMemoryWriteToken(trigger.message_id) ?? null : null;
      this.db.prepare('INSERT INTO message_memory_tokens(message_id,token_json) VALUES(?,?)').run(id, JSON.stringify(writeToken));
      this.db.prepare("INSERT INTO message_preparation(message_id,status,updated_at) VALUES(?,'ready',?)").run(id,now);
      this.db.prepare('UPDATE deployment_result_events SET parent_input_id=?,parent_input_version=? WHERE id=?').run(id,version,eventId);
      const message=this.messagesWithSourcesForId(id);this.db.exec('COMMIT');return message;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
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

  knownChannelIds(): string[] {
    return (this.db.prepare(`SELECT channel_id FROM channel_state UNION SELECT channel_id FROM channel_policies UNION SELECT channel_id FROM channel_reply_modes UNION SELECT channel_id FROM channel_reasoning_efforts UNION SELECT channel_id FROM channel_image_models UNION SELECT channel_id FROM channel_model_overrides`).all() as Array<{channel_id:string}>).map(row => row.channel_id);
  }

  channelPolicy(channelId: string): ChannelPolicy | undefined {
    const row = this.db.prepare('SELECT * FROM channel_policies WHERE channel_id=?').get(channelId) as {channel_id:string;parent_channel_id:string|null;tracked:number|null;bot_reply:number|null;hindsight_write:number|null;revision:number}|undefined;
    return row && {channelId:row.channel_id,parentChannelId:row.parent_channel_id,tracked:row.tracked===null?null:row.tracked===1,botReply:row.bot_reply===null?null:row.bot_reply===1,hindsightWrite:row.hindsight_write===null?null:row.hindsight_write===1,revision:row.revision};
  }

  effectiveChannelPolicy(channelId:string,parentChannelId?:string):EffectiveChannelPolicy {
    const own=this.channelPolicy(channelId);
    const chain:Array<{channelId:string;policy:ChannelPolicy}>=[];
    let current=parentChannelId??own?.parentChannelId;
    const seen=new Set([channelId]);
    while(current&&!seen.has(current)){seen.add(current);const policy=this.channelPolicy(current);if(!policy)break;chain.push({channelId:current,policy});current=policy.parentChannelId??undefined;}
    const resolve=(key:'tracked'|'botReply'|'hindsightWrite',fallback:boolean):{value:boolean;source:string}=>{
      if(own&&own[key]!==null)return {value:own[key]!,source:channelId};
      for(const entry of chain)if(entry.policy[key]!==null)return {value:entry.policy[key]!,source:entry.channelId};
      return {value:fallback,source:'default'};
    };
    const tracked=resolve('tracked',true),botReply=resolve('botReply',false),hindsightWrite=resolve('hindsightWrite',true);
    const mode=this.channelReplyMode(channelId);
    const effectiveParent=parentChannelId??own?.parentChannelId??undefined;
    const parentMode=effectiveParent?this.channelReplyMode(effectiveParent):undefined;
    return {tracked:tracked.value,botReply:botReply.value,hindsightWrite:hindsightWrite.value,trackedSource:tracked.source,botReplySource:botReply.source,hindsightWriteSource:hindsightWrite.source,replyMode:mode??parentMode??'mention',replyModeSource:mode?channelId:parentMode?effectiveParent!:'default'};
  }

  setChannelPolicy(channelId:string,patch:Partial<Pick<ChannelPolicy,'parentChannelId'|'tracked'|'botReply'|'hindsightWrite'>>):ChannelPolicy {
    const before=this.channelPolicy(channelId);const parent=Object.prototype.hasOwnProperty.call(patch,'parentChannelId')?patch.parentChannelId??null:before?.parentChannelId??null;
    const tracked=Object.prototype.hasOwnProperty.call(patch,'tracked')?patch.tracked:before?.tracked??null;
    const botReply=Object.prototype.hasOwnProperty.call(patch,'botReply')?patch.botReply:before?.botReply??null;
    const hindsightWrite=Object.prototype.hasOwnProperty.call(patch,'hindsightWrite')?patch.hindsightWrite:before?.hindsightWrite??null;
    const revisionChanged=Boolean(before&&(before.parentChannelId!==parent||before.tracked!==tracked||before.hindsightWrite!==hindsightWrite));
    const initialRevision=before?0:(parent!==null||hindsightWrite!==null?1:0);
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare(`INSERT INTO channel_policies(channel_id,parent_channel_id,tracked,bot_reply,hindsight_write,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET parent_channel_id=excluded.parent_channel_id,tracked=excluded.tracked,bot_reply=excluded.bot_reply,hindsight_write=excluded.hindsight_write,revision=channel_policies.revision+?`).run(channelId,parent,tracked===null?null:tracked?1:0,botReply===null?null:botReply?1:0,hindsightWrite===null?null:hindsightWrite?1:0,initialRevision,revisionChanged?1:0);
      const now=new Date().toISOString();
      const pending=this.db.prepare("SELECT hp.message_id,s.channel_id FROM hindsight_pending hp JOIN message_sources s ON s.message_id=hp.message_id WHERE hp.status='pending' AND NOT EXISTS (SELECT 1 FROM memory_batch_sources bs JOIN memory_batches b ON b.operation_id=bs.operation_id WHERE bs.message_id=hp.message_id AND (b.submit_intended_at IS NOT NULL OR b.status!='frozen'))").all() as Array<{message_id:string;channel_id:string|null}>;
      const suppressMessage=(messageId:string,sourceChannelId:string|null):boolean=>{
        const token=this.messageMemoryWriteToken(messageId);
        if(token!==undefined)return token===null||!this.validMemoryWriteToken(token);
        return !sourceChannelId||!this.effectiveChannelPolicy(sourceChannelId).tracked||!this.effectiveChannelPolicy(sourceChannelId).hindsightWrite;
      };
      const suppressIds=new Set(pending.filter(row=>suppressMessage(row.message_id,row.channel_id)).map(row=>row.message_id));
      for(const row of this.db.prepare("SELECT operation_id,source_message_ids FROM memory_batches WHERE status='frozen' AND submit_intended_at IS NULL").all() as Array<{operation_id:string;source_message_ids:string}>) {
        const ids=JSON.parse(row.source_message_ids) as string[];
        if(ids.some(id=>suppressIds.has(id))){
          this.db.prepare("UPDATE memory_batches SET status='suppressed',next_poll_at=NULL,error='Captured memory-write policy is no longer valid' WHERE operation_id=? AND status='frozen' AND submit_intended_at IS NULL").run(row.operation_id);
          for(const id of ids)suppressIds.add(id);
        }
      }
      const updatePending=this.db.prepare("UPDATE hindsight_pending SET status='suppressed',updated_at=?,error='Captured memory-write policy is no longer valid' WHERE message_id=? AND status='pending'");
      for(const id of suppressIds)updatePending.run(now,id);
      const jobs=this.db.prepare("SELECT j.message_id,s.channel_id FROM attachment_memory_jobs j JOIN message_sources s ON s.message_id=j.message_id WHERE j.state='queued'").all() as Array<{message_id:string;channel_id:string|null}>;
      const updateJob=this.db.prepare("UPDATE attachment_memory_jobs SET state='suppressed',next_poll_at=NULL,error='Captured memory-write policy is no longer valid' WHERE message_id=? AND state='queued'");
      for(const row of jobs)if(suppressMessage(row.message_id,row.channel_id)){updateJob.run(row.message_id);suppressIds.add(row.message_id);}
      const clearToken=this.db.prepare("UPDATE message_memory_tokens SET token_json='null' WHERE message_id=?");
      for(const id of suppressIds)clearToken.run(id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return this.channelPolicy(channelId)!;
  }

  memoryWriteToken(originChannelId:string,sourceChannelId:string):MemoryWriteToken|null {
    const origin=this.effectiveChannelPolicy(originChannelId);
    const source=this.effectiveChannelPolicy(sourceChannelId);
    if(!origin.tracked||!source.tracked||!origin.hindsightWrite||!source.hindsightWrite)return null;
    const originPolicy=origin.hindsightWriteSource==='default'?originChannelId:origin.hindsightWriteSource;
    const sourcePolicy=source.hindsightWriteSource==='default'?sourceChannelId:source.hindsightWriteSource;
    return {originChannelId,sourceChannelId,originPolicyChannelId:originPolicy,originRevision:this.channelPolicy(originPolicy)?.revision??0,sourcePolicyChannelId:sourcePolicy,sourceRevision:this.channelPolicy(sourcePolicy)?.revision??0};
  }
  messageMemoryWriteToken(messageId:string):MemoryWriteToken|null|undefined {
    const row=this.db.prepare('SELECT token_json FROM message_memory_tokens WHERE message_id=?').get(messageId) as {token_json:string}|undefined;
    return row?JSON.parse(row.token_json) as MemoryWriteToken|null:undefined;
  }

  tokenForSource(originalToken:MemoryWriteToken|null,destinationChannelId:string):MemoryWriteToken|null {
    if(!originalToken||!this.validMemoryWriteToken(originalToken))return null;
    const destination=this.memoryWriteToken(originalToken.originChannelId,destinationChannelId);
    if(!destination)return null;
    return {...destination,originPolicyChannelId:originalToken.originPolicyChannelId,originRevision:originalToken.originRevision};
  }

  validMemoryWriteToken(token:MemoryWriteToken):boolean {
    const effectiveOrigin=this.effectiveChannelPolicy(token.originChannelId),effectiveSource=this.effectiveChannelPolicy(token.sourceChannelId);
    const originPolicy=effectiveOrigin.hindsightWriteSource==='default'?token.originChannelId:effectiveOrigin.hindsightWriteSource;
    const sourcePolicy=effectiveSource.hindsightWriteSource==='default'?token.sourceChannelId:effectiveSource.hindsightWriteSource;
    return effectiveOrigin.tracked&&effectiveSource.tracked&&effectiveOrigin.hindsightWrite&&effectiveSource.hindsightWrite&&originPolicy===token.originPolicyChannelId&&sourcePolicy===token.sourcePolicyChannelId&&(this.channelPolicy(originPolicy)?.revision??0)===token.originRevision&&(this.channelPolicy(sourcePolicy)?.revision??0)===token.sourceRevision;
  }

  migrateChannelPolicies(allowedIds:string[]):void {
    this.db.exec('BEGIN IMMEDIATE');try{
      if(this.db.prepare("SELECT 1 FROM channel_policy_migrations WHERE name='global-bot-reply'").get()){this.db.exec('COMMIT');return;}
      const legacyRow=this.db.prepare('SELECT bot_reply FROM discord_settings WHERE id=1').get() as {bot_reply:number}|undefined;
      const legacy=legacyRow?.bot_reply===1;
      for(const id of allowedIds)this.db.prepare('INSERT INTO channel_policies(channel_id,bot_reply,revision) VALUES(?,?,0) ON CONFLICT(channel_id) DO NOTHING').run(id,legacy?1:0);
      this.db.prepare('INSERT INTO channel_policies(channel_id,bot_reply,revision) SELECT cs.channel_id,?,0 FROM channel_state cs WHERE NOT EXISTS(SELECT 1 FROM channel_policies cp WHERE cp.channel_id=cs.channel_id)').run(legacy?1:0);
      this.db.prepare("INSERT INTO channel_policy_migrations(name,completed_at) VALUES('global-bot-reply',?)").run(new Date().toISOString());
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  channelSettings(channelId:string,defaultModel:string):{sessionId?:string;model:string} {
    const row=this.db.prepare('SELECT session_id,model FROM channel_state WHERE channel_id=?').get(channelId) as {session_id:string;model:string|null}|undefined;
    return { ...(row?{sessionId:row.session_id}:{}), model: this.effectiveChannelModel(channelId, defaultModel) };
  }

  effectiveChannelModel(channelId: string, defaultModel: string): string {
    const override = this.channelModelOverride(channelId);
    if (override !== undefined && override !== null) return override;
    const parent = this.channelPolicy(channelId)?.parentChannelId;
    return parent ? this.effectiveChannelModel(parent, defaultModel) : defaultModel;
  }

  effectiveChannelReasoningEffort(channelId: string): ReasoningEffort | undefined {
    return this.channelReasoningEffort(channelId) ?? (this.channelPolicy(channelId)?.parentChannelId ? this.effectiveChannelReasoningEffort(this.channelPolicy(channelId)!.parentChannelId!) : undefined);
  }

  effectiveChannelImageModel(channelId: string): string | undefined {
    return this.channelImageModel(channelId) ?? (this.channelPolicy(channelId)?.parentChannelId ? this.effectiveChannelImageModel(this.channelPolicy(channelId)!.parentChannelId!) : undefined);
  }

  channelState(channelId: string, defaultModel: string, ownerId = 'unknown'): { sessionId: string; model: string } {
    const row = this.db.prepare('SELECT session_id,model FROM channel_state WHERE channel_id=?').get(channelId) as { session_id: string; model: string | null } | undefined;
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

  setChannelModel(channelId: string, model: string | null): void {
    this.db.prepare('INSERT INTO channel_model_overrides(channel_id,model) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET model=excluded.model').run(channelId,model);
  }

  channelModelOverride(channelId:string):string|null|undefined {
    const row=this.db.prepare('SELECT model FROM channel_model_overrides WHERE channel_id=?').get(channelId) as {model:string|null}|undefined;
    if (row) return row.model;
    const legacy = this.db.prepare('SELECT model FROM channel_state WHERE channel_id=?').get(channelId) as {model:string|null}|undefined;
    return legacy?.model;
  }

  archiveChannelSession(channelId:string):boolean {
    return Number(this.db.prepare('DELETE FROM channel_state WHERE channel_id=?').run(channelId).changes)===1;
  }

  channelModeOverride(channelId: string): 'queue' | 'steer' | undefined {
    const row = this.db.prepare('SELECT mode FROM channel_modes WHERE channel_id=?').get(channelId) as { mode: 'queue' | 'steer' } | undefined;
    return row?.mode;
  }

  channelMode(channelId: string): 'queue' | 'steer' {
    const policy = this.channelPolicy(channelId);
    return this.channelModeOverride(channelId) ?? (policy?.parentChannelId ? this.channelMode(policy.parentChannelId) : undefined) ?? 'queue';
  }

  setChannelMode(channelId: string, mode: 'queue' | 'steer' | undefined): void {
    if (mode === undefined) { this.db.prepare('DELETE FROM channel_modes WHERE channel_id=?').run(channelId); return; }
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

  effectiveReplyMode(channelId: string, parentChannelId?: string): ChannelReplyMode {
    return this.channelReplyMode(channelId) ?? (parentChannelId ? this.channelReplyMode(parentChannelId) : undefined) ?? 'mention';
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
    this.db.prepare(`INSERT INTO schedules(id,output_channel_id,creator_id,kind,content,cron,run_at,timezone,enabled,next_run,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.outputChannelId, job.creatorId, job.kind, job.content, job.cron, job.runAt, job.timezone, job.enabled ? 1 : 0, job.nextRun, job.createdAt, job.updatedAt);
    return job;
  }

  getSchedule(id: string): ScheduleJob | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as ScheduleDbRow | undefined;
    return row && scheduleFromRow(row);
  }

  listSchedules(): ScheduleJob[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY created_at,id').all() as ScheduleDbRow[]).map(scheduleFromRow);
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
