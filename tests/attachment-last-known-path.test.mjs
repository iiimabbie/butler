import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';
import { messageAttachmentContent } from '../dist/input-attachments.js';

const attachment = localPath => ({ attachmentId: 'attachment-test', filename: 'sample.txt', mimeType: 'text/plain', status: 'ready', localPath });

test('new attachment schema omits size and reports a missing last-known path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'butler-attachment-last-known-'));
  const store = new Store(':memory:');
  try {
    const columns = store.db.prepare('PRAGMA table_info(message_input_attachments)').all().map(column => column.name);
    assert.equal(columns.includes('size'), false);
    const session = store.newSession();
    const path = join(root, 'text', `${randomUUID()}-sample.txt`);
    const message = store.addMessage(session, 'user', 'Please inspect.', {}, [attachment(path)]);
    const input = await messageAttachmentContent(message, root);
    assert.ok(input.some(block => block.type === 'input_text' && /附件目前不可用；最後已知位置無法讀取/.test(block.text)));
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('existing NOT NULL size schema needs the documented manual migration before attachment inserts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'butler-legacy-attachment-schema-'));
  const database = join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE message_input_attachments(
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
      size INTEGER NOT NULL, local_path TEXT, status TEXT NOT NULL CHECK(status IN ('ready','failed')),
      error TEXT, origin TEXT, memory_document_id TEXT, transcript TEXT, transcription_error TEXT,
      PRIMARY KEY(message_id,attachment_id)
    );
  `);
  legacy.close();
  const store = new Store(database);
  try {
    const session = store.newSession();
    assert.throws(() => store.addMessage(session, 'user', 'Fixture only.', {}, [attachment(undefined)]), /NOT NULL constraint failed: message_input_attachments\.size/);
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
