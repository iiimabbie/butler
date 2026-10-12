import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CLEAR_TABLES, KEEP_TABLES, checkSchema, legacyBotChannelRows, resetChats,
} from '../scripts/clear-memory-and-chats.mjs';

function fixture({ legacyBotTable }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE channel_state(channel_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT);
    CREATE TABLE session_sources(session_id TEXT NOT NULL, channel_id TEXT NOT NULL, source_type TEXT NOT NULL, owner_id TEXT NOT NULL, bot_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(session_id,channel_id,source_type,owner_id,bot_id));
  `);
  for (const table of [...CLEAR_TABLES, ...KEEP_TABLES]) {
    if (['sessions', 'session_sources'].includes(table)) continue;
    db.exec(`CREATE TABLE "${table}"(id TEXT)`);
  }
  if (legacyBotTable) {
    db.exec(`CREATE TABLE bot_channel_state(channel_id TEXT NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(channel_id,bot_id));`);
  }
  return db;
}

function seed(db, legacyBotTable) {
  db.exec(`
    INSERT INTO sessions VALUES ('old-channel-session','now'), ('old-bot-session','now');
    INSERT INTO channel_state VALUES ('channel-a','old-channel-session','model-a');
    INSERT INTO session_sources VALUES ('old-channel-session','channel-a','owner','owner-a','');
  `);
  if (legacyBotTable) {
    db.exec(`
      INSERT INTO bot_channel_state VALUES ('channel-a','bot-a','old-bot-session');
      INSERT INTO session_sources VALUES ('old-bot-session','channel-a','bot','owner-a','bot-a');
    `);
  }
}

test('legacy bot_channel_state session references are remapped and validated', () => {
  const db = fixture({ legacyBotTable: true });
  try {
    seed(db, true);
    checkSchema(db);
    const channels = db.prepare('SELECT * FROM channel_state').all();
    const sources = db.prepare('SELECT * FROM session_sources').all();
    const bots = legacyBotChannelRows(db);
    assert.equal(bots.length, 1);

    resetChats(db, channels, bots, sources);

    const bot = db.prepare('SELECT * FROM bot_channel_state').get();
    assert.notEqual(bot.session_id, 'old-bot-session');
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(bot.session_id));
    assert.ok(db.prepare('SELECT 1 FROM session_sources WHERE session_id=? AND source_type=\'bot\'').get(bot.session_id));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_channel_state').get().n, 1, 'legacy table remains in place');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    for (const row of db.prepare('SELECT session_id FROM bot_channel_state').all()) {
      assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(row.session_id), 'legacy mapping must not point at a missing session');
    }
  } finally { db.close(); }
});

test('new schema without bot_channel_state still clears and remaps channel state', () => {
  const db = fixture({ legacyBotTable: false });
  try {
    seed(db, false);
    checkSchema(db);
    const channels = db.prepare('SELECT * FROM channel_state').all();
    const sources = db.prepare('SELECT * FROM session_sources').all();
    assert.equal(legacyBotChannelRows(db), undefined);

    resetChats(db, channels, legacyBotChannelRows(db), sources);

    const channel = db.prepare('SELECT * FROM channel_state').get();
    assert.notEqual(channel.session_id, 'old-channel-session');
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(channel.session_id));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_channel_state'").get(), undefined, 'new schema stays free of the retired table');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});
