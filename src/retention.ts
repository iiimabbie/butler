import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logError, logInfo } from './log.js';
import type { Store } from './store.js';

const ATTACHMENT_DAYS = 90;
// Attachment files sit directly in their category directory; .video-cache holds one directory per processed video.
const ATTACHMENT_DIRECTORIES = ['images', 'audio', 'video', 'documents', 'spreadsheets', 'text', 'archives', 'other', '.video-cache'];

// Deletes attachment originals and video caches older than 90 days; the message keeps its Discord IDs for discord_read.
function pruneAttachments(attachmentDir: string): number {
  const cutoff = Date.now() - ATTACHMENT_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const name of ATTACHMENT_DIRECTORIES) {
    const directory = join(attachmentDir, name);
    let entries: string[];
    try { entries = readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      deleted++;
    }
  }
  return deleted;
}

// Runs at startup and daily; each step is independent so one failure does not skip the other.
export function runRetention(store: Store, attachmentDir: string): void {
  let toolCalls = { deleted: 0, compacted: 0 }, attachmentsDeleted = 0;
  try { toolCalls = store.retainToolCalls(); } catch (error) { logError('Retention tool_calls step failed', error); }
  try { attachmentsDeleted = pruneAttachments(attachmentDir); } catch (error) { logError('Retention attachments step failed', error); }
  logInfo('Retention completed', { toolCallsDeleted: toolCalls.deleted, toolCallsCompacted: toolCalls.compacted, attachmentsDeleted });
}
