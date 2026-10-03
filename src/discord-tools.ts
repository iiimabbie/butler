import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import type { Store } from './store.js';

export type DiscordToolContext = { channelId: string; messageId?: string; ownerId?: string; actorId?: string; isBot?: boolean; sessionId?: string; store?: Store; attachmentFiles: Array<{ attachment: string; name: string }>; attachmentToolCallIds?: string[] };
type DiscordToolDefinition = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };
type ToolSpec = { name: string; description: string; properties: Record<string, unknown>; required: string[] };
const snowflake = { type: 'string', pattern: '^[0-9]{2,32}$' };
const channelMessage = { channelId: snowflake, messageId: snowflake };
const actionArgsSchema = { type: 'object', properties: { channelId: snowflake, messageId: snowflake, threadId: snowflake, content: { type: 'string', minLength: 1, maxLength: 2000 }, name: { type: 'string', minLength: 1, maxLength: 100 }, title: { type: 'string', minLength: 1, maxLength: 100 }, emoji: { type: 'string', minLength: 1, maxLength: 64 } }, additionalProperties: false };
const button = { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' }, label: { type: 'string', minLength: 1, maxLength: 80 }, style: { type: 'string', enum: ['primary', 'secondary', 'success', 'danger'] }, actionTool: { type: 'string', minLength: 1, maxLength: 64 }, actionArgs: actionArgsSchema }, required: ['id', 'label', 'style', 'actionTool', 'actionArgs'], additionalProperties: false };
const specs: ToolSpec[] = [
  { name: 'discord_send_message', description: 'Send a message to an explicitly identified allowlisted Discord channel.', properties: { channelId: snowflake, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'content'] },
  { name: 'discord_fetch_message', description: 'Fetch one message from an explicitly identified allowlisted Discord channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_fetch_channel_messages', description: 'Fetch a bounded page of messages from an allowlisted channel; pass before to continue toward older messages.', properties: { channelId: snowflake, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: snowflake }, required: ['channelId'] },
  { name: 'discord_edit_message', description: 'Edit a message authored by this bot in an allowlisted channel.', properties: { ...channelMessage, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'messageId', 'content'] },
  { name: 'discord_delete_message', description: 'Delete one explicitly identified message in an allowlisted channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_react', description: 'Add a reaction to an explicitly identified message in an allowlisted channel.', properties: { ...channelMessage, emoji: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['channelId', 'messageId', 'emoji'] },
  { name: 'discord_pin', description: 'Pin one explicitly identified message in an allowlisted channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_unpin', description: 'Unpin one explicitly identified message in an allowlisted channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_create_thread', description: 'Create a public thread from an allowlisted text channel. Threads cannot host nested threads.', properties: { channelId: snowflake, name: { type: 'string', minLength: 1, maxLength: 100 }, messageId: snowflake }, required: ['channelId', 'name'] },
  { name: 'discord_create_forum_post', description: 'Create a post in an allowlisted forum channel.', properties: { channelId: snowflake, title: { type: 'string', minLength: 1, maxLength: 100 }, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'title', 'content'] },
  { name: 'discord_archive_thread', description: 'Archive an existing thread under an allowlisted root channel; channelId is its parent and messageId is the thread ID.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_delete_thread', description: 'Delete only a verified thread under an allowlisted root channel; messageId is the thread ID here, never its parent.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_rename_post', description: 'Rename a verified post thread under an allowlisted forum.', properties: { threadId: snowflake, name: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['threadId', 'name'] },
  { name: 'discord_rename_forum', description: 'Rename an allowlisted forum channel.', properties: { channelId: snowflake, name: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['channelId', 'name'] },
  { name: 'discord_bot_mention_toggle', description: 'Owner only: enable or disable replies to other bots that explicitly mention Butler in allowed channels. Persists across restarts.', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
  { name: 'discord_attach_to_reply', description: 'Queue a local file from the configured attachment directory for the current final reply.', properties: { file: { type: 'string', minLength: 1, maxLength: 500 }, filename: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['file'] },
  { name: 'discord_send_buttons', description: 'Send persistent interactive Discord buttons whose allowlisted actions are executed once on click.', properties: { channelId: snowflake, content: { type: 'string', minLength: 1, maxLength: 2000 }, allowedUserIds: { type: 'array', items: snowflake, maxItems: 100, uniqueItems: true }, expiresInMinutes: { type: 'integer', minimum: 1, maximum: 10080 }, buttons: { type: 'array', minItems: 1, maxItems: 25, items: button } }, required: ['channelId', 'content', 'buttons'] },
];
export const discordMessageTools: DiscordToolDefinition[] = specs.map(({ name, description, properties, required }) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }));
export type DiscordToolRuntime = { definitions: DiscordToolDefinition[]; context: DiscordToolContext; execute(name: string, args: Record<string, unknown>): Promise<unknown> };

export function createDiscordToolRuntime(options: { token: string; channelIds: string[]; context: DiscordToolContext; fetcher?: typeof fetch; attachmentDir?: string }): DiscordToolRuntime {
  const allowed = new Set(options.channelIds); const fetcher = options.fetcher ?? fetch;
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try { response = await fetcher(`https://discord.com/api/v10${path}`, { method, headers: { authorization: `Bot ${options.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error('Discord REST request outcome is unknown; do not retry this tool automatically'); }
    if (!response.ok) throw new Error(`Discord REST request failed with HTTP ${response.status}; outcome may be unknown`);
    return response.status === 204 ? null : response.json();
  };
  const checkRootOrChild = async (id: string, requireThread = false): Promise<Record<string, unknown>> => {
    const target = asRecord(await api('GET', `/channels/${id}`));
    if (String(target.id) !== id) throw new Error('Discord returned a different channel than requested');
    const type = Number(target.type);
    if ([10, 11, 12].includes(type)) {
      const parent = String(target.parent_id ?? '');
      if (String(target.id) !== id) throw new Error('Discord returned a different channel than requested');
      if (!allowed.has(parent)) throw new Error('Discord thread parent is not allowlisted');
      if (requireThread && ![10, 11, 12].includes(type)) throw new Error('Target is not a thread');
      return target;
    }
    if (!allowed.has(id)) throw new Error('Discord tool target channel is not allowlisted');
    if (requireThread) throw new Error('Target is not a thread');
    return target;
  };
  const assertAllowedChannel = async (id: string): Promise<void> => { if (!allowed.has(id)) await checkRootOrChild(id); };
  const ownerTools = new Set(['discord_bot_mention_toggle', 'discord_attach_to_reply', 'discord_send_buttons']);
  const definitions = options.context.isBot ? discordMessageTools.filter(tool => !ownerTools.has(tool.name)) : discordMessageTools;
  return { definitions, context: options.context, async execute(name, args) {
    if (options.context.isBot && ownerTools.has(name)) throw new Error('This tool is restricted to the owner');
    if (options.context.isBot && !options.context.store?.botReplyEnabled()) throw new Error('Bot replies are disabled');
    const spec = specs.find(item => item.name === name); if (!spec) throw new Error(`Unknown Discord tool: ${name}`);
    validateArgs(spec, args);
    if (name === 'discord_bot_mention_toggle') {
      if (!options.context.store || !options.context.ownerId || options.context.actorId !== options.context.ownerId) throw new Error('Only the owner can change bot replies');
      options.context.store.setBotReplyEnabled(args.enabled as boolean);
      return { enabled: options.context.store.botReplyEnabled() };
    }
    const channelId = args.channelId === undefined ? undefined : stringArg(args.channelId, 'channelId');
    if (channelId) await assertAllowedChannel(channelId);
    const messageId = args.messageId === undefined ? undefined : stringArg(args.messageId, 'messageId');
    if (name === 'discord_attach_to_reply') {
      if (!options.attachmentDir) throw new Error('Local Discord attachments are not configured');
      mkdirSync(options.attachmentDir, { recursive: true });
      const root = realpathSync(options.attachmentDir); const file = stringArg(args.file, 'file');
      if (/^[a-z]+:\/\//i.test(file) || file.includes('\0') || file.includes('\\')) throw new Error('Attachment must be a local file path');
      const absolute = resolve(root, file); const real = realpathSync(absolute);
      if (relative(root, real).startsWith('..') || relative(root, real).startsWith('/')) throw new Error('Attachment path is outside the configured root');
      if (!statSync(real).isFile()) throw new Error('Attachment must be a regular file');
      const name = args.filename === undefined ? basename(real) : stringArg(args.filename, 'filename');
      if (name !== basename(name) || name.includes('\\') || name.includes('/') || name === '.' || name === '..') throw new Error('filename must be a plain filename');
      options.context.attachmentFiles.push({ attachment: real, name });
      return { status: 'queued_for_final_reply', filename: name, delivery: 'pending' };
    }
    if (name === 'discord_send_buttons') {
      if (!options.context.store || !options.context.ownerId || !options.context.sessionId) throw new Error('Persistent Discord actions are unavailable');
      const users = args.allowedUserIds as string[] | undefined;
      if (users?.length === 0) throw new Error('allowedUserIds must not be empty');
      if (users?.some(id => id !== options.context.ownerId)) throw new Error('Interactive actions are restricted to the configured owner');
      const allowedActions = new Set(specs.filter(s => ['discord_send_message','discord_edit_message','discord_delete_message','discord_react','discord_pin','discord_unpin','discord_create_thread','discord_create_forum_post','discord_archive_thread','discord_delete_thread','discord_rename_post','discord_rename_forum'].includes(s.name)).map(s => s.name));
      const buttons = args.buttons as Array<Record<string, unknown>>;
      if (new Set(buttons.map(item => item.id)).size !== buttons.length) throw new Error('Button IDs must be unique');
      for (const item of buttons) { const actionTool = stringArg(item.actionTool, 'actionTool'); if (!allowedActions.has(actionTool)) throw new Error('Button action is not executable'); validateArgs(specs.find(s => s.name === actionTool)!, item.actionArgs as Record<string, unknown>); if (item.actionArgs && 'channelId' in (item.actionArgs as object)) await assertAllowedChannel(String((item.actionArgs as Record<string, unknown>).channelId)); }
      const actionId = randomUUID(); const expiresAt = new Date(Date.now() + Number(args.expiresInMinutes ?? 1440) * 60_000).toISOString();
      const custom: Array<Record<string, unknown>> = buttons.map(item => ({ ...item, custom_id: `${actionId}:${randomUUID()}` }));
      options.context.store.createDiscordAction({ id: actionId, sessionId: options.context.sessionId, channelId: channelId!, ownerId: options.context.ownerId, expiresAt, buttons: custom });
      const components = [] as Array<{ type: number; components: unknown[] }>;
      for (let i=0;i<custom.length;i+=5) components.push({ type: 1, components: custom.slice(i,i+5).map(item => ({ type: 2, style: ({primary:1,secondary:2,success:3,danger:4} as Record<string,number>)[String(item['style'])], label: item['label'], custom_id: item['custom_id'] })) });
      const sent = asRecord(await api('POST', `/channels/${channelId}/messages`, { content: args.content, components, allowed_mentions: { parse: [] } }));
      if (typeof sent.id !== 'string') throw new Error('Discord button message outcome is unknown; do not retry automatically');
      options.context.store.bindDiscordActionMessage(actionId, sent.id);
      return { ok: true, channelId, messageId: sent.id, actionId, expiresAt, status: 'active', result: sent };
    }
    let method = 'GET'; let path = ''; let body: unknown;
    if (['discord_create_thread','discord_create_forum_post'].includes(name)) {
      const parent = await checkRootOrChild(channelId!); const type = Number(parent.type);
      if (name === 'discord_create_forum_post') { if (![15,16].includes(type)) throw new Error('Target channel is not a forum/media channel'); method='POST';path=`/channels/${channelId}/threads`;body={name:args.title,message:{content:args.content,allowed_mentions:{parse:[]}},auto_archive_duration:1440}; }
      else { if (![0,5].includes(type)) throw new Error('Target channel cannot host a public thread'); if (type === 5 && !messageId) throw new Error('Announcement channels require a source message to create a thread'); if (messageId) { method='POST';path=`/channels/${channelId}/messages/${messageId}/threads`;body={name:args.name,auto_archive_duration:1440}; } else { method='POST';path=`/channels/${channelId}/threads`;body={name:args.name,type:11,auto_archive_duration:1440}; } }
    } else if (['discord_archive_thread','discord_delete_thread'].includes(name)) {
      const thread = await checkRootOrChild(messageId!, true); if (String(thread.parent_id) !== channelId) throw new Error('Thread does not belong to the specified allowlisted root');
      if (name === 'discord_delete_thread') { method='DELETE'; path=`/channels/${messageId}`; } else { method='PATCH'; path=`/channels/${messageId}`; body={archived:true}; }
    } else if (name === 'discord_rename_post') {
      const target = await checkRootOrChild(stringArg(args.threadId,'threadId'),true); const parent=asRecord(await api('GET',`/channels/${String(target.parent_id)}`)); if (![15,16].includes(Number(parent.type))) throw new Error('Target thread is not a forum post'); method='PATCH';path=`/channels/${args.threadId}`;body={name:args.name};
    } else if (name === 'discord_rename_forum') {
      const channel=await checkRootOrChild(channelId!); if (![15,16].includes(Number(channel.type))) throw new Error('Target is not an allowlisted forum/media channel'); method='PATCH';path=`/channels/${channelId}`;body={name:args.name};
    } else {
      const base=`/channels/${channelId}`;
      switch(name) {
        case 'discord_send_message':method='POST';path=`${base}/messages`;body={content:args.content,allowed_mentions:{parse:[]}};break;
        case 'discord_fetch_message':path=`${base}/messages/${messageId}`;break;
        case 'discord_fetch_channel_messages':{const limit=args.limit===undefined?50:args.limit as number;const query=new URLSearchParams({limit:String(limit)});if(args.before!==undefined)query.set('before',String(args.before));path=`${base}/messages?${query}`;break;}
        case 'discord_edit_message':method='PATCH';path=`${base}/messages/${messageId}`;body={content:args.content,allowed_mentions:{parse:[]}};break;
        case 'discord_delete_message':method='DELETE';path=`${base}/messages/${messageId}`;break;
        case 'discord_react':method='PUT';path=`${base}/messages/${messageId}/reactions/${encodeURIComponent(args.emoji as string)}/@me`;break;
        case 'discord_pin':method='PUT';path=`${base}/messages/pins/${messageId}`;break;
        case 'discord_unpin':method='DELETE';path=`${base}/messages/pins/${messageId}`;break;
      }
    }
    const result=await api(method,path,body);
    if(name==='discord_fetch_message')return asRecord(result);
    if(name==='discord_fetch_channel_messages'){if(!Array.isArray(result))throw new Error('Discord returned an invalid message page');const limit=args.limit===undefined?50:args.limit as number;return {messages:result,limit,before:args.before??null,next_before:result.length===limit?(asRecord(result.at(-1)).id??null):null,may_have_more:result.length===limit};}
    const record = isRecord(result) ? result : null;
    return { ok: true, confirmed: true, channelId: channelId ?? null, ...(name === 'discord_create_thread' || name === 'discord_create_forum_post' ? { threadId: record?.id ?? null, result } : name === 'discord_send_message' ? { messageId: record?.id ?? null, result } : name === 'discord_edit_message' ? { messageId: messageId ?? null, result } : name === 'discord_rename_post' || name === 'discord_rename_forum' ? { id: record?.id ?? null, result } : { messageId: messageId ?? null, result }) };
  } };
}

function validateArgs(spec: ToolSpec,args:Record<string,unknown>):void {
  for(const required of spec.required) if(!(required in args)) throw new Error(`${required} is required`);
  validateValue({type:'object',properties:spec.properties,required:spec.required,additionalProperties:false},args,'arguments');
}
function validateValue(rule:Record<string,unknown>,value:unknown,path:string):void {
  if (rule.type === 'boolean') { if (typeof value !== 'boolean') throw new Error(`${path} is invalid`); return; }
  if(rule.type==='string') {
    if(typeof value!=='string'||value.length<Number(rule.minLength??0)||value.length>Number(rule.maxLength??Infinity)||(rule.pattern&&!new RegExp(String(rule.pattern)).test(value))||(Array.isArray(rule.enum)&&!rule.enum.includes(value))) throw new Error(`${path} is invalid`);
    return;
  }
  if(rule.type==='integer') { if(!Number.isSafeInteger(value)||Number(value)<Number(rule.minimum??-Infinity)||Number(value)>Number(rule.maximum??Infinity)) throw new Error(`${path} is invalid`); return; }
  if(rule.type==='array') {
    if(!Array.isArray(value)||value.length<Number(rule.minItems??0)||value.length>Number(rule.maxItems??Infinity)||(rule.uniqueItems===true&&new Set(value).size!==value.length)) throw new Error(`${path} is invalid`);
    for(let index=0;index<value.length;index++) validateValue(rule.items as Record<string,unknown>,value[index],`${path}[${index}]`);
    return;
  }
  if(rule.type==='object') {
    if(!isRecord(value)) throw new Error(`${path} is invalid`);
    const properties=isRecord(rule.properties)?rule.properties:{};
    if(Array.isArray(rule.required)) for(const key of rule.required) if(typeof key==='string'&&!(key in value)) throw new Error(`${path}.${key} is required`);
    for(const [key,item] of Object.entries(value)) {
      const child=properties[key];
      if(!child) { if(rule.additionalProperties!==true) throw new Error(`Unexpected argument: ${path}.${key}`); continue; }
      validateValue(child as Record<string,unknown>,item,`${path}.${key}`);
    }
  }
}
function stringArg(value:unknown,name:string):string{if(typeof value!=='string'||!value.length)throw new Error(`${name} is invalid`);return value;}
function asRecord(value:unknown):Record<string,unknown>{if(!isRecord(value))throw new Error('Discord returned an invalid object');return value;}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
