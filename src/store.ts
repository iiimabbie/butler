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
  authorId?: string; authorName?: string; isBot?: boolean; webhookId?: string; sourceKind?: 'discord_external' | 'butler_reply' | 'butler_tool_message' | 'scheduled_input' | 'unknown'; channelId?: string; discordMessageId?: string; eventTime?: string; replyToMessageId?: string; replyToChannelId?: string;
}

export interface MessageInputAttachment { attachmentId: string; filename: string; mimeType: string; size: number; status: 'ready' | 'failed'; localPath?: string; error?: string; }
export interface DiscordSegment { channelId: string; messageId: string; content: string; eventTime: string; replyToMessageId?: string; replyToChannelId?: string; }
export interface StoredMessage extends Message {
  id: string; sessionId: string; createdAt: string; source: MessageSource; attachments: MessageInputAttachment[]; preparationStatus: 'preparing' | 'ready'; discordSegments: DiscordSegment[];
}
export interface AddMessageResult { message: StoredMessage; created: boolean; }
export interface MemoryBatch { operationId: string; payload: string; sourceMessageIds: string[]; documentId: string; sessionId: string; channelId: string; order: number; status: 'frozen' | 'submitting' | 'unknown' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'not_found' | 'needs_clarification'; submitIntendedAt?: string; nextPollAt?: string; lastPollAt?: string; error?: string; }

export interface SessionOpeningContext { channelId: string; messageId: string; authorId: string; createdAt: string; content: string; attachments: Array<{ filename: string; mimeType: string; size: number }> }

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
      CREATE TABLE IF NOT EXISTS message_input_attachments(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attachment_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, local_path TEXT, status TEXT NOT NULL CHECK(status IN ('ready','failed')), error TEXT, PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS message_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, author_id TEXT, is_bot INTEGER, channel_id TEXT, discord_message_id TEXT, event_time TEXT, reply_to_message_id TEXT, reply_to_channel_id TEXT, webhook_id TEXT, source_kind TEXT, author_name TEXT);
      CREATE TABLE IF NOT EXISTS hindsight_pending(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS discord_outgoing_segments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, discord_message_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, created_at TEXT NOT NULL, reply_to_message_id TEXT, reply_to_channel_id TEXT);
      CREATE TABLE IF NOT EXISTS message_preparation(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('preparing','ready')), updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_batches(operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source_message_ids TEXT NOT NULL, document_id TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, batch_order INTEGER NOT NULL, status TEXT NOT NULL, submit_intended_at TEXT, last_poll_at TEXT, next_poll_at TEXT, error TEXT, created_at TEXT NOT NULL, UNIQUE(document_id,batch_order));
      CREATE TABLE IF NOT EXISTS memory_batch_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, operation_id TEXT NOT NULL REFERENCES memory_batches(operation_id));
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
      CREATE TABLE IF NOT EXISTS session_opening_context(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL, attachments_json TEXT NOT NULL);
    `);
    const batchColumns = new Set((this.db.prepare('PRAGMA table_info(memory_batches)').all() as Array<{ name: string }>).map(column => column.name));
    if (batchColumns.has('deadline')) this.db.exec('ALTER TABLE memory_batches DROP COLUMN deadline');
    const sourceColumns = new Set((this.db.prepare('PRAGMA table_info(message_sources)').all() as Array<{ name: string }>).map(column => column.name));
    if (!sourceColumns.has('reply_to_message_id')) this.db.exec('ALTER TABLE message_sources ADD COLUMN reply_to_message_id TEXT');
    if (!sourceColumns.has('reply_to_channel_id')) this.db.exec('ALTER TABLE message_sources ADD COLUMN reply_to_channel_id TEXT');
    if (!sourceColumns.has('webhook_id')) this.db.exec('ALTER TABLE message_sources ADD COLUMN webhook_id TEXT');
    if (!sourceColumns.has('source_kind')) this.db.exec('ALTER TABLE message_sources ADD COLUMN source_kind TEXT');
    if (!sourceColumns.has('author_name')) this.db.exec('ALTER TABLE message_sources ADD COLUMN author_name TEXT');
    const segmentColumns = new Set((this.db.prepare('PRAGMA table_info(discord_outgoing_segments)').all() as Array<{ name: string }>).map(column => column.name));
    if (!segmentColumns.has('reply_to_message_id')) this.db.exec('ALTER TABLE discord_outgoing_segments ADD COLUMN reply_to_message_id TEXT');
    if (!segmentColumns.has('reply_to_channel_id')) this.db.exec('ALTER TABLE discord_outgoing_segments ADD COLUMN reply_to_channel_id TEXT');
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

  addMessage(session: string, role: string, content: string, source: MessageSource = {}, attachments: MessageInputAttachment[] = []): StoredMessage {
    return this.addMessageOnce(session, role, content, source, attachments).message;
  }

  addMessageOnce(session: string, role: string, content: string, source: MessageSource = {}, attachments: MessageInputAttachment[] = []): AddMessageResult {
    const message: StoredMessage = { id: randomUUID(), sessionId: session, role, content, createdAt: source.eventTime ?? new Date().toISOString(), source, attachments, preparationStatus: 'preparing', discordSegments: [] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (source.discordMessageId) {
        const existing = this.db.prepare('SELECT message_id FROM message_sources WHERE discord_message_id=?').get(source.discordMessageId) as { message_id: string } | undefined;
        if (existing) { this.db.exec('COMMIT'); return { message: this.messagesWithSourcesForId(existing.message_id), created: false }; }
      }
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(message.id, session, role, content, message.createdAt);
      this.db.prepare('INSERT INTO message_sources(message_id,author_id,is_bot,channel_id,discord_message_id,event_time,reply_to_message_id,reply_to_channel_id,webhook_id,source_kind,author_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(message.id, source.authorId ?? null, source.isBot === undefined ? null : source.isBot ? 1 : 0, source.channelId ?? null, source.discordMessageId ?? null, source.eventTime ?? null, source.replyToMessageId ?? null, source.replyToChannelId ?? null, source.webhookId ?? null, source.sourceKind ?? null, source.authorName ?? null);
      this.db.prepare("INSERT INTO hindsight_pending(message_id,status,updated_at) VALUES(?,'pending',?)").run(message.id, message.createdAt);
      this.db.prepare("INSERT INTO message_preparation(message_id,status,updated_at) VALUES(?,'preparing',?)").run(message.id, message.createdAt);
      const insertAttachment = this.db.prepare('INSERT INTO message_input_attachments(message_id,attachment_id,filename,mime_type,size,local_path,status,error) VALUES(?,?,?,?,?,?,?,?)');
      for (const attachment of attachments) insertAttachment.run(message.id, attachment.attachmentId, attachment.filename, attachment.mimeType, attachment.size, attachment.localPath ?? null, attachment.status, attachment.error ?? null);
      this.db.exec('COMMIT');
      return { message, created: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateAttachments(messageId: string, attachments: MessageInputAttachment[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM message_input_attachments WHERE message_id=?').run(messageId);
      const insert = this.db.prepare('INSERT INTO message_input_attachments(message_id,attachment_id,filename,mime_type,size,local_path,status,error) VALUES(?,?,?,?,?,?,?,?)');
      for (const a of attachments) insert.run(messageId, a.attachmentId, a.filename, a.mimeType, a.size, a.localPath ?? null, a.status, a.error ?? null);
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
            console.error(`Outgoing message ${row.id} remains preparing after restart; no successful Discord segments exist, so its actual delivered content needs manual clarification.`);
          }
          continue;
        }
        this.db.prepare("UPDATE message_input_attachments SET status='failed',error='Attachment preparation interrupted by process restart; file was not read or downloaded during recovery.' WHERE message_id=? AND status='ready'").run(row.id);
        this.markPreparationReady(row.id, now);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  createOutgoing(session: string, content: string, source: MessageSource): StoredMessage {
    return this.addMessage(session, 'assistant', content, source, []);
  }

  createMemoryBatch(input: { operationId?: string; payload: string; sourceMessageIds: string[]; documentId: string; sessionId: string; channelId: string }): MemoryBatch {
    if (!input.sourceMessageIds.length || input.sourceMessageIds.length > 10) throw new Error('A memory batch must contain 1–10 source turns');
    const operationId = input.operationId ?? randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = new Set(input.sourceMessageIds);
      if (ids.size !== input.sourceMessageIds.length) throw new Error('Duplicate source message ID in batch');
      const alreadyBatched = this.db.prepare(`SELECT message_id FROM memory_batch_sources WHERE message_id IN (${input.sourceMessageIds.map(() => '?').join(',')}) LIMIT 1`).get(...input.sourceMessageIds) as { message_id: string } | undefined;
      if (alreadyBatched) throw new Error(`Source message ${alreadyBatched.message_id} is already in a frozen batch`);
      const eligible = this.db.prepare(`SELECT m.id,mp.status FROM messages m LEFT JOIN message_preparation mp ON mp.message_id=m.id LEFT JOIN hindsight_pending hp ON hp.message_id=m.id WHERE m.id IN (${input.sourceMessageIds.map(() => '?').join(',')}) AND hp.status='pending'`).all(...input.sourceMessageIds) as Array<{ id: string; status: string | null }>;
      if (eligible.length !== input.sourceMessageIds.length || eligible.some(row => row.status !== 'ready')) throw new Error('Batch sources must be pending and ready');
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
        if (pending.preparation !== 'ready') break;
        messages.push(m); if (messages.length >= 10) break;
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
  blockingMemoryBatch(documentId: string): MemoryBatch | undefined { const row = this.db.prepare("SELECT * FROM memory_batches WHERE document_id=? AND status!='completed' ORDER BY batch_order LIMIT 1").get(documentId) as any; return row && this.batchFromRow(row); }
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

  messagesWithSources(session: string): StoredMessage[] {
    const rows = this.db.prepare(`SELECT m.id,m.session_id,m.role,m.content,m.created_at,s.author_id,s.is_bot,s.channel_id,s.discord_message_id,s.event_time,s.reply_to_message_id,s.reply_to_channel_id,s.webhook_id,s.source_kind,s.author_name,mp.status preparation
      FROM messages m LEFT JOIN message_sources s ON s.message_id=m.id LEFT JOIN message_preparation mp ON mp.message_id=m.id WHERE m.session_id=? ORDER BY m.rowid`).all(session) as Array<{ id: string; session_id: string; role: string; content: string; created_at: string; author_id: string | null; is_bot: number | null; channel_id: string | null; discord_message_id: string | null; event_time: string | null; reply_to_message_id: string | null; reply_to_channel_id: string | null; webhook_id: string | null; source_kind: MessageSource['sourceKind'] | null; author_name: string | null; preparation: 'preparing' | 'ready' | null }>;
    const attachments = this.db.prepare('SELECT message_id,attachment_id,filename,mime_type,size,local_path,status,error FROM message_input_attachments WHERE message_id=?');
    const segments = this.db.prepare('SELECT channel_id,discord_message_id,content,created_at,reply_to_message_id,reply_to_channel_id FROM discord_outgoing_segments WHERE message_id=? ORDER BY rowid');
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, createdAt: row.created_at, preparationStatus: row.preparation ?? 'ready',
      source: { ...(row.author_id === null ? {} : { authorId: row.author_id }), ...(row.author_name === null ? {} : { authorName: row.author_name }), ...(row.is_bot === null ? {} : { isBot: row.is_bot === 1 }), ...(row.webhook_id === null ? {} : { webhookId: row.webhook_id }), ...(row.source_kind === null ? {} : { sourceKind: row.source_kind }), ...(row.channel_id === null ? {} : { channelId: row.channel_id }), ...(row.discord_message_id === null ? {} : { discordMessageId: row.discord_message_id }), ...(row.event_time === null ? {} : { eventTime: row.event_time }), ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }), ...(row.reply_to_channel_id === null ? {} : { replyToChannelId: row.reply_to_channel_id }) },
      attachments: (attachments.all(row.id) as Array<{ attachment_id: string; filename: string; mime_type: string; size: number; local_path: string | null; status: 'ready' | 'failed'; error: string | null }>).map(item => ({ attachmentId: item.attachment_id, filename: item.filename, mimeType: item.mime_type, size: item.size, ...(item.local_path ? { localPath: item.local_path } : {}), status: item.status, ...(item.error ? { error: item.error } : {}) })),
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
