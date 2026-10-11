import { ToolUsageError } from './tool-errors.js';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GoogleClient, GOOGLE_FILE_LIMIT } from './google-client.js';

const str = { type: 'string' };
const count = (max: number, fallback: number) => ({ type: 'integer', minimum: 1, maximum: max, default: fallback });
const schemas: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  google_gmail_search: { description: 'Search Gmail and return message metadata.', properties: { query: str, max_results: count(100, 10), page_token: str }, required: ['query'] },
  google_gmail_read: { description: 'Read plain text when available, otherwise raw HTML, plus attachment metadata; attachments are not downloaded.', properties: { message_id: str }, required: ['message_id'] },
  google_gmail_send: { description: 'Send a plain-text email to one recipient.', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] },
  google_gmail_create_draft: { description: 'Create an unsent plain-text email draft for one recipient.', properties: { to: str, subject: str, body: str }, required: ['to', 'subject', 'body'] },
  google_calendar_list_events: { description: 'List calendar events; defaults to the primary calendar, start=now, and end=start+7 days. Timed values need timezone offsets.', properties: { calendar_id: str, start: str, end: str, max_results: count(250, 20), page_token: str }, required: [] },
  google_calendar_create_event: { description: 'Create a calendar event. Set all_day=true for YYYY-MM-DD dates; end is the day after the last included day. Timed values use RFC3339 with timezone offsets. Defaults to the primary calendar.', properties: { summary: str, start: str, end: str, all_day: { type: 'boolean' }, description: str, location: str, calendar_id: str }, required: ['summary', 'start', 'end'] },
  google_calendar_update_event: { description: 'Update supplied event fields only. Omit all_day to preserve the event type; setting it requires both start and end. All-day dates use YYYY-MM-DD with end one day after the last included day; timed values use RFC3339 with timezone offsets. Defaults to the primary calendar.', properties: { event_id: str, calendar_id: str, summary: str, start: str, end: str, all_day: { type: 'boolean' }, description: str, location: str }, required: ['event_id'] },
  google_calendar_delete_event: { description: 'Delete a calendar event. Defaults to the primary calendar.', properties: { event_id: str, calendar_id: str }, required: ['event_id'] },
  google_tasks_lists: { description: "List the authenticated user's Google Tasks task lists (the lists themselves, not the tasks inside a list). Returns each list's name and ID; use page_token to fetch another page.", properties: { max_results: count(1000, 20), page_token: str }, required: [] },
  google_tasks_list: { description: 'List tasks; defaults to @default and excludes completed tasks.', properties: { task_list_id: str, show_completed: { type: 'boolean', default: false }, max_results: count(100, 20), page_token: str }, required: [] },
  google_tasks_create: { description: 'Create a task. Before adding, use google_tasks_lists to get available list names and IDs; choose the suitable list based on the task content and purpose, prioritizing any list explicitly specified by the user. If the right list is reasonably clear, decide without asking; ask only when a material classification ambiguity cannot be resolved. Set task_list_id to the chosen list ID. If omitted, the existing @default behavior is retained.', properties: { title: str, notes: str, task_list_id: str }, required: ['title'] },
  google_tasks_update: { description: 'Update supplied task fields; empty notes clears notes. Defaults to @default.', properties: { task_id: str, title: str, notes: str, task_list_id: str }, required: ['task_id'] },
  google_tasks_complete: { description: 'Mark a task completed; defaults to @default.', properties: { task_id: str, task_list_id: str }, required: ['task_id'] },
  google_tasks_delete: { description: 'Delete a task; defaults to @default.', properties: { task_id: str, task_list_id: str }, required: ['task_id'] },
  google_drive_search: { description: 'Search Drive by filename substring, excluding trash.', properties: { query: str, max_results: count(100, 10), page_token: str }, required: ['query'] },
  google_drive_read: { description: 'Read text files, export Docs/Slides as plain text, or export the first sheet of Sheets as CSV. Folders, shortcuts, binary files, and other types are unsupported.', properties: { file_id: str }, required: ['file_id'] },
  google_drive_upload: { description: 'Create a new Drive file; never overwrite. Provide content or file_path, not both. file_path must be inside the configured attachment directory; relative paths use that directory.', properties: { name: str, content: str, file_path: str, mime_type: str, folder_id: str }, required: ['name'] },
};
export const googleDefinitions = Object.entries(schemas).map(([name, s]) => ({ type: 'function', name, description: s.description, parameters: { type: 'object', properties: s.properties, required: s.required, additionalProperties: false } }));
export type GoogleToolRuntime = { definitions: typeof googleDefinitions; available(): Promise<boolean>; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
export function createGoogleToolRuntime(client: GoogleClient, attachmentDir?: string): GoogleToolRuntime {
  return { definitions: googleDefinitions, available: () => client.available(), execute: (name, args) => execute(client, name, args, attachmentDir) };
}

async function execute(c: GoogleClient, n: string, a: Record<string, unknown>, attachmentDir?: string): Promise<unknown> {
  validate(n, a);
  const s = (k: string, fallback?: string): string => a[k] === undefined ? fallback ?? '' : a[k] as string;
  const number = (k: string, fallback: number): number => a[k] === undefined ? fallback : a[k] as number;
  const calendar = `/calendar/v3/calendars/${encodeURIComponent(s('calendar_id', 'primary'))}/events`;
  const tasks = `/tasks/v1/lists/${encodeURIComponent(s('task_list_id', '@default'))}/tasks`;
  if (n === 'google_gmail_search') {
    const r = await c.request('/gmail/v1/users/me/messages', { query: { q: s('query'), maxResults: number('max_results', 10), pageToken: s('page_token') || undefined } });
    const messages = [];
    for (const m of r.messages ?? []) {
      const meta = await c.request(`/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { query: { format: 'metadata' } });
      messages.push({ id: meta.id, thread_id: meta.threadId, snippet: meta.snippet, internal_date: meta.internalDate, labels: meta.labelIds, headers: headers(meta.payload?.headers) });
    }
    return { messages, next_page_token: r.nextPageToken ?? null, result_size_estimate: r.resultSizeEstimate };
  }
  if (n === 'google_gmail_read') {
    const r = await c.request(`/gmail/v1/users/me/messages/${encodeURIComponent(s('message_id'))}`, { query: { format: 'full' } });
    return { id: r.id, thread_id: r.threadId, internal_date: r.internalDate, headers: headers(r.payload?.headers), body: decodeMessage(r.payload), attachments: attachmentMetadata(r.payload) };
  }
  if (n === 'google_gmail_send' || n === 'google_gmail_create_draft') {
    const raw = Buffer.from(makeMime(s('to'), s('subject'), s('body')), 'utf8').toString('base64url');
    const draft = n === 'google_gmail_create_draft';
    return c.request(draft ? '/gmail/v1/users/me/drafts' : '/gmail/v1/users/me/messages/send', { method: 'POST', body: draft ? { message: { raw } } : { raw } });
  }
  if (n === 'google_calendar_list_events') {
    const start = s('start', new Date().toISOString());
    timed(start);
    const end = s('end', new Date(Date.parse(start) + 7 * 864e5).toISOString());
    timeRange(start, end, false);
    const r = await c.request(calendar, { query: { timeMin: start, timeMax: end, maxResults: number('max_results', 20), pageToken: s('page_token') || undefined, singleEvents: true, orderBy: 'startTime' } });
    return { items: r.items ?? [], next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'google_calendar_create_event' || n === 'google_calendar_update_event') {
    const create = n === 'google_calendar_create_event';
    const body: Record<string, unknown> = {};
    for (const k of ['summary', 'description', 'location']) if (a[k] !== undefined) body[k] = s(k);
    const hasTime = a.start !== undefined || a.end !== undefined || a.all_day !== undefined;
    if (create || hasTime) {
      if (a.all_day !== undefined && (a.start === undefined || a.end === undefined)) throw new ToolUsageError('Setting all_day requires both start and end');
      const old = !create && a.all_day === undefined ? await c.request(`${calendar}/${encodeURIComponent(s('event_id'))}`) : undefined;
      const all = a.all_day === undefined ? Boolean(old?.start?.date) : a.all_day as boolean;
      const start = s('start', old?.start?.date ?? old?.start?.dateTime);
      const end = s('end', old?.end?.date ?? old?.end?.dateTime);
      timeRange(start, end, all);
      if (a.start !== undefined) body.start = all ? { date: start } : { dateTime: start };
      if (a.end !== undefined) body.end = all ? { date: end } : { dateTime: end };
      if (!create && a.all_day !== undefined) {
        const opposite = all ? 'dateTime' : 'date';
        (body.start as Record<string, unknown>)[opposite] = null;
        (body.end as Record<string, unknown>)[opposite] = null;
      }
    }
    if (!Object.keys(body).length) throw new ToolUsageError('At least one event field must be supplied');
    return c.request(create ? calendar : `${calendar}/${encodeURIComponent(s('event_id'))}`, { method: create ? 'POST' : 'PATCH', body });
  }
  if (n === 'google_calendar_delete_event') return c.request(`${calendar}/${encodeURIComponent(s('event_id'))}`, { method: 'DELETE' });
  if (n === 'google_tasks_lists') {
    const r = await c.request('/tasks/v1/users/@me/lists', { query: { maxResults: number('max_results', 20), pageToken: s('page_token') || undefined } });
    return { items: (r.items ?? []).map((list: Record<string, unknown>) => ({ id: list.id, name: list.title })), next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'google_tasks_list') {
    const r = await c.request(tasks, { query: { showCompleted: a.show_completed as boolean ?? false, showHidden: a.show_completed as boolean ?? false, maxResults: number('max_results', 20), pageToken: s('page_token') || undefined } });
    return { items: (r.items ?? []).map(withoutTaskDue), next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'google_tasks_create' || n === 'google_tasks_update') {
    const body: Record<string, unknown> = {};
    for (const k of ['title', 'notes']) if (a[k] !== undefined) body[k] = s(k);
    if (!Object.keys(body).length) throw new ToolUsageError('At least one task field must be supplied');
    const create = n === 'google_tasks_create';
    return withoutTaskDue(await c.request(create ? tasks : `${tasks}/${encodeURIComponent(s('task_id'))}`, { method: create ? 'POST' : 'PATCH', body }));
  }
  if (n === 'google_tasks_complete') return withoutTaskDue(await c.request(`${tasks}/${encodeURIComponent(s('task_id'))}`, { method: 'PATCH', body: { status: 'completed' } }));
  if (n === 'google_tasks_delete') return c.request(`${tasks}/${encodeURIComponent(s('task_id'))}`, { method: 'DELETE' });
  if (n === 'google_drive_search') {
    const q = `name contains '${s('query').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
    const r = await c.request('/drive/v3/files', { query: { q, fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink),nextPageToken', pageSize: number('max_results', 10), pageToken: s('page_token') || undefined } });
    return { files: r.files ?? [], next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'google_drive_read') {
    const path = `/drive/v3/files/${encodeURIComponent(s('file_id'))}`;
    const file = await c.request(path, { query: { fields: 'id,name,mimeType,size' } });
    const exports: Record<string, string> = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.presentation': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv' };
    const mime = exports[file.mimeType];
    if (!mime && !(typeof file.mimeType === 'string' && file.mimeType.startsWith('text/'))) throw new Error('This Drive file type is not supported (text, Docs, Slides and Sheets only; no folders or shortcuts)');
    if (Number(file.size) > GOOGLE_FILE_LIMIT) throw new Error('Google file exceeds the 10 MiB read limit');
    const result = await c.request(mime ? `${path}/export` : path, { query: mime ? { mimeType: mime } : { alt: 'media' }, raw: true });
    return { file, ...(mime ? { exported_as: mime } : {}), ...(mime === 'text/csv' ? { scope_note: 'Only the first sheet is exported as CSV.' } : {}), content: result.bytes.toString('utf8') };
  }
  if (n === 'google_drive_upload') {
    if ((a.content !== undefined) === (a.file_path !== undefined)) throw new ToolUsageError('Provide exactly one of content or file_path');
    const bytes = a.file_path !== undefined ? await attachment(s('file_path'), attachmentDir) : Buffer.from(s('content'), 'utf8');
    if (bytes.length > GOOGLE_FILE_LIMIT) throw new Error('Upload exceeds the 10 MiB limit');
    const mime = s('mime_type', 'text/plain');
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime)) throw new ToolUsageError('mime_type must be a MIME type without parameters or newlines');
    const metadata: Record<string, unknown> = { name: s('name'), mimeType: mime };
    if (a.folder_id !== undefined) metadata.parents = [s('folder_id')];
    const boundary = `butler_${randomBytes(24).toString('hex')}`;
    const form = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return c.request('/upload/drive/v3/files', { method: 'POST', query: { uploadType: 'multipart', fields: 'id,name,mimeType,size,webViewLink' }, upload: { bytes: form, contentType: `multipart/related; boundary=${boundary}` } });
  }
  throw new ToolUsageError('Unknown Google tool');
}

// Todos do not use due dates; leave existing Google data unchanged and omit it from tool results.
function withoutTaskDue(task: Record<string, unknown>): Record<string, unknown> {
  const { due: _due, ...result } = task;
  return result;
}

function validate(name: string, args: Record<string, unknown>): void {
  const schema = schemas[name];
  if (!schema) throw new ToolUsageError('Unknown Google tool');
  for (const key of schema.required) if (args[key] === undefined) throw new ToolUsageError(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key] as { type: string; minimum?: number; maximum?: number } | undefined;
    if (!rule) throw new ToolUsageError('Unknown Google tool argument');
    if (rule.type === 'string') {
      const emptyAllowed = ['body', 'subject', 'content', 'notes', 'description', 'location', 'page_token'].includes(key);
      if (typeof value !== 'string' || (!value && !emptyAllowed)) throw new ToolUsageError(`${key} must be a ${emptyAllowed ? '' : 'non-empty '}string`);
    } else if (rule.type === 'boolean' && typeof value !== 'boolean') throw new ToolUsageError(`${key} must be boolean`);
    else if (rule.type === 'integer' && (!Number.isSafeInteger(value) || (value as number) < rule.minimum! || (value as number) > rule.maximum!)) throw new ToolUsageError(`${key} must be an integer from ${rule.minimum} to ${rule.maximum}`);
  }
}
function dateOnly(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new ToolUsageError('Date must be a valid YYYY-MM-DD');
}
function timed(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ToolUsageError('Time must be RFC3339 with a timezone offset');
  dateOnly(value.slice(0, 10));
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59) throw new ToolUsageError('Invalid RFC3339 time');
}
function timeRange(start: string, end: string, all: boolean): void {
  if (all) { dateOnly(start); dateOnly(end); } else { timed(start); timed(end); }
  if (Date.parse(end) <= Date.parse(start)) throw new ToolUsageError('end must be after start (all-day end is exclusive)');
}
async function attachment(file: string, directory?: string): Promise<Buffer> {
  if (!directory) throw new Error('Attachment directory is not configured');
  let handle;
  try {
    const root = await realpath(directory);
    const target = await realpath(isAbsolute(file) ? file : resolve(root, file));
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > GOOGLE_FILE_LIMIT) throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > info.size) throw new Error();
    return bytes.subarray(0, size);
  } catch { throw new Error('Attachment must be an accessible regular file inside the configured attachment directory, no larger than 10 MiB; symlink escapes are rejected'); }
  finally { await handle?.close(); }
}
function headers(rows: any[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of rows) if (typeof h.name === 'string' && typeof h.value === 'string') out[h.name.toLowerCase()] = h.value;
  return out;
}
function decodeMessage(part: any): string {
  const plain: any[] = [], html: any[] = [];
  const walk = (p: any) => {
    if (!p || p.filename) return;
    if (typeof p.body?.data === 'string' && ['text/plain', 'text/html'].includes(p.mimeType)) (p.mimeType === 'text/plain' ? plain : html).push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  const selected = plain.length ? plain : html;
  const text = selected.map(decodeMimePart).join('\n');
  return !plain.length && html.length ? `[原始 HTML 郵件內容]\n${text}` : text;
}
function decodeMimePart(part: any): string {
  const contentType = headers(part.headers)['content-type'] ?? '';
  const charsetMatch = contentType.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
  if (!charsetMatch && /(?:^|;)\s*charset\s*=/i.test(contentType)) throw new Error('Gmail MIME charset declaration is invalid');
  const charset = (charsetMatch?.[1] ?? charsetMatch?.[2] ?? 'us-ascii').trim();
  const bytes = Buffer.from(part.body.data, 'base64url');
  if (/^(?:us-ascii|ascii)$/i.test(charset) && bytes.some(byte => byte > 127)) throw new Error('Gmail MIME body contains non-ASCII bytes without an appropriate charset');
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset, { fatal: true }); }
  catch { throw new Error('Gmail MIME charset is not supported; message body was not decoded'); }
  try { return decoder.decode(bytes); }
  catch { throw new Error('Gmail MIME body is invalid for its declared charset; message body was not decoded'); }
}
function attachmentMetadata(part: any): unknown[] {
  const out: unknown[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename) out.push({ filename: p.filename, mime_type: p.mimeType, size: p.body?.size, attachment_id: p.body?.attachmentId ?? null });
    for (const x of p.parts ?? []) walk(x);
  };
  walk(part);
  return out;
}
function makeMime(to: string, subject: string, body: string): string {
  if (/[\r\n\x00]/.test(to) || /[\r\n\x00]/.test(subject) || /[,;]/.test(to)) throw new ToolUsageError('Provide one recipient; recipient and subject cannot contain CR, LF or NUL');
  const encoded = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const subjectWords = [];
  let chunk = '';
  for (const char of subject) { if (Buffer.byteLength(chunk + char) > 42) { subjectWords.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; } chunk += char; }
  if (chunk) subjectWords.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return `To: ${to}\r\nSubject: ${subjectWords.join('\r\n ')}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`;
}
