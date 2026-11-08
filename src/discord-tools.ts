import { DiscordReactionInputError, ToolUsageError } from './tool-errors.js';
import { fileURLToPath } from 'node:url';
import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { allowedReferencePath, detectImage } from './image-tools.js';
import { resolve, basename } from 'node:path';
import type { DiscordPresence, DiscordPresenceInput, Store, StoredMessage } from './store.js';
import { MessageFlags } from 'discord.js';
import { prepareAttachments, type DiscordAttachmentInput } from './input-attachments.js';
import type { AudioTranscriptionConfig } from './audio-transcription.js';

export type HandoffInput = { targetChannelId: string; content: string; cardMessageId: string; cardTime: string; originChannelId: string; originMessageId?: string; requesterId?: string };
export type DiscordToolContext = { channelId: string; messageId?: string; requesterId?: string; handoff?: (input: HandoffInput) => Promise<void>; setPresence?: (input: DiscordPresenceInput) => DiscordPresence; readPresence?: (channelId: string, userId?: string) => Promise<unknown>; botId?: string; botName?: string; sessionId?: string; memoryOriginChannelId?: string; store?: Store; onMessageDelivered?: (channelId: string, sessionId: string) => void; attachmentFiles: Array<{ attachment: string; name: string }>; attachmentToolCallIds?: string[] };
type DiscordToolDefinition = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };
type ToolSpec = { name: string; description: string; properties: Record<string, unknown>; required: string[] };
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const snowflake = { type: 'string', pattern: '^[0-9]{2,32}$' };
const channelMessage = { channelId: snowflake, messageId: snowflake };
const emojisSchema = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } };
const specs: ToolSpec[] = [
  { name: 'send', description: 'Send a message to a Discord channel. User and role mentions in content notify them.', properties: { channelId: snowflake, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'content'] },
  { name: 'message', description: 'Fetch a Discord message and prepare its original attachments as image/file input for this conversation.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'channel_messages', description: 'Fetch channel messages; before continues toward older messages.', properties: { channelId: snowflake, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: snowflake }, required: ['channelId'] },
  { name: 'pins', description: 'List pinned messages in a channel, newest pin first; before (a pinned_at timestamp) continues toward older pins.', properties: { channelId: snowflake, limit: { type: 'integer', minimum: 1, maximum: 50 }, before: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['channelId'] },
  { name: 'edit', description: 'Edit a message authored by this bot.', properties: { ...channelMessage, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'messageId', 'content'] },
  { name: 'delete', description: 'Delete a message in a channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_react', description: 'Add one or more reactions to a message. Stops on failure without automatically retrying.', properties: { ...channelMessage, emojis: emojisSchema }, required: ['channelId', 'messageId', 'emojis'] },
  { name: 'discord_profile', description: 'Edit the bot profile globally, visible in every server. Avatar and banner changes are rate-limited.', properties: { status: { type: 'string', enum: ['online', 'idle', 'dnd'] }, activity: { type: ['object', 'null'], properties: { type: { type: 'string', enum: ['custom', 'playing', 'listening', 'watching', 'competing'] }, text: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['type', 'text'], additionalProperties: false, description: 'Activity to display, or null to clear.' }, avatar: { type: 'string', description: 'PNG, JPEG, GIF or WebP path in workspace or attachments; empty removes.' }, banner: { type: 'string', description: 'PNG, JPEG, GIF or WebP path in workspace or attachments; empty removes.' }, bio: { type: 'string', maxLength: 400, description: 'About Me; empty clears.' } }, required: [] },
  { name: 'pin', description: 'Pin a message in a channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'unpin', description: 'Unpin a message in a channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'channel', description: 'Fetch channel details, including forum available tags and whether a tag is required.', properties: { channelId: snowflake }, required: ['channelId'] },
  { name: 'presence', description: 'Read cached guild member presences.', properties: { channelId: snowflake, userId: snowflake }, required: [] },
  { name: 'create_forum_post', description: 'Create a Forum or Media post; channelId is the forum ID and content is the first post body. appliedTagIds must come from that forum’s available tags.', properties: { channelId: snowflake, title: { type: 'string', minLength: 1, maxLength: 100 }, content: { type: 'string', minLength: 1, maxLength: 2000 }, appliedTagIds: { type: 'array', items: snowflake, maxItems: 5, uniqueItems: true } }, required: ['channelId', 'title', 'content'] },
  { name: 'archive', description: 'Archive a thread; channelId is its parent and messageId is the thread ID.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'delete_thread', description: 'Delete a thread; channelId is its parent and messageId is the thread ID.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'rename_post', description: 'Rename a forum post thread.', properties: { threadId: snowflake, name: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['threadId', 'name'] },
  { name: 'rename_forum', description: 'Rename a forum channel.', properties: { channelId: snowflake, name: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['channelId', 'name'] },
  { name: 'discord_attach_to_reply', description: 'Queue a regular file for the final reply. Absolute paths are allowed; relative paths use the project root. filename must be a plain filename.', properties: { file: { type: 'string', minLength: 1, maxLength: 500 }, filename: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['file'] },
  { name: 'discord_handoff', description: 'Hand work over to another tracked channel\'s Butler session. Posts a handoff card there and starts that session on it right away. That session sees only title and content, so include the goal, what is already known or done, relevant links/IDs and what remains. The target channel owns the work afterwards. Do not hand back work you just received.', properties: { channelId: snowflake, title: { type: 'string', minLength: 1, maxLength: 100 }, content: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['channelId', 'title', 'content'] },
];
const discordGroups: Record<string, Record<string, string>> = {
  discord_read: { message: 'message', channel_messages: 'channel_messages', pins: 'pins', channel: 'channel', presence: 'presence' },
  discord_message: { send: 'send', edit: 'edit', delete: 'delete', pin: 'pin', unpin: 'unpin' },
  discord_thread: { create_forum_post: 'create_forum_post', archive: 'archive', delete: 'delete_thread', rename_post: 'rename_post', rename_forum: 'rename_forum' },
};
const groupDescriptions: Record<string, string> = {
  discord_read: 'Read Discord messages, pins, channel details and member presences.\nmessage — Fetch a message and prepare its original attachments; required channelId, messageId.\nchannel_messages — Fetch channel messages; required channelId; optional limit and before (older messages).\npins — List pinned messages, newest first; required channelId; optional limit and before (pinned_at timestamp for older pins).\nchannel — Fetch channel details, forum tags and whether a tag is required; required channelId.\npresence — Read cached guild presences; supply channelId or userId, or both. userId alone uses the current channel’s guild; without userId, returns up to 50 non-offline cached presences. Missing cached presence is reported as offline.',
  discord_message: 'Send, edit, delete or pin Discord messages.\nsend — Send a channel message; required channelId, content; user and role mentions notify them.\nedit — Edit a message authored by this bot; required channelId, messageId, content.\ndelete — Delete a channel message; required channelId, messageId.\npin — Pin a message; required channelId, messageId.\nunpin — Unpin a message; required channelId, messageId.',
  discord_thread: 'Create and manage Discord forum posts and threads.\ncreate_forum_post — Create a Forum or Media post; required channelId, title, content; appliedTagIds must come from that forum’s available tags.\narchive — Archive a thread; required channelId (parent), messageId (thread).\ndelete — Delete a thread; required channelId (parent), messageId (thread).\nrename_post — Rename a forum post thread; required threadId, name.\nrename_forum — Rename a forum channel; required channelId, name.',
};
const discordGroupsByOperation = new Map(Object.entries(discordGroups).flatMap(([tool, actions]) => Object.values(actions).map(operation => [operation, tool] as const)));
function publicDefinition(name: string, members: ToolSpec[]): DiscordToolDefinition {
  const grouped = name in discordGroups;
  const properties = Object.assign({}, ...members.map(member => member.properties));
  return { type: 'function', name, description: grouped ? groupDescriptions[name]! : members[0]!.description, parameters: { type: 'object', properties: grouped ? { action: { type: 'string', enum: Object.keys(discordGroups[name]!) }, ...properties } : properties, required: grouped ? ['action'] : members[0]!.required, additionalProperties: false } };
}
export const discordMessageTools: DiscordToolDefinition[] = [
  ...Object.entries(discordGroups).map(([name, actions]) => publicDefinition(name, Object.values(actions).map(operation => specs.find(spec => spec.name === operation)!))),
  ...specs.filter(spec => !discordGroupsByOperation.has(spec.name)).map(spec => publicDefinition(spec.name, [spec])),
];
export type DiscordToolRuntime = { definitions: DiscordToolDefinition[]; context: DiscordToolContext; takeInputMessages(): StoredMessage[]; execute(name: string, args: Record<string, unknown>): Promise<unknown> };

// Keep diagnostics single-line and bounded; never expose credentials or webhook URLs.
function safeDiscordDiagnostic(value: string, token: string): string {
  const redacted = token ? value.split(token).join('[redacted]') : value;
  return redacted.replace(/https?:\/\/[^\s"<>]+/gi, '[url redacted]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
}

export function createDiscordToolRuntime(options: { token: string; context: DiscordToolContext; fetcher?: typeof fetch; attachmentDir?: string; transcription?: AudioTranscriptionConfig }): DiscordToolRuntime {
  const fetcher = options.fetcher ?? fetch;
  const pendingInput: StoredMessage[] = [];
  const takeInputMessages = (): StoredMessage[] => pendingInput.splice(0, pendingInput.length);
  const addFetchFailureEvidence = (channelId: string, messageId: string): void => {
    const now = new Date().toISOString();
    pendingInput.push({ id: `discord:${channelId}:${messageId}`, sessionId: options.context.sessionId ?? '', role: 'user', content: '無法取得這則 Discord 原訊息，未提供原檔。原訊息時間未知，來源標頭中的時間僅為本次取得失敗的時間。', createdAt: now, source: { sourceKind: 'discord_external', channelId, discordMessageId: messageId }, attachments: [], preparationStatus: 'ready', discordSegments: [] });
  };
  const fetchMessage = async (channelId: string, messageId: string): Promise<unknown> => {
    let record: Record<string, unknown>;
    try {
      record = asRecord(await api('GET', `/channels/${channelId}/messages/${messageId}`, undefined, false));
      if (record.id !== messageId || record.channel_id !== channelId) throw new Error('Discord returned a different message than requested');
      const reference = isRecord(record.message_reference) ? record.message_reference : undefined;
      const isForward = reference?.type === 1;
      const snapshots = Array.isArray(record.message_snapshots) ? record.message_snapshots : [];
      const snapshotEnvelope = isForward && isRecord(snapshots[0]) ? snapshots[0] : undefined;
      const snapshot = snapshotEnvelope && isRecord(snapshotEnvelope.message) ? snapshotEnvelope.message : undefined;
      const attachmentSource = snapshot ? snapshot.attachments : record.attachments;
      if (!Array.isArray(attachmentSource)) throw new Error('Discord returned invalid message attachment metadata');
      const rawAttachments = attachmentSource.map(item => {
        const attachment = asRecord(item);
        if (typeof attachment.id !== 'string' || typeof attachment.url !== 'string' || typeof attachment.filename !== 'string') throw new Error('Discord returned invalid message attachment metadata');
        return { id: attachment.id, url: attachment.url, name: attachment.filename, contentType: typeof attachment.content_type === 'string' ? attachment.content_type : null, size: typeof attachment.size === 'number' ? attachment.size : undefined } satisfies DiscordAttachmentInput;
      });
      if (rawAttachments.length && !options.attachmentDir) throw new Error('Attachment storage is unavailable');
      const attachments = rawAttachments.length ? await prepareAttachments(rawAttachments, options.attachmentDir!, options.transcription) : [];
      if (attachments.some(attachment => attachment.status === 'failed' && attachment.error === '附件無法保存到受控目錄')) throw new Error('Attachment storage is unavailable');
      const author = isRecord(record.author) ? record.author : {};
      const isBot = typeof author.bot === 'boolean' ? author.bot : undefined;
      const eventTime = typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : undefined;
      const snapshotTime = typeof snapshot?.timestamp === 'string' && Number.isFinite(Date.parse(snapshot.timestamp)) ? snapshot.timestamp : undefined;
      const createdAt = eventTime ?? new Date().toISOString();
      const snapshotAuthor = snapshot && isRecord(snapshot.author) ? snapshot.author : undefined;
      const forwardedMessage = isForward ? { ...(typeof reference?.message_id === 'string' ? { discordMessageId: reference.message_id } : {}), ...(typeof reference?.channel_id === 'string' ? { channelId: reference.channel_id } : {}), ...(snapshotTime ? { eventTime: snapshotTime } : {}), ...(typeof snapshot?.content === 'string' && snapshot.content ? { content: snapshot.content } : {}), ...(typeof snapshotAuthor?.id === 'string' ? { authorId: snapshotAuthor.id } : {}), ...(typeof snapshotAuthor?.username === 'string' ? { authorName: snapshotAuthor.username } : {}) } : undefined;
      const evidence: StoredMessage = {
        id: `discord:${channelId}:${messageId}`, sessionId: options.context.sessionId ?? '', role: 'user',
        content: isForward ? `[轉發訊息]\n${typeof snapshot?.content === 'string' ? snapshot.content : ''}` : typeof record.content === 'string' ? record.content : '', createdAt,
        source: { sourceKind: 'discord_external', channelId, discordMessageId: messageId, ...(isBot === undefined ? {} : { isBot }), ...(forwardedMessage ? { forwardedMessage } : {}), ...(!isForward && isRecord(record.message_reference) && typeof record.message_reference.message_id === 'string' ? { replyToMessageId: record.message_reference.message_id, replyToChannelId: typeof record.message_reference.channel_id === 'string' ? record.message_reference.channel_id : channelId } : {}), authorId: typeof author.id === 'string' ? author.id : undefined, authorName: typeof author.username === 'string' ? author.username : undefined, webhookId: typeof record.webhook_id === 'string' ? record.webhook_id : undefined, eventTime },
        attachments, preparationStatus: 'ready', discordSegments: [],
      };
      if (options.context.store && options.context.sessionId) {
        const persisted = options.context.store.addMessageOnce(options.context.sessionId, 'user', evidence.content, { ...evidence.source, sourceKind: 'discord_fetched' }, attachments, options.context.memoryOriginChannelId !== undefined && options.context.store.memoryWriteAllowed(options.context.memoryOriginChannelId) && options.context.store.memoryWriteAllowed(channelId));
        if (persisted.created) options.context.store.updateAttachments(persisted.message.id, attachments);
        const storedEvidence = options.context.store.messagesWithSources(options.context.sessionId).find(item => item.id === persisted.message.id && item.role === 'user') ?? evidence;
        pendingInput.push(storedEvidence);
        options.context.onMessageDelivered?.(channelId, options.context.sessionId);
      } else pendingInput.push(evidence);
      return withoutAuthorClassification({ ...record, attachment_inputs: attachments });
    } catch (error) {
      addFetchFailureEvidence(channelId, messageId);
      throw error;
    }
  };
  const api = async (method: string, path: string, body?: unknown, sanitize = true): Promise<unknown> => {
    let response: Response;
    try { response = await fetcher(`https://discord.com/api/v10${path}`, { method, headers: { authorization: `Bot ${options.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) }); }
    catch {
      throw new Error(`Discord REST request failed method=${method} path=${safeDiscordDiagnostic(path, options.token)} stage=transport; ${method === 'GET' ? 'read failed; no mutation was requested' : 'outcome is unknown; do not retry this tool automatically'}`);
    }
    if (!response.ok) {
      // Only retain Discord's diagnostic fields, never request bodies, headers or the raw response.
      let code: string | number | null = null;
      let message = 'unavailable';
      try {
        const errorBody: unknown = await response.json();
        if (isRecord(errorBody)) {
          if (typeof errorBody.code === 'number' || typeof errorBody.code === 'string') code = errorBody.code;
          if (typeof errorBody.message === 'string') message = errorBody.message;
        }
      } catch { message = 'unavailable (error response could not be read as JSON)'; }
      const outcome = method === 'GET' ? 'read failed; no mutation was requested'
        : response.status >= 400 && response.status < 500 && response.status !== 408
          ? 'request rejected by Discord; do not retry automatically'
          : 'outcome may be unknown; do not retry automatically';
      const Rejection = method === 'PUT' && /\/reactions\/[^/]+\/@me$/.test(path) && response.status === 400 && String(code) === '10014' ? DiscordReactionInputError : Error;
      throw new Rejection(`Discord REST request failed method=${method} path=${safeDiscordDiagnostic(path, options.token)} status=${response.status} code=${safeDiscordDiagnostic(String(code ?? 'unavailable'), options.token)} message=${JSON.stringify(safeDiscordDiagnostic(message, options.token))}; ${outcome}`);
    }
    if (response.status === 204) return null;
    const raw = await response.json();
    return sanitize ? withoutAuthorClassification(raw) : raw;
  };
  const checkRootOrChild = async (id: string, requireThread = false): Promise<Record<string, unknown>> => {
    const target = asRecord(await api('GET', `/channels/${id}`));
    if (String(target.id) !== id) throw new Error('Discord returned a different channel than requested');
    const type = Number(target.type);
    if (requireThread && ![10, 11, 12].includes(type)) throw new ToolUsageError('Target is not a thread');
    return target;
  };
  return { definitions: discordMessageTools, context: options.context, takeInputMessages, async execute(name, args) {
    const action = args.action;
    const operation = Object.hasOwn(discordGroups, name) ? typeof action === 'string' && Object.hasOwn(discordGroups[name]!, action) ? discordGroups[name]![action] : undefined : discordGroupsByOperation.has(name) ? undefined : name;
    if (!operation) throw new ToolUsageError(Object.hasOwn(discordGroups, name) ? `Unknown or missing action. Valid actions: ${Object.keys(discordGroups[name]!).join(', ')}` : `Unknown Discord tool: ${name}`);
    const operationArgs = name in discordGroups ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'action')) : args;
    const spec = specs.find(item => item.name === operation); if (!spec) throw new ToolUsageError(`Unknown Discord tool: ${name}`);
    validateArgs(spec, operationArgs);
    args = operationArgs;
    name = operation;
    const channelId = args.channelId === undefined ? undefined : stringArg(args.channelId, 'channelId');
    const messageId = args.messageId === undefined ? undefined : stringArg(args.messageId, 'messageId');
    const content = args.content === undefined ? undefined : stringArg(args.content, 'content');
    if (content !== undefined && name !== 'discord_handoff' && content.length > 2000) throw new ToolUsageError('Discord message exceeds 2000 characters');
    if (name === 'presence') {
      if (!channelId && !args.userId) throw new ToolUsageError('channelId or userId is required');
      if (!options.context.readPresence) throw new ToolUsageError('Presence is not available here');
      return options.context.readPresence(channelId ?? options.context.channelId, args.userId as string | undefined);
    }
    if (name === 'discord_react') {
      const emojis = args.emojis as string[];
      const added: string[] = [];
      for (const emoji of emojis) {
        try {
          await api('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
          added.push(emoji);
        } catch (error) {
          const original = error instanceof Error ? error.message : String(error);
          const ReactionError = error instanceof DiscordReactionInputError ? DiscordReactionInputError : Error;
          throw new ReactionError(`Failed to add reaction ${JSON.stringify(emoji)}; confirmed added: ${JSON.stringify(added)}. Successfully added reactions will not be rolled back; remaining reactions were not executed. The outcome for the current reaction may be unknown; do not retry automatically. Original error: ${original}`);
        }
      }
      return { ok: true, channelId, messageId, emojis: added };
    }
    if (name === 'discord_profile') {
      if (!Object.keys(args).length) throw new ToolUsageError('At least one profile field is required');
      const result: Record<string, unknown> = { ok: true };
      if (args.status !== undefined || args.activity !== undefined) {
        if (!options.context.setPresence) throw new ToolUsageError('Presence is not available here');
        Object.assign(result, options.context.setPresence({ status: args.status as DiscordPresence['status'] | undefined, activity: args.activity as DiscordPresence['activity'] | undefined }));
      }
      if (args.bio !== undefined) result.bio = asRecord(await api('PATCH', '/applications/@me', { description: args.bio })).description;
      const images: Record<string, string | null> = {};
      for (const field of ['avatar', 'banner'] as const) {
        const path = args[field] as string | undefined;
        if (path === undefined) continue;
        if (!path) { images[field] = null; continue; }
        if (!options.attachmentDir) throw new ToolUsageError('Attachment storage is unavailable');
        const bytes = await readFile(await allowedReferencePath(path, options.attachmentDir));
        const mime = detectImage(bytes)?.mime ?? (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ? 'image/gif' : undefined);
        if (!mime) throw new ToolUsageError(`${field} must be a PNG, JPEG, GIF or WebP image`);
        images[field] = `data:${mime};base64,${bytes.toString('base64')}`;
      }
      if (Object.keys(images).length) {
        const user = asRecord(await api('PATCH', '/users/@me', images));
        for (const field of Object.keys(images)) result[field] = user[field];
      }
      return result;
    }
    if (name === 'message') return fetchMessage(channelId!, messageId!);
    if (name === 'discord_attach_to_reply') {
      const file = stringArg(args.file, 'file');
      if (/^[a-z]+:\/\//i.test(file) || file.includes('\0') || file.includes('\\')) throw new ToolUsageError('Attachment must be a local file path');
      const absolute = resolve(projectRoot, file); const real = realpathSync(absolute);
      if (!statSync(real).isFile()) throw new ToolUsageError('Attachment must be a regular file');
      const name = args.filename === undefined ? basename(real) : stringArg(args.filename, 'filename');
      if (name !== basename(name) || name.includes('\\') || name.includes('/') || name === '.' || name === '..') throw new ToolUsageError('filename must be a plain filename');
      options.context.attachmentFiles.push({ attachment: real, name });
      return { status: 'queued_for_final_reply', filename: name, delivery: 'pending' };
    }
    if (name === 'discord_handoff') {
      const handoff = options.context.handoff;
      if (!handoff) throw new ToolUsageError('Handoff is not available here');
      if (channelId === options.context.channelId) throw new ToolUsageError('Cannot hand off to the current channel');
      if (!options.context.store?.isTrackedChannel(channelId!)) throw new ToolUsageError('Target channel is not tracked by Butler');
      const title = stringArg(args.title, 'title'); const originChannelId = options.context.channelId; const originMessageId = options.context.messageId; const requesterId = options.context.requesterId;
      const origin = asRecord(await api('GET', `/channels/${originChannelId}`));
      const link = originMessageId ? `https://discord.com/channels/${typeof origin.guild_id === 'string' ? origin.guild_id : '@me'}/${originChannelId}/${originMessageId}` : undefined;
      const card = asRecord(await api('POST', `/channels/${channelId}/messages`, { allowed_mentions: { parse: [] }, embeds: [{ color: 0x8FBC8F, author: { name: '📨 交接' }, title, description: content, fields: [{ name: '來自', value: `<#${originChannelId}>${link ? ` · [原訊息](${link})` : ''}`, inline: true }, ...(requesterId ? [{ name: '交辦', value: `<@${requesterId}>`, inline: true }] : [])], footer: { text: 'Butler session handoff' }, timestamp: new Date().toISOString() }] }));
      if (typeof card.id !== 'string' || typeof card.timestamp !== 'string' || !Number.isFinite(Date.parse(card.timestamp))) throw new Error('Discord handoff card response lacks a valid message ID or timestamp; card outcome is unknown and must not be retried automatically');
      try { await handoff({ targetChannelId: channelId!, content: `${title}\n\n${content}`, cardMessageId: card.id, cardTime: card.timestamp, originChannelId, originMessageId, requesterId }); }
      catch (error) { throw new Error(`Handoff card ${card.id} was posted but the target session could not be started (${error instanceof Error ? error.message : String(error)}); do not retry automatically`); }
      return { ok: true, confirmed: true, channelId, messageId: card.id, started: true };
    }
    let method = 'GET'; let path = ''; let body: unknown;
    if (name === 'channel') {
      const channel = asRecord(await api('GET', `/channels/${channelId}`));
      if (String(channel.id) !== channelId) throw new Error('Discord returned a different channel than requested');
      const tags = channel.available_tags;
      if (tags !== undefined && !Array.isArray(tags)) throw new Error('Discord returned invalid available_tags');
      return { id: channel.id, name: channel.name ?? null, type: channel.type, flags: channel.flags ?? 0, available_tags: tags ?? [], require_tag: (Number(channel.flags ?? 0) & 16) !== 0 };
    } else if (name === 'create_forum_post') {
      const parent = await checkRootOrChild(channelId!); const type = Number(parent.type);
      if (![15,16].includes(type)) throw new ToolUsageError('Target channel is not a forum/media channel');
      const availableTags = parent.available_tags;
      if (availableTags !== undefined && !Array.isArray(availableTags)) throw new Error('Discord returned invalid available_tags');
      const tags = (availableTags ?? []) as Array<Record<string, unknown>>;
      const appliedTagIds = args.appliedTagIds as string[] | undefined;
      const requireTag = (Number(parent.flags ?? 0) & 16) !== 0;
      if (appliedTagIds?.some(id => !tags.some(tag => tag.id === id))) throw new ToolUsageError('appliedTagIds must identify tags available in this forum');
      if (requireTag && !appliedTagIds?.length) return { ok: false, confirmed: false, requiresTag: true, forumId: channelId, available_tags: tags };
      method='POST'; path=`/channels/${channelId}/threads`;
      body={name:args.title,message:{content,flags:MessageFlags.SuppressEmbeds,allowed_mentions:{parse:[]}},auto_archive_duration:1440,...(appliedTagIds?.length ? {applied_tags:appliedTagIds} : {})};
    } else if (['archive','delete_thread'].includes(name)) {
      const thread = await checkRootOrChild(messageId!, true); if (String(thread.parent_id) !== channelId) throw new ToolUsageError('Thread does not belong to the specified root');
      if (name === 'delete_thread') { method='DELETE'; path=`/channels/${messageId}`; } else { method='PATCH'; path=`/channels/${messageId}`; body={archived:true}; }
    } else if (name === 'rename_post') {
      const target = await checkRootOrChild(stringArg(args.threadId,'threadId'),true); const parent=asRecord(await api('GET',`/channels/${String(target.parent_id)}`)); if (![15,16].includes(Number(parent.type))) throw new ToolUsageError('Target thread is not a forum post'); method='PATCH';path=`/channels/${args.threadId}`;body={name:args.name};
    } else if (name === 'rename_forum') {
      const channel=await checkRootOrChild(channelId!); if (![15,16].includes(Number(channel.type))) throw new ToolUsageError('Target is not a forum/media channel'); method='PATCH';path=`/channels/${channelId}`;body={name:args.name};
    } else {
      const base=`/channels/${channelId}`;
      switch(name) {
        case 'send':method='POST';path=`${base}/messages`;body={content,flags:MessageFlags.SuppressEmbeds,allowed_mentions:{parse:['users','roles']}};break;
        case 'message':path=`${base}/messages/${messageId}`;break;
        case 'channel_messages':{const limit=args.limit===undefined?50:args.limit as number;const query=new URLSearchParams({limit:String(limit)});if(args.before!==undefined)query.set('before',String(args.before));path=`${base}/messages?${query}`;break;}
        case 'pins':{if(args.before!==undefined&&!Number.isFinite(Date.parse(String(args.before))))throw new ToolUsageError('before must be an ISO8601 pinned_at timestamp');const query=new URLSearchParams({limit:String(args.limit??50)});if(args.before!==undefined)query.set('before',String(args.before));path=`${base}/messages/pins?${query}`;break;}
        case 'edit':method='PATCH';path=`${base}/messages/${messageId}`;body={content,flags:MessageFlags.SuppressEmbeds,allowed_mentions:{parse:[]}};break;
        case 'delete':method='DELETE';path=`${base}/messages/${messageId}`;break;
        case 'pin':method='PUT';path=`${base}/messages/pins/${messageId}`;break;
        case 'unpin':method='DELETE';path=`${base}/messages/pins/${messageId}`;break;
      }
    }
    const result=await api(method,path,body);
    if(name==='message')return asRecord(result);
    if(name==='channel_messages'){if(!Array.isArray(result))throw new Error('Discord returned an invalid message page');const limit=args.limit===undefined?50:args.limit as number;return {messages:result,limit,before:args.before??null,next_before:result.length===limit?(asRecord(result.at(-1)).id??null):null,may_have_more:result.length===limit};}
    if(name==='pins'){const page=asRecord(result);if(!Array.isArray(page.items)||typeof page.has_more!=='boolean')throw new Error('Discord returned an invalid pin page');return {pins:page.items,has_more:page.has_more,next_before:page.has_more?(asRecord(page.items.at(-1)).pinned_at??null):null};}
    const record = isRecord(result) ? result : null;
    if (name === 'send') {
      if (!record || typeof record.id !== 'string') throw new Error('Discord send response has no message ID; delivery cannot be recorded and outcome is unknown');
      persistDeliveredMessage(options.context, channelId!, record, content!);
    }
    if (name === 'create_forum_post') {
      const postId = record?.id;
      const createdMessage = isRecord(record?.message) ? record.message : null;
      const createdChannel = isRecord(record?.channel) ? record.channel : record;
      const messageId = createdMessage?.id;
      const guildId = createdChannel?.guild_id ?? record?.guild_id;
      if (typeof postId !== 'string' || !/^\d{2,32}$/.test(postId) || typeof messageId !== 'string' || !/^\d{2,32}$/.test(messageId) || typeof guildId !== 'string' || !/^\d{2,32}$/.test(guildId)) throw new Error('Discord forum post response is incomplete; outcome is unknown and must not be retried automatically');
      persistDeliveredMessage(options.context, postId, { ...createdMessage, id: messageId }, content!);
      return { ok: true, confirmed: true, forumId: channelId, postId, url: `https://discord.com/channels/${guildId}/${postId}`, messageId, result };
    }
    return { ok: true, confirmed: true, channelId: channelId ?? null, ...(name === 'send' ? { messageId: record?.id ?? null, result } : name === 'edit' ? { messageId: messageId ?? null, result } : name === 'rename_post' || name === 'rename_forum' ? { id: record?.id ?? null, result } : { messageId: messageId ?? null, result }) };
  } };
}

function persistDeliveredMessage(context: DiscordToolContext, channelId: string, sent: Record<string, unknown>, content: string): void {
  const messageId = sent.id;
  const eventTime = sent.timestamp;
  if (typeof messageId !== 'string' || !/^\d{2,32}$/.test(messageId) || typeof eventTime !== 'string' || !Number.isFinite(Date.parse(eventTime))) {
    throw new Error('Discord message response lacks a valid message ID or timestamp; delivery cannot be recorded');
  }
  if (!context.store || !context.sessionId) throw new Error('Discord message was delivered but cannot be recorded without its session store');
  const message = context.store.createOutgoing(context.sessionId, content, { sourceKind: 'butler_tool_message', authorId: context.botId, authorName: context.botName, channelId, discordMessageId: messageId, eventTime }, context.memoryOriginChannelId !== undefined && context.store.memoryWriteAllowed(context.memoryOriginChannelId) && context.store.memoryWriteAllowed(channelId));
  context.store.saveOutgoingSegment(message, { channelId, messageId, content, createdAt: eventTime });
  context.store.finalizeOutgoing(message.id, content);
  context.onMessageDelivered?.(channelId, context.sessionId);
}

function validateArgs(spec: ToolSpec,args:Record<string,unknown>):void {
  for(const required of spec.required) if(!(required in args)) throw new ToolUsageError(`${required} is required`);
  validateValue({type:'object',properties:spec.properties,required:spec.required,additionalProperties:false},args,'arguments');
}
function validateValue(rule:Record<string,unknown>,value:unknown,path:string):void {
  if (Array.isArray(rule.type)) {
    if (value === null && rule.type.includes('null')) return;
    rule = { ...rule, type: rule.type.find(type => type !== 'null') };
  }
  if (rule.type === 'boolean') { if (typeof value !== 'boolean') throw new ToolUsageError(`${path} is invalid`); return; }
  if(rule.type==='string') {
    if(typeof value!=='string'||value.length<Number(rule.minLength??0)||value.length>Number(rule.maxLength??Infinity)||(rule.pattern&&!new RegExp(String(rule.pattern)).test(value))||(Array.isArray(rule.enum)&&!rule.enum.includes(value))) throw new ToolUsageError(`${path} is invalid`);
    return;
  }
  if(rule.type==='integer') { if(!Number.isSafeInteger(value)||Number(value)<Number(rule.minimum??-Infinity)||Number(value)>Number(rule.maximum??Infinity)) throw new ToolUsageError(`${path} is invalid`); return; }
  if(rule.type==='array') {
    if(!Array.isArray(value)||value.length<Number(rule.minItems??0)||value.length>Number(rule.maxItems??Infinity)||(rule.uniqueItems===true&&new Set(value).size!==value.length)) throw new ToolUsageError(`${path} is invalid`);
    for(let index=0;index<value.length;index++) validateValue(rule.items as Record<string,unknown>,value[index],`${path}[${index}]`);
    return;
  }
  if(rule.type==='object') {
    if(!isRecord(value)) throw new ToolUsageError(`${path} is invalid`);
    const properties=isRecord(rule.properties)?rule.properties:{};
    if(Array.isArray(rule.required)) for(const key of rule.required) if(typeof key==='string'&&!(key in value)) throw new ToolUsageError(`${path}.${key} is required`);
    for(const [key,item] of Object.entries(value)) {
      const child=properties[key];
      if(!child) { if(rule.additionalProperties!==true) throw new ToolUsageError(`Unexpected argument: ${path}.${key}`); continue; }
      validateValue(child as Record<string,unknown>,item,`${path}.${key}`);
    }
  }
}
function stringArg(value:unknown,name:string):string{if(typeof value!=='string'||!value.length)throw new ToolUsageError(`${name} is invalid`);return value;}
function asRecord(value:unknown):Record<string,unknown>{if(!isRecord(value))throw new Error('Discord returned an invalid object');return value;}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}

function withoutAuthorClassification(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAuthorClassification);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'author' && isRecord(item)) {
      const { bot: _bot, ...author } = item;
      return [key, withoutAuthorClassification(author)];
    }
    return [key, withoutAuthorClassification(item)];
  }));
}
