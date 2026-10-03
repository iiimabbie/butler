export type DiscordToolContext = { channelId: string; messageId?: string };
type DiscordToolDefinition = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };
type ToolSpec = { name: string; description: string; properties: Record<string, unknown>; required: string[] };

const snowflake = { type: 'string', pattern: '^[0-9]{2,32}$' };
const channelMessage = { channelId: snowflake, messageId: snowflake };
const specs: ToolSpec[] = [
  { name: 'discord_send_message', description: 'Send a message to an explicitly identified allowlisted Discord channel.', properties: { channelId: snowflake, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'content'] },
  { name: 'discord_fetch_message', description: 'Fetch one message from an explicitly identified allowlisted Discord channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_fetch_channel_messages', description: 'Fetch a bounded page of messages from an allowlisted channel; pass before to continue toward older messages.', properties: { channelId: snowflake, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: snowflake }, required: ['channelId'] },
  { name: 'discord_edit_message', description: 'Edit a message authored by this bot in an allowlisted channel.', properties: { ...channelMessage, content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['channelId', 'messageId', 'content'] },
  { name: 'discord_delete_message', description: 'Delete one explicitly identified message in an allowlisted channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_react', description: 'Add a reaction to an explicitly identified message in an allowlisted channel. Emoji may be Unicode or name:id.', properties: { ...channelMessage, emoji: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['channelId', 'messageId', 'emoji'] },
  { name: 'discord_pin', description: 'Pin one explicitly identified message in an allowlisted channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
  { name: 'discord_unpin', description: 'Unpin one explicitly identified message in an allowlisted channel.', properties: channelMessage, required: ['channelId', 'messageId'] },
];

export const discordMessageTools: DiscordToolDefinition[] = specs.map(({ name, description, properties, required }) => ({
  type: 'function', name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
}));

export type DiscordToolRuntime = {
  definitions: DiscordToolDefinition[];
  context: DiscordToolContext;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
};

export function createDiscordToolRuntime(options: { token: string; channelIds: string[]; context: DiscordToolContext; fetcher?: typeof fetch }): DiscordToolRuntime {
  const allowed = new Set(options.channelIds);
  const fetcher = options.fetcher ?? fetch;
  return {
    definitions: discordMessageTools,
    context: options.context,
    async execute(name, args) {
      if (!specs.some(spec => spec.name === name)) throw new Error(`Unknown Discord tool: ${name}`);
      const spec = specs.find(item => item.name === name)!;
      validateArgs(spec, args);
      const channelId = stringArg(args.channelId, 'channelId');
      if (!allowed.has(channelId)) throw new Error('Discord tool target channel is not allowlisted');
      const messageId = args.messageId === undefined ? undefined : stringArg(args.messageId, 'messageId');
      const content = args.content === undefined ? undefined : stringArg(args.content, 'content');
      const base = `/channels/${channelId}`;
      let method = 'GET';
      let path = '';
      let body: unknown;
      switch (name) {
        case 'discord_send_message': method = 'POST'; path = `${base}/messages`; body = { content, allowed_mentions: { parse: [] } }; break;
        case 'discord_fetch_message': path = `${base}/messages/${messageId}`; break;
        case 'discord_fetch_channel_messages': {
          const limit = args.limit === undefined ? 50 : args.limit as number;
          const query = new URLSearchParams({ limit: String(limit) });
          if (args.before !== undefined) query.set('before', args.before as string);
          path = `${base}/messages?${query}`;
          break;
        }
        case 'discord_edit_message': method = 'PATCH'; path = `${base}/messages/${messageId}`; body = { content, allowed_mentions: { parse: [] } }; break;
        case 'discord_delete_message': method = 'DELETE'; path = `${base}/messages/${messageId}`; break;
        case 'discord_react': method = 'PUT'; path = `${base}/messages/${messageId}/reactions/${encodeURIComponent(args.emoji as string)}/@me`; break;
        case 'discord_pin': method = 'PUT'; path = `${base}/messages/pins/${messageId}`; break;
        case 'discord_unpin': method = 'DELETE'; path = `${base}/messages/pins/${messageId}`; break;
      }
      let response: Response;
      try {
        response = await fetcher(`https://discord.com/api/v10${path}`, {
          method, headers: { authorization: `Bot ${options.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error('Discord REST request outcome is unknown; do not retry this tool automatically');
      }
      if (!response.ok) throw new Error(`Discord REST request failed with HTTP ${response.status}; outcome may be unknown`);
      const result: unknown = response.status === 204 ? null : await response.json();
      if (name === 'discord_fetch_message') return rawMessage(result);
      if (name === 'discord_fetch_channel_messages') {
        if (!Array.isArray(result)) throw new Error('Discord returned an invalid message page');
        const limit = args.limit === undefined ? 50 : args.limit as number;
        const messages = result.map(rawMessage);
        const last = messages.at(-1);
        return { messages, limit, before: args.before ?? null, next_before: messages.length === limit ? last?.id ?? null : null, may_have_more: messages.length === limit };
      }
      return { ok: true, confirmed: true, channelId, ...(messageId ? { messageId } : {}), ...(name === 'discord_send_message' && isRecord(result) && typeof result.id === 'string' ? { messageId: result.id } : {}) };
    },
  };
}

function validateArgs(spec: ToolSpec, args: Record<string, unknown>): void {
  const properties = spec.properties;
  for (const required of spec.required) if (!(required in args)) throw new Error(`${required} is required`);
  for (const key of Object.keys(args)) if (!(key in properties)) throw new Error(`Unexpected argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key] as Record<string, unknown>;
    if (rule.type === 'string') {
      if (typeof value !== 'string' || value.length < Number(rule.minLength ?? 0) || value.length > Number(rule.maxLength ?? Infinity) || (rule.pattern && !new RegExp(String(rule.pattern)).test(value))) throw new Error(`${key} is invalid`);
    } else if (rule.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < Number(rule.minimum) || Number(value) > Number(rule.maximum))) throw new Error(`${key} is invalid`);
  }
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`${name} is invalid`);
  return value;
}

function rawMessage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Discord returned an invalid message');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
