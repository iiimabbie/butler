import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageAttachmentContent } from '../dist/input-attachments.js';

const message = attachment => ({
  id: 'persisted-message', sessionId: 'session', role: 'user', content: '',
  createdAt: '2026-10-12T00:00:00.000Z', source: {}, attachments: [attachment], discordSegments: [],
});

async function formatWithMime(mimeType, filename = 'persisted-markdown') {
  const root = await mkdtemp(join(tmpdir(), 'butler-input-file-mime-'));
  const dir = join(root, 'attachments');
  const textDir = join(dir, 'text');
  await mkdir(textDir, { recursive: true });
  const path = join(textDir, '123e4567-e89b-12d3-a456-426614174000-persisted-markdown');
  await writeFile(path, 'safe fixture text');
  try {
    const attachment = { attachmentId: 'persisted-attachment', filename, mimeType, status: 'ready', localPath: path };
    return (await messageAttachmentContent(message(attachment), dir))[1];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('persisted ready MIME parameters are removed before input_file data URL encoding', async () => {
  const formatted = await formatWithMime('text/markdown; charset=utf-8');
  assert.equal(formatted.type, 'input_file');
  assert.match(formatted.file_data, /^data:text\/markdown;base64,/);
});

test('valid persisted MIME remains unchanged in input_file data URL', async () => {
  const formatted = await formatWithMime('application/pdf');
  assert.equal(formatted.type, 'input_file');
  assert.match(formatted.file_data, /^data:application\/pdf;base64,/);
});

test('invalid persisted MIME uses the safe octet-stream fallback', async () => {
  const formatted = await formatWithMime('not a valid MIME; charset=utf-8');
  assert.equal(formatted.type, 'input_file');
  assert.match(formatted.file_data, /^data:application\/octet-stream;base64,/);
});
