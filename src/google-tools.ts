import { ToolUsageError } from './tool-errors.js';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { decodeHTML } from 'entities';
import { GoogleClient, GOOGLE_FILE_LIMIT } from './google-client.js';

const str = { type: 'string' };
const count = (max: number, fallback: number) => ({ type: 'integer', minimum: 1, maximum: max, default: fallback });
const account = { type: 'string', description: 'Account email; omit to use the default account. Use google_accounts_list to list accounts.' };
const messageIds = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, uniqueItems: true };
const recipients = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Email addresses without display names.' };
const schemas: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  google_accounts_list: { description: 'List Google accounts, default status, connection status and gmail.modify permission.', properties: {}, required: [] },
  gmail_trash: { description: 'Move messages to Trash, not permanent deletion. Gmail automatically permanently deletes them after 30 days. Omit account to use the default; use google_accounts_list to list accounts.', properties: { message_ids: messageIds, account }, required: ['message_ids'] },
  gmail_untrash: { description: 'Restore messages from Trash. Omit account to use the default; use google_accounts_list to list accounts.', properties: { message_ids: messageIds, account }, required: ['message_ids'] },
  google_gmail_search: { description: 'Search Gmail and return message metadata. Omit account to use the default; use google_accounts_list to list accounts.', properties: { query: str, max_results: count(100, 10), page_token: str, account }, required: ['query'] },
  google_gmail_read: { description: 'Read plain text when available, otherwise raw HTML, plus attachment metadata; attachments are not downloaded. Omit account to use the default; use google_accounts_list to list accounts.', properties: { message_id: str, account }, required: ['message_id'] },
  gmail_send: { description: 'Send an email to multiple recipients, automatically appending the account’s Gmail signature. Omit account to use the default; use google_accounts_list to list accounts.', properties: { to: recipients, cc: recipients, bcc: recipients, subject: str, body: str, account }, required: ['to', 'subject', 'body'] },
  gmail_draft: { description: 'Create an unsent email draft for multiple recipients, automatically appending the account’s Gmail signature. Omit account to use the default; use google_accounts_list to list accounts.', properties: { to: recipients, cc: recipients, bcc: recipients, subject: str, body: str, account }, required: ['to', 'subject', 'body'] },
  google_calendar_list_events: { description: 'List calendar events; defaults to the primary calendar, start=now, and end=start+7 days. Timed values need timezone offsets.', properties: { calendar_id: str, start: str, end: str, max_results: count(250, 20), page_token: str }, required: [] },
  calendar_create: { description: 'Create a calendar event. Set all_day=true for YYYY-MM-DD dates; end is the day after the last included day. Timed values use RFC3339 with timezone offsets. Defaults to the primary calendar.', properties: { summary: str, start: str, end: str, all_day: { type: 'boolean' }, description: str, location: str, calendar_id: str, recurrence: { type: 'array', items: { type: 'string' } }, time_zone: str }, required: ['summary', 'start', 'end'] },
  calendar_update: { description: 'Update supplied event fields only. Omit all_day to preserve the event type; setting it requires both start and end. All-day dates use YYYY-MM-DD with end one day after the last included day; timed values use RFC3339 with timezone offsets. Defaults to the primary calendar.', properties: { event_id: str, calendar_id: str, summary: str, start: str, end: str, all_day: { type: 'boolean' }, description: str, location: str, recurrence: { type: 'array', items: { type: 'string' } }, time_zone: str }, required: ['event_id'] },
  calendar_delete: { description: 'Delete a calendar event. Defaults to the primary calendar.', properties: { event_id: str, calendar_id: str }, required: ['event_id'] },
  tasks_lists: { description: "List the authenticated user's Google Tasks task lists (the lists themselves, not the tasks inside a list). Returns each list's name and ID; use page_token to fetch another page.", properties: { max_results: count(1000, 20), page_token: str }, required: [] },
  tasks_list: { description: 'List tasks; defaults to @default and excludes completed tasks.', properties: { task_list_id: str, show_completed: { type: 'boolean', default: false }, max_results: count(100, 20), page_token: str }, required: [] },
  tasks_create: { description: 'Create a task in task_list_id (list IDs come from tasks_lists); defaults to @default.', properties: { title: str, notes: str, task_list_id: str }, required: ['title'] },
  tasks_update: { description: 'Update supplied task fields; empty notes clears notes. Defaults to @default.', properties: { task_id: str, title: str, notes: str, task_list_id: str }, required: ['task_id'] },
  tasks_complete: { description: 'Mark a task completed; defaults to @default.', properties: { task_id: str, task_list_id: str }, required: ['task_id'] },
  tasks_delete: { description: 'Delete a task; defaults to @default.', properties: { task_id: str, task_list_id: str }, required: ['task_id'] },
  google_drive_search: { description: 'Search Drive by filename substring, excluding trash.', properties: { query: str, max_results: count(100, 10), page_token: str }, required: ['query'] },
  google_drive_read: { description: 'Read text files, export Docs/Slides as plain text, or export the first sheet of Sheets as CSV. Folders, shortcuts, binary files, and other types are unsupported.', properties: { file_id: str }, required: ['file_id'] },
  google_drive_upload: { description: 'Create a new Drive file; never overwrite. Provide content or file_path, not both. file_path must be inside the configured attachment directory; relative paths use that directory.', properties: { name: str, content: str, file_path: str, mime_type: str, folder_id: str }, required: ['name'] },
};
const googleGroups: Record<string, Record<string, string>> = {
  google_gmail_manage: { send: 'gmail_send', create_draft: 'gmail_draft', trash: 'gmail_trash', untrash: 'gmail_untrash' },
  google_calendar_manage: { create: 'calendar_create', update: 'calendar_update', delete: 'calendar_delete' },
  google_tasks_read: { lists: 'tasks_lists', list: 'tasks_list' },
  google_tasks_manage: { create: 'tasks_create', update: 'tasks_update', complete: 'tasks_complete', delete: 'tasks_delete' },
};
const googleGroupDescriptions: Record<string, string> = {
  google_gmail_manage: `Manage Gmail messages.\nsend — Send an email to multiple recipients, automatically appending the account’s Gmail signature; required to, subject, body; optional cc, bcc.\ncreate_draft — Create an unsent email draft for multiple recipients, automatically appending the account’s Gmail signature; required to, subject, body; optional cc, bcc.\ntrash — Move messages to Trash, not permanent deletion; Gmail permanently deletes them after 30 days; required message_ids.\nuntrash — Restore messages from Trash; required message_ids.`,
  google_calendar_manage: `Create, update or delete calendar events.\ncreate — Create an event; required summary, start, end; all_day uses YYYY-MM-DD with exclusive end, timed values need RFC3339 offsets; optional recurrence as RFC 5545 lines (e.g. RRULE:FREQ=YEARLY), timed recurring events also need time_zone (IANA); defaults to primary calendar.\nupdate — Update supplied event fields only; required event_id; omit all_day to preserve type, setting it requires start and end; recurrence=[] removes repetition; defaults to primary calendar.\ndelete — Delete an event; required event_id; defaults to primary calendar.`,
  google_tasks_read: `Read Google Tasks lists and tasks.\nlists — List task lists, not their tasks; returns names and IDs; optional page_token.\nlist — List tasks; defaults to @default and excludes completed tasks; optional task_list_id, show_completed, max_results, page_token.`,
  google_tasks_manage: `Manage Google Tasks.\ncreate — Create a task; required title; optional notes and task_list_id (list IDs come from google_tasks_read action=lists); defaults to @default.\nupdate — Update supplied task fields; required task_id; empty notes clears notes; defaults to @default.\ncomplete — Mark a task completed; required task_id; defaults to @default.\ndelete — Delete a task; required task_id; defaults to @default.`,
};
function mergedDefinition(name: string, actions: Record<string, string>) {
  const members = Object.values(actions).map(operation => schemas[operation]!);
  const properties = Object.assign({}, ...members.map(schema => schema.properties));
  return { type: 'function', name, description: googleGroupDescriptions[name]!, parameters: { type: 'object', properties: { action: { type: 'string', enum: Object.keys(actions) }, ...properties }, required: ['action'], additionalProperties: false } };
}
const groupedOperations = new Set(Object.values(googleGroups).flatMap(group => Object.values(group)));
export const googleDefinitions = [
  ...Object.entries(googleGroups).map(([name, actions]) => mergedDefinition(name, actions)),
  ...Object.entries(schemas).filter(([name]) => !groupedOperations.has(name)).map(([name, schema]) => ({ type: 'function', name, description: schema.description, parameters: { type: 'object', properties: schema.properties, required: schema.required, additionalProperties: false } })),
];
export type GoogleToolRuntime = { definitions: typeof googleDefinitions; available(): Promise<boolean>; execute(name: string, args: Record<string, unknown>): Promise<unknown> };
export function createGoogleToolRuntime(client: GoogleClient, attachmentDir?: string): GoogleToolRuntime {
  return { definitions: googleDefinitions, available: () => client.available(), execute: (name, args) => {
    if (!Object.hasOwn(googleGroups, name)) { if (groupedOperations.has(name)) throw new ToolUsageError('Unknown Google tool'); return execute(client, name, args, attachmentDir); }
    const actions = googleGroups[name]!;
    if (typeof args.action !== 'string' || !Object.hasOwn(actions, args.action)) throw new ToolUsageError(`Unknown or missing action. Valid actions: ${Object.keys(actions).join(', ')}`);
    const { action, ...operationArgs } = args;
    return execute(client, actions[action as string]!, operationArgs, attachmentDir);
  } };
}

async function execute(c: GoogleClient, n: string, a: Record<string, unknown>, attachmentDir?: string): Promise<unknown> {
  validate(n, a);
  const s = (k: string, fallback?: string): string => a[k] === undefined ? fallback ?? '' : a[k] as string;
  const number = (k: string, fallback: number): number => a[k] === undefined ? fallback : a[k] as number;
  const calendar = `/calendar/v3/calendars/${encodeURIComponent(s('calendar_id', 'primary'))}/events`;
  const tasks = `/tasks/v1/lists/${encodeURIComponent(s('task_list_id', '@default'))}/tasks`;
  if (n === 'google_accounts_list') return { accounts: await c.accounts() };
  const gmailAccount = /^(google_)?gmail_/.test(n) ? await c.account(a.account as string | undefined) : undefined;
  if (n === 'gmail_trash' || n === 'gmail_untrash') {
    await c.requireModify(gmailAccount!);
    const action = n === 'gmail_trash' ? 'trash' : 'untrash';
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of a.message_ids as string[]) {
      try { await c.request(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}/${action}`, { account: gmailAccount, method: 'POST' }); results.push({ id, ok: true }); }
      catch (error) { results.push({ id, ok: false, error: error instanceof Error ? error.message : 'Google API request failed' }); }
    }
    return { results };
  }
  if (n === 'google_gmail_search') {
    const r = await c.request('/gmail/v1/users/me/messages', { account: gmailAccount, query: { q: s('query'), maxResults: number('max_results', 10), pageToken: s('page_token') || undefined } });
    const messages = [];
    for (const m of r.messages ?? []) {
      const meta = await c.request(`/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { account: gmailAccount, query: { format: 'metadata' } });
      messages.push({ id: meta.id, thread_id: meta.threadId, snippet: meta.snippet, internal_date: meta.internalDate, labels: meta.labelIds, headers: headers(meta.payload?.headers) });
    }
    return { messages, next_page_token: r.nextPageToken ?? null, result_size_estimate: r.resultSizeEstimate };
  }
  if (n === 'google_gmail_read') {
    const r = await c.request(`/gmail/v1/users/me/messages/${encodeURIComponent(s('message_id'))}`, { account: gmailAccount, query: { format: 'full' } });
    return { id: r.id, thread_id: r.threadId, internal_date: r.internalDate, headers: headers(r.payload?.headers), body: decodeMessage(r.payload), attachments: attachmentMetadata(r.payload) };
  }
  if (n === 'gmail_send' || n === 'gmail_draft') {
    const to = parseRecipients('to', a.to);
    const cc = a.cc === undefined ? [] : parseRecipients('cc', a.cc);
    const bcc = a.bcc === undefined ? [] : parseRecipients('bcc', a.bcc);
    let sendAs;
    try { sendAs = await c.request('/gmail/v1/users/me/settings/sendAs', { account: gmailAccount }); }
    catch { /* A signature lookup failure must not prevent sending or drafting. */ }
    const entries = sendAs?.sendAs as { isDefault?: boolean; isPrimary?: boolean; signature?: string }[] | undefined;
    const signature = (entries?.find(entry => entry.isDefault) ?? entries?.find(entry => entry.isPrimary))?.signature;
    const raw = Buffer.from(makeMime(to, cc, bcc, s('subject'), s('body'), signature), 'utf8').toString('base64url');
    const draft = n === 'gmail_draft';
    return c.request(draft ? '/gmail/v1/users/me/drafts' : '/gmail/v1/users/me/messages/send', { account: gmailAccount, method: 'POST', body: draft ? { message: { raw } } : { raw } });
  }
  if (n === 'google_calendar_list_events') {
    const start = s('start', new Date().toISOString());
    timed(start);
    const end = s('end', new Date(Date.parse(start) + 7 * 864e5).toISOString());
    timeRange(start, end, false);
    const r = await c.request(calendar, { query: { timeMin: start, timeMax: end, maxResults: number('max_results', 20), pageToken: s('page_token') || undefined, singleEvents: true, orderBy: 'startTime' } });
    return { items: r.items ?? [], next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'calendar_create' || n === 'calendar_update') {
    const create = n === 'calendar_create';
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
    if (a.recurrence !== undefined) {
      if (!Array.isArray(a.recurrence) || a.recurrence.some(line => typeof line !== 'string' || !/^(RRULE|EXRULE|RDATE|EXDATE)[:;]/.test(line))) throw new ToolUsageError('recurrence must be RFC 5545 lines such as RRULE:FREQ=YEARLY');
      body.recurrence = a.recurrence;
    }
    // Google requires an IANA zone on timed recurring events; it also pins wall-clock time across DST.
    if (a.time_zone !== undefined) for (const key of ['start', 'end']) if (body[key] && (body[key] as Record<string, unknown>).dateTime) (body[key] as Record<string, unknown>).timeZone = s('time_zone');
    if (!Object.keys(body).length) throw new ToolUsageError('At least one event field must be supplied');
    return c.request(create ? calendar : `${calendar}/${encodeURIComponent(s('event_id'))}`, { method: create ? 'POST' : 'PATCH', body });
  }
  if (n === 'calendar_delete') return c.request(`${calendar}/${encodeURIComponent(s('event_id'))}`, { method: 'DELETE' });
  if (n === 'tasks_lists') {
    const r = await c.request('/tasks/v1/users/@me/lists', { query: { maxResults: number('max_results', 20), pageToken: s('page_token') || undefined } });
    return { items: (r.items ?? []).map((list: Record<string, unknown>) => ({ id: list.id, name: list.title })), next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'tasks_list') {
    const r = await c.request(tasks, { query: { showCompleted: a.show_completed as boolean ?? false, showHidden: a.show_completed as boolean ?? false, maxResults: number('max_results', 20), pageToken: s('page_token') || undefined } });
    return { items: (r.items ?? []).map(withoutTaskDue), next_page_token: r.nextPageToken ?? null };
  }
  if (n === 'tasks_create' || n === 'tasks_update') {
    const body: Record<string, unknown> = {};
    for (const k of ['title', 'notes']) if (a[k] !== undefined) body[k] = s(k);
    if (!Object.keys(body).length) throw new ToolUsageError('At least one task field must be supplied');
    const create = n === 'tasks_create';
    return withoutTaskDue(await c.request(create ? tasks : `${tasks}/${encodeURIComponent(s('task_id'))}`, { method: create ? 'POST' : 'PATCH', body }));
  }
  if (n === 'tasks_complete') return withoutTaskDue(await c.request(`${tasks}/${encodeURIComponent(s('task_id'))}`, { method: 'PATCH', body: { status: 'completed' } }));
  if (n === 'tasks_delete') return c.request(`${tasks}/${encodeURIComponent(s('task_id'))}`, { method: 'DELETE' });
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
    const rule = schema.properties[key] as { type: string; minimum?: number; maximum?: number; minItems?: number; maxItems?: number } | undefined;
    if (!rule) throw new ToolUsageError('Unknown Google tool argument');
    if ((name === 'gmail_send' || name === 'gmail_draft') && ['to', 'cc', 'bcc'].includes(key)) continue;
    if (rule.type === 'string') {
      const emptyAllowed = ['body', 'subject', 'content', 'notes', 'description', 'location', 'page_token'].includes(key);
      if (typeof value !== 'string' || (!value && !emptyAllowed)) throw new ToolUsageError(`${key} must be a ${emptyAllowed ? '' : 'non-empty '}string`);
    } else if (rule.type === 'array' && (!Array.isArray(value) || value.length < rule.minItems! || value.length > rule.maxItems! || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length)) throw new ToolUsageError(`${key} must contain 1–100 unique non-empty strings`);
    else if (rule.type === 'boolean' && typeof value !== 'boolean') throw new ToolUsageError(`${key} must be boolean`);
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
  catch {
    // Gmail may return UTF-8 body bytes while retaining a legacy charset header.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Gmail MIME body is invalid for its declared charset and UTF-8; message body was not decoded'); }
  }
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
function parseRecipients(field: string, value: unknown): string[] {
  const addresses = Array.isArray(value) ? value : [value];
  if (!addresses.length) throw new ToolUsageError(`${field} must contain at least one email address`);
  for (const address of addresses) {
    if (typeof address !== 'string' || !/^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(address)) throw new ToolUsageError(`Invalid ${field} address: ${JSON.stringify(address)}`);
  }
  return addresses;
}
function makeMime(to: string[], cc: string[], bcc: string[], subject: string, body: string, signature?: string): string {
  if (/[\r\n\x00]/.test(subject)) throw new ToolUsageError('Subject cannot contain CR, LF or NUL');
  const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const subjectWords = [];
  let chunk = '';
  for (const char of subject) { if (Buffer.byteLength(chunk + char) > 42) { subjectWords.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; } chunk += char; }
  if (chunk) subjectWords.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  const header = `To: ${to.join(', ')}\r\n${cc.length ? `Cc: ${cc.join(', ')}\r\n` : ''}${bcc.length ? `Bcc: ${bcc.join(', ')}\r\n` : ''}Subject: ${subjectWords.join('\r\n ')}\r\nMIME-Version: 1.0\r\n`;
  if (!signature) return `${header}Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encode(body)}`;
  const plainSignature = decodeHTML(signature.replace(/<br\s*\/?>|<\/(?:div|p)\s*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/\n[ \t\u00a0]*\n(?:[ \t\u00a0]*\n)+/g, '\n\n').trim();
  const htmlBody = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r\n|\r|\n/g, '<br>');
  const boundary = `butler_${randomBytes(24).toString('hex')}`;
  const part = (type: string, content: string) => `--${boundary}\r\nContent-Type: text/${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encode(content)}\r\n`;
  return `${header}Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${part('plain', `${body}\n\n-- \n${plainSignature}`)}${part('html', `${htmlBody}<br>-- <br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signature}</div>`)}--${boundary}--\r\n`;
}
