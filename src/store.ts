import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Message {
  role: string;
  content: string;
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

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS channel_state(channel_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT);
      CREATE TABLE IF NOT EXISTS channel_modes(channel_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('queue','steer')));
      CREATE TABLE IF NOT EXISTS restart_notice(id INTEGER PRIMARY KEY CHECK(id=1), channel_id TEXT NOT NULL, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_actions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, buttons TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_action_claims(custom_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL, result TEXT, claimed_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS attachment_deliveries(tool_call_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_settings(id INTEGER PRIMARY KEY CHECK(id=1), bot_reply INTEGER NOT NULL CHECK(bot_reply IN (0,1)));
      CREATE TABLE IF NOT EXISTS bot_channel_state(channel_id TEXT NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(channel_id,bot_id));
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

  addMessage(session: string, role: string, content: string): void {
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(randomUUID(), session, role, content, new Date().toISOString());
  }

  messages(session: string): Message[] {
    return this.db.prepare('SELECT role,content FROM messages WHERE session_id=? ORDER BY rowid').all(session) as unknown as Message[];
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
    return this.db.prepare('SELECT s.id,s.created_at,(SELECT content FROM messages m WHERE m.session_id=s.id ORDER BY rowid DESC LIMIT 1) latest FROM sessions s ORDER BY rowid DESC LIMIT 50').all();
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

  channelState(channelId: string, defaultModel: string): { sessionId: string; model: string } {
    const row = this.db.prepare('SELECT session_id,model FROM channel_state WHERE channel_id=?').get(channelId) as { session_id: string; model: string | null } | undefined;
    if (row) return { sessionId: row.session_id, model: row.model ?? defaultModel };
    const sessionId = this.newSession();
    this.db.prepare('INSERT INTO channel_state(channel_id,session_id,model) VALUES(?,?,NULL)').run(channelId, sessionId);
    return { sessionId, model: defaultModel };
  }

  setChannelSession(channelId: string, sessionId: string): void {
    this.db.prepare('UPDATE channel_state SET session_id=? WHERE channel_id=?').run(sessionId, channelId);
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

  botSession(channelId: string, botId: string): string {
    const row = this.db.prepare('SELECT session_id FROM bot_channel_state WHERE channel_id=? AND bot_id=?').get(channelId, botId) as { session_id: string } | undefined;
    if (row) return row.session_id;
    const sessionId = this.newSession();
    this.db.prepare('INSERT INTO bot_channel_state VALUES(?,?,?)').run(channelId, botId, sessionId);
    return sessionId;
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

  close(): void {
    this.db.close();
  }
}
