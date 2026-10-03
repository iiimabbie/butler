import { Client, EmbedBuilder, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { writeFileSync } from 'node:fs';
import type { Store } from './store.js';
import { ask } from './agent.js';
import { createDiscordToolRuntime } from './discord-tools.js';

export const DISCORD_MESSAGE_LIMIT = 2000;
const DELIVERY_ERROR = 'Butler 暫時無法處理這項請求，請稍後再試。';
const ALLOWED_MENTIONS = { parse: [] as [], repliedUser: false };
export type DiscordConfig = { token: string; ownerId: string; channelIds: string[]; defaultModel: string; baseUrl: string; apiKey?: string };
export type TextMessage = { authorId: string; channelId: string; messageId?: string; content: string; hasAttachments?: boolean; isBot?: boolean; isWebhook?: boolean; reply(text: string, options?: { allowedMentions: typeof ALLOWED_MENTIONS }): Promise<unknown> };
export type CommandContext = { ownerId: string; channelId: string; command: 'status' | 'model' | 'new' | 'mode' | 'restart'; model?: string; mode?: 'queue' | 'steer'; reply(text: string, options?: { embed?: import('discord.js').APIEmbed; ephemeral?: boolean }): Promise<unknown> };
export type RestartNotice = { channelId: string; messageId: string };
const modelCache = new Map<string, { expiresAt: number; models: string[] }>();
const modelInflight = new Map<string, Promise<string[]>>();
const MODEL_TTL = 5 * 60_000;
const MEDIA_MODEL_SEGMENTS = new Set(['img', 'image', 'images', 'video', 'videos']);
export type DiscordCommandApi = { get(route: string): Promise<unknown>; post(route: string, options: { body: unknown }): Promise<unknown>; patch(route: string, options: { body: unknown }): Promise<unknown> };

export class DiscordHandler {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeAsk = new Set<string>();
  private readonly pendingSteer = new Map<string, string[]>();
  private readonly workCounts = new Map<string, number>();
  private stopping = false;
  constructor(private readonly store: Store, private readonly config: DiscordConfig, private readonly runAsk = ask, private readonly restart?: (channelId: string) => Promise<boolean>) {}

  queueStatus(channelId: string): 'idle' | 'busy' { return this.queues.has(channelId) ? 'busy' : 'idle'; }

  async message(message: TextMessage): Promise<void> {
    if (message.isBot || message.isWebhook || !this.config.channelIds.includes(message.channelId) || message.authorId !== this.config.ownerId || this.stopping) return;
    const content = message.content.trim();
    if (!content && !message.hasAttachments) return;
    const mode = this.store.channelMode(message.channelId);
    if (content && mode === 'steer' && this.activeAsk.has(message.channelId) && (this.workCounts.get(message.channelId) ?? 0) === 1) {
      const pending = this.pendingSteer.get(message.channelId) ?? [];
      pending.push(content);
      this.pendingSteer.set(message.channelId, pending);
      if (message.hasAttachments) {
        try { await message.reply('（附件尚未支援；我只處理文字內容。）', { allowedMentions: ALLOWED_MENTIONS }); }
        catch { logSafe('Discord steer attachment notice delivery failed'); }
      }
      return;
    }
    await this.enqueue(message.channelId, async () => {
      let text: string;
      let sessionId: string | undefined;
      let consumedSteer = false;
      try {
        const state = this.store.channelState(message.channelId, this.config.defaultModel);
        sessionId = state.sessionId;
        if (!content) {
          text = '（附件尚未支援；我只處理文字內容。）';
        } else {
          this.activeAsk.add(message.channelId);
          const result = await this.runAsk(this.store, state.sessionId, content, {
            baseUrl: this.config.baseUrl, apiKey: this.config.apiKey, model: state.model,
            discordTools: createDiscordToolRuntime({ token: this.config.token, channelIds: this.config.channelIds, context: { channelId: message.channelId, messageId: message.messageId } }),
            discordContext: { channelId: message.channelId, messageId: message.messageId },
            consumeSteer: () => this.pendingSteer.get(message.channelId)?.[0],
            onSteerPersisted: persisted => {
              const pending = this.pendingSteer.get(message.channelId);
              if (pending?.[0] === persisted) pending.shift();
              consumedSteer = true;
              if (!pending?.length) this.pendingSteer.delete(message.channelId);
            },
          });
          this.activeAsk.delete(message.channelId);
          text = message.hasAttachments ? `${result}\n\n（附件尚未支援；我只處理文字內容。）` : result;
        }
      } catch {
        logSafe('Discord message processing failed');
        const pending = this.pendingSteer.get(message.channelId) ?? [];
        const hadSteer = consumedSteer || pending.length > 0;
        let preservationFailed = false;
        if (pending.length && !sessionId) preservationFailed = true;
        if (sessionId && pending.length) {
          for (const supplement of pending.splice(0)) {
            try { this.store.addMessage(sessionId, 'user', supplement); }
            catch { preservationFailed = true; }
          }
        }
        pending.splice(0);
        this.pendingSteer.delete(message.channelId);
        text = preservationFailed ? '目前回合失敗，補充內容未能保存；請重新傳送補充與原始問題。' : hadSteer ? '目前回合失敗；已收到的補充已保留在此 session，請重送原始問題以繼續。' : DELIVERY_ERROR;
      } finally {
        this.activeAsk.delete(message.channelId);
        if (!this.pendingSteer.get(message.channelId)?.length) this.pendingSteer.delete(message.channelId);
      }
      try {
        await sendText(message, text || DELIVERY_ERROR);
      } catch {
        logSafe('Discord message reply delivery failed');
        throw new Error('Discord reply delivery failed');
      }
    });
  }

  async command(context: CommandContext): Promise<void> {
    if (context.ownerId !== this.config.ownerId || !this.config.channelIds.includes(context.channelId)) {
      await context.reply('此操作者或頻道未獲允許。');
      return;
    }
    if (this.stopping) { await context.reply('Butler 正在關閉，暫時不接受新指令。'); return; }
    const state = this.store.channelState(context.channelId, this.config.defaultModel);
    if (context.command === 'status') {
      const embed = new EmbedBuilder().setTitle('Butler 狀態').addFields(
        { name: '工作階段', value: state.sessionId },
        { name: '模型', value: state.model },
        { name: '訊息模式', value: this.store.channelMode(context.channelId) },
        { name: '處理狀態', value: this.queueStatus(context.channelId) === 'busy' ? '處理中' : '閒置' },
      ).toJSON();
      await context.reply('', { embed });
      return;
    }
    if (context.command === 'mode') {
      if (!context.mode) { await context.reply(`目前模式：${this.store.channelMode(context.channelId)}`); return; }
      await this.enqueue(context.channelId, async () => {
        this.store.setChannelMode(context.channelId, context.mode!);
        await context.reply(`模式已切換：${context.mode}`);
      });
      return;
    }
    if (context.command === 'restart') {
      if (!this.restart) { await context.reply('目前不是由受控重啟入口啟動，無法重啟。'); return; }
      if (this.queues.size > 0) { await context.reply('目前有頻道工作進行中或排隊，無法重啟。'); return; }
      this.stopping = true;
      let notice: unknown;
      try {
        notice = await context.reply('重啟中', { ephemeral: false });
        const messageId = typeof notice === 'object' && notice !== null && 'id' in notice ? String((notice as { id: unknown }).id) : '';
        if (!messageId) throw new Error('restart acknowledgement did not return a message ID');
        this.store.setRestartNotice(context.channelId, messageId);
      } catch {
        this.stopping = false;
        try { await context.reply('無法保存重啟通知，Butler 已恢復接收工作。'); } catch { /* interaction may already be acknowledged */ }
        logSafe('Discord restart notice persistence failed');
        return;
      }
      try {
        const accepted = await this.restart(context.channelId);
        if (!accepted) throw new Error('managed restart was not accepted');
      } catch {
        this.stopping = false;
        this.store.setRestartNotice(null);
        logSafe('Discord managed restart failed');
        try { await context.reply('重啟未能啟動；Butler 已恢復接收工作。'); } catch { logSafe('Discord restart failure notice delivery failed'); }
      }
      return;
    }
    if (context.command === 'new') {
      await this.enqueue(context.channelId, async () => {
        const sessionId = this.store.newSession();
        this.store.setChannelSession(context.channelId, sessionId);
        await context.reply(`新 session：${sessionId}`);
      });
      return;
    }
    if (!context.model?.trim()) {
      await context.reply(`目前模型：${state.model}`);
      return;
    }
    await this.enqueue(context.channelId, async () => {
      this.store.setChannelModel(context.channelId, context.model!.trim());
      await context.reply(`模型已設定：${context.model!.trim()}`);
    });
  }

  private enqueue(channelId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(channelId) ?? Promise.resolve();
    this.workCounts.set(channelId, (this.workCounts.get(channelId) ?? 0) + 1);
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(channelId, next);
    void next.finally(() => {
      const remaining = (this.workCounts.get(channelId) ?? 1) - 1;
      if (remaining > 0) this.workCounts.set(channelId, remaining);
      else this.workCounts.delete(channelId);
      if (this.queues.get(channelId) === next) this.queues.delete(channelId);
    }).catch(() => undefined);
    return next;
  }
}

export function splitDiscordText(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + DISCORD_MESSAGE_LIMIT, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function sendText(message: TextMessage, text: string): Promise<void> {
  for (const chunk of splitDiscordText(text)) {
    await message.reply(chunk, { allowedMentions: ALLOWED_MENTIONS });
  }
}

export const commands = [
  new SlashCommandBuilder().setName('status').setDescription('Show Butler session status'),
  new SlashCommandBuilder().setName('model').setDescription('Show or set the CPA model').addStringOption(option => option.setName('id').setDescription('CPA model ID').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('mode').setDescription('Show or set message handling mode').addStringOption(option => option.setName('value').setDescription('queue or steer').setRequired(false).addChoices({ name: 'queue', value: 'queue' }, { name: 'steer', value: 'steer' })),
  new SlashCommandBuilder().setName('restart').setDescription('Restart Butler through its managed launcher'),
  new SlashCommandBuilder().setName('new').setDescription('Start a new conversation session'),
].map(command => command.toJSON());

export function readDiscordConfig(env: NodeJS.ProcessEnv): DiscordConfig {
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required`); return value; };
  const token = required('BUTLER_DISCORD_TOKEN');
  const ownerId = required('BUTLER_DISCORD_OWNER_ID');
  const channelIds = required('BUTLER_DISCORD_CHANNEL_IDS').split(',').map(value => value.trim()).filter(Boolean);
  if (channelIds.length === 0) throw new Error('BUTLER_DISCORD_CHANNEL_IDS must contain at least one channel ID');
  const defaultModel = required('CPA_MODEL');
  return { token, ownerId, channelIds, defaultModel, baseUrl: env.CPA_BASE_URL ?? 'http://127.0.0.1:8317/v1', apiKey: env.CPA_API_KEY };
}

export async function registerDiscordCommands(config: DiscordConfig, testApi?: DiscordCommandApi): Promise<void> {
  const guildId = process.env.BUTLER_DISCORD_GUILD_ID?.trim();
  const applicationId = process.env.BUTLER_DISCORD_APPLICATION_ID?.trim();
  if (!guildId) throw new Error('BUTLER_DISCORD_GUILD_ID is required');
  if (!applicationId) throw new Error('BUTLER_DISCORD_APPLICATION_ID is required');
  const route = Routes.applicationGuildCommands(applicationId, guildId);
  const api = testApi ?? (new REST({ version: '10' }).setToken(config.token) as unknown as DiscordCommandApi);
  const result = await api.get(route);
  if (!Array.isArray(result)) throw new Error('Discord guild command list is invalid');
  const existing = result as Array<{ id?: string; name?: string; description?: string; options?: Array<{ name?: string; description?: string; type?: number | string; required?: boolean; autocomplete?: boolean; choices?: Array<{ name?: string; value?: string | number }> }> }>;
  for (const desired of commands) {
    const current = existing.find(command => command.name === desired.name);
    if (!current) { await api.post(route, { body: desired }); continue; }
    if (!sameCommandDefinition(current, desired)) {
      if (!current.id) throw new Error(`Guild command /${desired.name} cannot be updated without its ID`);
      await api.patch(Routes.applicationGuildCommand(applicationId, guildId, current.id), { body: desired });
    }
  }
}

function sameCommandDefinition(current: { description?: string; options?: Array<{ name?: string; description?: string; type?: number | string; required?: boolean; autocomplete?: boolean; choices?: Array<{ name?: string; value?: string | number }> }> }, desired: { description?: string; options?: Array<{ name?: string; description?: string; type?: number; required?: boolean; autocomplete?: boolean; choices?: Array<{ name?: string; value?: string | number }> }> }): boolean {
  if (current.description !== desired.description) return false;
  const signature = (options: Array<{ name?: string; description?: string; type?: number | string; required?: boolean; autocomplete?: boolean; choices?: Array<{ name?: string; value?: string | number }> }> = []) => options.map(option => ({
    name: option.name,
    description: option.description,
    type: option.type === undefined ? undefined : Number(option.type),
    required: option.required ?? false,
    autocomplete: option.autocomplete ?? false,
    choices: option.choices?.map(({ name, value }) => ({ name, value })) ?? [],
  }));
  return JSON.stringify(signature(current.options)) === JSON.stringify(signature(desired.options));
}

export async function handleInteraction(handler: DiscordHandler, interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  if (!['status', 'model', 'new', 'mode', 'restart'].includes(interaction.commandName)) return;
  try {
    const restart = interaction.commandName === 'restart';
    if (!restart) await interaction.deferReply({ ephemeral: true });
    let acknowledged = false;
    await handler.command({ ownerId: interaction.user.id, channelId: interaction.channelId ?? '', command: interaction.commandName as CommandContext['command'], model: interaction.options.getString('id') ?? undefined, mode: interaction.options.getString('value') as 'queue' | 'steer' | null ?? undefined, reply: async (content, options) => {
      if (restart && !acknowledged) {
        acknowledged = true;
        return interaction.reply({ content, ephemeral: options?.ephemeral ?? false, fetchReply: true, allowedMentions: ALLOWED_MENTIONS });
      }
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content, embeds: options?.embed ? [options.embed] : [], allowedMentions: ALLOWED_MENTIONS });
      return interaction.reply({ content, ephemeral: true, embeds: options?.embed ? [options.embed] : [], allowedMentions: ALLOWED_MENTIONS });
    } });
  } catch {
    logSafe('Discord interaction failed');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: DELIVERY_ERROR, allowedMentions: ALLOWED_MENTIONS });
      } else {
        await interaction.reply({ content: DELIVERY_ERROR, ephemeral: true, allowedMentions: ALLOWED_MENTIONS });
      }
    } catch {
      logSafe('Discord interaction failure notice delivery failed');
    }
  }
}

export async function modelChoices(config: DiscordConfig, focused: string, fetcher: typeof fetch = fetch): Promise<Array<{ name: string; value: string }>> {
  const key = `${config.baseUrl}\u0000${config.apiKey ?? ''}`;
  let models: string[] = [];
  try {
    const cached = modelCache.get(key);
    if (cached && cached.expiresAt > Date.now()) models = cached.models;
    else {
      let request = modelInflight.get(key);
      if (!request) {
        request = (async () => {
          const headers: Record<string, string> = {};
          if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
          const response = await fetcher(`${config.baseUrl.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(2_000) });
          if (!response.ok) throw new Error('model list request failed');
          const body: unknown = await response.json();
          if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('model list response invalid');
          const ids = body.data.map(item => isRecord(item) && typeof item.id === 'string' ? item.id.trim() : '').filter(Boolean);
          if (!ids.length) throw new Error('model list empty');
          return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
        })();
        modelInflight.set(key, request);
      }
      try { models = await request; modelCache.set(key, { models, expiresAt: Date.now() + MODEL_TTL }); }
      finally { modelInflight.delete(key); }
    }
  } catch { logSafe('Discord model autocomplete failed'); return []; }
  const conversational = models.filter(model => !model.toLowerCase().split(/[^a-z0-9]+/).some(part => MEDIA_MODEL_SEGMENTS.has(part)));
  const candidates = conversational.length ? conversational : models;
  const needle = focused.toLowerCase();
  return candidates.filter(model => model.length <= 100 && model.toLowerCase().includes(needle)).slice(0, 25)
    .map(model => ({ name: model, value: model }));
}

export async function handleAutocomplete(config: DiscordConfig, interaction: import('discord.js').AutocompleteInteraction, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    if (interaction.commandName !== 'model' || interaction.options.getFocused(true).name !== 'id' || interaction.user.id !== config.ownerId || !config.channelIds.includes(interaction.channelId ?? '')) {
      await interaction.respond([]); return;
    }
    await interaction.respond(await modelChoices(config, String(interaction.options.getFocused()), fetcher));
  } catch { logSafe('Discord autocomplete failed'); try { await interaction.respond([]); } catch { /* expired interaction */ } }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export async function startDiscord(config: DiscordConfig, store: Store, clientOverride?: Client): Promise<void> {
  const readyFile = process.env.BUTLER_RESTART_READY_FILE;
  let finish!: () => void;
  const lifetime = new Promise<void>(resolve => { finish = resolve; });
  let exitCode = 0;
  let client!: Client;
  const requestRestart = readyFile ? async () => {
    exitCode = 75;
    await shutdown();
    finish();
    return true;
  } : undefined;
  const handler = new DiscordHandler(store, config, ask, requestRestart);
  client = clientOverride ?? new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.once('clientReady', readyClient => {
    console.info(`Discord ready (bot ID: ${readyClient.user.id})`);
    const notice = store.restartNotice();
    if (notice && config.channelIds.includes(notice.channelId)) {
      void (async () => {
        const channel = await client.channels.fetch(notice.channelId);
        if (!channel?.isTextBased() || !('messages' in channel)) throw new Error('restart notification channel unavailable');
        const message = await channel.messages.fetch(notice.messageId);
        await message.edit({ content: '重啟完成', allowedMentions: ALLOWED_MENTIONS });
        store.setRestartNotice(null);
      })().catch(() => logSafe('Discord restart readiness notification failed'));
    }
    if (readyFile) { try { writeFileSync(readyFile, 'ready\\n', { mode: 0o600 }); } catch { logSafe('Discord readiness signal failed'); } }
  });
  client.on('messageCreate', message => {
    void handler.message({ authorId: message.author.id, channelId: message.channelId, messageId: message.id, content: message.content, hasAttachments: message.attachments.size > 0, isBot: message.author.bot, isWebhook: Boolean(message.webhookId), reply: (text, options) => message.reply({ content: text, allowedMentions: options?.allowedMentions }) })
      .catch(() => undefined);
  });
  client.on('interactionCreate', interaction => {
    if (interaction.isAutocomplete?.()) void handleAutocomplete(config, interaction);
    else if (interaction.isChatInputCommand()) void handleInteraction(handler, interaction).catch(() => logSafe('Discord interaction handler failed'));
  });
  client.on('error', () => logSafe('Discord client error'));

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    try { await client.destroy(); } catch { logSafe('Discord client shutdown failed'); }
    try { store.close(); } catch { logSafe('Discord database shutdown failed'); }
  };
  const onSigint = () => { void shutdown().then(finish).catch(() => { logSafe('Discord SIGINT shutdown failed'); finish(); }); };
  const onSigterm = () => { void shutdown().then(finish).catch(() => { logSafe('Discord SIGTERM shutdown failed'); finish(); }); };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await client.login(config.token);
    await lifetime;
    process.exitCode = exitCode;
  } catch {
    await shutdown();
    throw new Error('Discord login failed');
  }
}

function logSafe(context: string): void {
  console.error(context);
}
function isHighSurrogate(code: number): boolean { return code >= 0xD800 && code <= 0xDBFF; }
function isLowSurrogate(code: number): boolean { return code >= 0xDC00 && code <= 0xDFFF; }
