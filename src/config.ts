import { isRecord } from './tools/tool-schema.js';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { parse } from 'yaml';
import type { WebConfig } from './tools/web-tools.js';
import type { ImageConfig } from './tools/image-tools.js';
import type { AudioTranscriptionConfig } from './attachments/audio-transcription.js';
import type { LogMethods } from './log.js';
import { projectPath } from './paths.js';
import { validateTimezone } from './scheduler.js';
import { DEFAULT_SCHEDULE_TIMEZONE } from './timezone.js';

export type GoogleClientConfig = { clientId: string; clientSecret: string };
export type NotificationConfig = { host: string; port: number; bearerToken: string };
export type ButlerConfig = {
  notifications?: NotificationConfig;
  mail?: { accounts: Array<{ email: string; delaySeconds?: number }> };
  discord?: { token?: string; ownerId?: string; errorWebhookUrl?: string; errorWebhookMentionUserId?: string; errorWebhookThreadId?: string; errorWebhookModel?: string; notificationChannelId?: string; notificationModel?: string };
  llm?: { baseUrl?: string; apiKey?: string; model?: string; maxContextTokens?: number; modelContextTokens?: Record<string, number>; requestTimeoutMs?: number };
  web?: WebConfig;
  hledger?: { enabled: boolean };
  ui?: { port: number; publicOrigin: string; cookiePath: string };
  google?: GoogleClientConfig;
  memory?: { baseUrl: string; bankId: string; timeoutMs?: number };
  image?: ImageConfig;
  transcription?: AudioTranscriptionConfig;
  schedule?: { timezone?: string; model?: string };
  subagent?: { toolsEnabled: boolean; allowClaude: boolean };
};

export type FixedChannel = { id: string; model?: string };

// Channels whose policy comes from config.yaml rather than channels.yaml: the error webhook thread and the phone notification channel.
export function configuredFixedChannels(config: ButlerConfig): FixedChannel[] {
  const discord = config.discord;
  return [
    ...(discord?.errorWebhookUrl && discord.errorWebhookThreadId ? [{ id: discord.errorWebhookThreadId, model: discord.errorWebhookModel }] : []),
    ...(discord?.notificationChannelId ? [{ id: discord.notificationChannelId, model: discord.notificationModel }] : []),
  ];
}

const CONFIG_PATH = projectPath('.data/config.yaml');

export function readConfig(path = CONFIG_PATH): ButlerConfig {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8'), { logLevel: 'silent' }); }
  catch { throw new Error('Butler config could not be read as YAML'); }
  return validateConfig(raw);
}

function validateConfig(raw: unknown): ButlerConfig {
  if (!isRecord(raw)) throw new Error('Butler config must be an object');
  const config: ButlerConfig = {};
  for (const name of ['discord', 'llm', 'web', 'hledger', 'ui', 'google', 'memory', 'image', 'transcription', 'schedule', 'subagent', 'notifications', 'mail'] as const) {
    if (raw[name] === undefined) continue;
    const section = name === 'subagent' && raw[name] === null ? {} : raw[name];
    if (!isRecord(section)) throw new Error(`Butler config ${name} must be an object`);
    const string = (field: string): string | undefined => {
      const value = section[field];
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Butler config ${name}.${field} must be a nonempty string`);
      return value;
    };
    if (name === 'discord') {
      const errorWebhookUrl = string('errorWebhookUrl');
      if (errorWebhookUrl !== undefined && !/^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/\d+\/[^/?#]+$/.test(errorWebhookUrl)) throw new Error('Butler config discord.errorWebhookUrl must be a Discord webhook URL without query or fragment');
      const errorWebhookMentionUserId = string('errorWebhookMentionUserId');
      if (errorWebhookMentionUserId !== undefined && !/^\d+$/.test(errorWebhookMentionUserId)) throw new Error('Butler config discord.errorWebhookMentionUserId must be a numeric Discord user ID');
      const errorWebhookThreadId = string('errorWebhookThreadId');
      if (errorWebhookThreadId !== undefined && !/^\d+$/.test(errorWebhookThreadId)) throw new Error('Butler config discord.errorWebhookThreadId must be a numeric Discord thread ID');
      const notificationChannelId = string('notificationChannelId');
      if (notificationChannelId !== undefined && !/^\d{17,20}$/.test(notificationChannelId)) throw new Error('Butler config discord.notificationChannelId must be a Discord channel ID');
      config.discord = { token: string('token'), ownerId: string('ownerId'), errorWebhookUrl, errorWebhookMentionUserId, errorWebhookThreadId, errorWebhookModel: string('errorWebhookModel'), notificationChannelId, notificationModel: string('notificationModel') };
    } else if (name === 'llm') {
      const baseUrl = string('baseUrl');
      if (baseUrl !== undefined) validateHttpUrl(baseUrl, 'llm.baseUrl');
      const maxContextTokens = section.maxContextTokens;
      if (maxContextTokens !== undefined && (!Number.isSafeInteger(maxContextTokens) || (maxContextTokens as number) <= 0)) throw new Error('Butler config llm.maxContextTokens must be a positive integer');
      const modelContextTokens = section.modelContextTokens;
      if (modelContextTokens !== undefined && (!isRecord(modelContextTokens) || Object.entries(modelContextTokens).some(([model, limit]) => !model.trim() || !Number.isSafeInteger(limit) || (limit as number) <= 0))) throw new Error('Butler config llm.modelContextTokens must map model IDs to positive integers');
      const requestTimeoutMs = section.requestTimeoutMs;
      if (requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs) || (requestTimeoutMs as number) <= 0)) throw new Error('Butler config llm.requestTimeoutMs must be a positive integer');
      config.llm = { baseUrl, apiKey: string('apiKey'), model: string('model'), maxContextTokens: (maxContextTokens as number | undefined) ?? 150000, modelContextTokens: (modelContextTokens as Record<string, number> | undefined) ?? {}, requestTimeoutMs: (requestTimeoutMs as number | undefined) ?? 600_000 };
    } else if (name === 'hledger') {
      const enabled = section.enabled;
      if (typeof enabled !== 'boolean') throw new Error('Butler config hledger.enabled must be boolean');
      config.hledger = { enabled };
    } else if (name === 'web') {
      for (const field of ['provider','apiKey','baseUrl']) if (section[field] !== undefined) throw new Error(`Butler config web.${field} is no longer supported; configure web.tavily instead`);
      config.web = {};
      if (section.pool !== undefined) {
        if (!isRecord(section.pool)) throw new Error('Butler config web.pool must be an object');
        const pool = section.pool;
        const order = (field: string): ('tavily' | 'firecrawl' | 'anysearch')[] | undefined => {
          const value = pool[field];
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length || value.some(item => !['tavily','firecrawl','anysearch'].includes(item))) throw new Error(`Butler config web.pool.${field} must contain unique supported providers`);
          return value;
        };
        const limit = (field: string, min: number, max: number): number | undefined => {
          const value = pool[field];
          if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)) throw new Error(`Butler config web.pool.${field} is outside its allowed range`);
          return value as number | undefined;
        };
        if (pool.tavilyDailyRequestLimit !== undefined) throw new Error('Butler config web.pool.tavilyDailyRequestLimit is no longer supported; configure web.tavily.dailyRequestLimit');
        config.web.pool = { searchOrder: order('searchOrder'), fetchOrder: order('fetchOrder'), searchTimeoutMs: limit('searchTimeoutMs',1,120000), fetchTimeoutMs: limit('fetchTimeoutMs',1,120000), attemptTimeoutMs: limit('attemptTimeoutMs',1,45000), maxAttempts: limit('maxAttempts',1,3) };
      }
      for (const provider of ['tavily','firecrawl','anysearch'] as const) {
        if (section[provider] !== undefined) {
          if (!isRecord(section[provider])) throw new Error(`Butler config web.${provider} must be an object`);
          const providerConfig = section[provider];
          if (providerConfig.enabled !== undefined && typeof providerConfig.enabled !== 'boolean') throw new Error(`Butler config web.${provider}.enabled must be boolean`);
          for (const field of ['apiKey','baseUrl']) if (providerConfig[field] !== undefined && (typeof providerConfig[field] !== 'string' || !String(providerConfig[field]).trim())) throw new Error(`Butler config web.${provider}.${field} must be a nonempty string`);
          if (providerConfig.baseUrl !== undefined) validateHttpUrl(String(providerConfig.baseUrl), `web.${provider}.baseUrl`);
          const daily = providerConfig.dailyRequestLimit;
          if (daily !== undefined && (!Number.isSafeInteger(daily) || Number(daily) < 0 || Number(daily) > 10000)) throw new Error(`Butler config web.${provider}.dailyRequestLimit must be an integer from 0 to 10000`);
          if (providerConfig.enabled === true && (!providerConfig.apiKey || daily === undefined)) throw new Error(`Enabled ${provider} requires an API key and explicit dailyRequestLimit`);
          config.web[provider] = { enabled: providerConfig.enabled as boolean | undefined, apiKey: providerConfig.apiKey as string | undefined, baseUrl: providerConfig.baseUrl as string | undefined, dailyRequestLimit: daily as number | undefined };
        }
      }
    } else if (name === 'google') {
      config.google = { clientId: requireSetting(string('clientId'), 'google.clientId'), clientSecret: requireSetting(string('clientSecret'), 'google.clientSecret') };
    } else if (name === 'memory') {
      const baseUrl = requireSetting(string('baseUrl'), 'memory.baseUrl');
      validateHttpUrl(baseUrl, 'memory.baseUrl');
      const timeoutMs = section.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 120000)) throw new Error('Butler config memory.timeoutMs must be an integer from 1 to 120000');
      config.memory = { baseUrl: baseUrl.replace(/\/$/, ''), bankId: requireSetting(string('bankId'), 'memory.bankId'), timeoutMs: timeoutMs as number | undefined };
    } else if (name === 'image') {
      const baseUrl = requireSetting(string('baseUrl'), 'image.baseUrl');
      validateHttpUrl(baseUrl, 'image.baseUrl');
      const timeoutMs = section.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300000)) throw new Error('Butler config image.timeoutMs must be an integer from 1 to 300000');
      const identityReference = string('identityReferencePath');
      const identityReferencePath = identityReference === undefined ? undefined : projectPath(identityReference);
      config.image = { baseUrl: baseUrl.replace(/\/$/, ''), apiKey: string('apiKey'), model: requireSetting(string('model'), 'image.model'), timeoutMs: timeoutMs as number | undefined, identityReferencePath };
    } else if (name === 'transcription') {
      config.transcription = { apiKey: requireSetting(string('apiKey'), 'transcription.apiKey') };
    } else if (name === 'schedule') {
      const timezone = string('timezone') ?? DEFAULT_SCHEDULE_TIMEZONE;
      validateTimezone(timezone, 'Butler config schedule.timezone');
      config.schedule = { timezone, model: string('model') };
    } else if (name === 'subagent') {
      for (const key of Object.keys(section)) if (key !== 'toolsEnabled' && key !== 'allowClaude') throw new Error(`Butler config subagent.${key} is not supported`);
      const { toolsEnabled, allowClaude } = section;
      if (toolsEnabled !== undefined && typeof toolsEnabled !== 'boolean') throw new Error('Butler config subagent.toolsEnabled must be boolean');
      if (allowClaude !== undefined && typeof allowClaude !== 'boolean') throw new Error('Butler config subagent.allowClaude must be boolean');
      config.subagent = { toolsEnabled: (toolsEnabled as boolean | undefined) ?? true, allowClaude: (allowClaude as boolean | undefined) ?? false };
    } else if (name === 'mail') {
      if (!Array.isArray(section.accounts)) throw new Error('Butler config mail.accounts must be an array');
      const accounts = section.accounts.map((account: unknown) => {
        if (!isRecord(account) || typeof account.email !== 'string' || !account.email.trim()) throw new Error('Butler config mail.accounts email must be a nonempty string');
        const delay = account.delaySeconds === undefined ? 0 : account.delaySeconds;
        if (!Number.isInteger(delay) || Number(delay) < 0 || Number(delay) > 3600) throw new Error('Butler config mail.accounts delaySeconds must be an integer from 0 to 3600');
        return { email: account.email.trim(), delaySeconds: delay as number };
      });
      if (new Set(accounts.map(account => account.email.toLowerCase())).size !== accounts.length) throw new Error('Butler config mail.accounts must contain unique emails');
      config.mail = { accounts };
    } else if (name === 'notifications') {
      const host = requireSetting(string('host'), 'notifications.host');
      const port = section.port;
      if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Butler config notifications.port must be an integer from 1 to 65535');
      const bearerToken = requireSetting(string('bearerToken'), 'notifications.bearerToken');
      config.notifications = { host, port: port as number, bearerToken };
    } else {
      const port = section.port;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Butler config ui.port must be an integer from 1 to 65535');
      const publicOrigin = requireSetting(string('publicOrigin'), 'ui.publicOrigin');
      const url = validateHttpUrl(publicOrigin, 'ui.publicOrigin');
      if (url.origin !== publicOrigin) throw new Error('Butler config ui.publicOrigin must be an origin without a path');
      const cookiePath = requireSetting(string('cookiePath'), 'ui.cookiePath');
      if (!/^\/[A-Za-z0-9/_-]*$/.test(cookiePath)) throw new Error('Butler config ui.cookiePath must be an absolute cookie path');
      config.ui = { port, publicOrigin, cookiePath };
    }
  }
  if ((config.notifications || config.mail?.accounts.length) && !config.discord?.notificationChannelId) throw new Error('Butler config discord.notificationChannelId is required when notifications or mail is configured');
  return config;
}

export function requireSetting<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`Butler config ${field} is required`);
  return value;
}

function validateHttpUrl(value: string, field: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`Butler config ${field} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`Butler config ${field} must be an HTTP(S) URL without credentials`);
  return url;
}


const coldPaths = [
  'discord.token', 'discord.ownerId', 'discord.notificationChannelId', 'ui', 'google', 'notifications', 'mail',
  'memory.enabled', 'memory.baseUrl', 'memory.bankId',
] as const;
function valueAt(config: ButlerConfig, path: string): unknown {
  if (path === 'memory.enabled') return Boolean(config.memory);
  return path === 'ui' || path === 'google' ? config[path] : path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, config);
}
function sameValue(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export class ConfigConflictError extends Error {
  readonly status = 409;
  constructor(message: string, readonly coldPaths?: readonly string[]) { super(message); this.name = 'ConfigConflictError'; }
}

function validateCandidate(current: ButlerConfig, candidate: ButlerConfig): void {
  const cold = coldPaths.filter(key => !sameValue(valueAt(current, key), valueAt(candidate, key)));
  if (cold.length) throw new ConfigConflictError(`Config changes require restart: ${cold.join(', ')}`, cold);
}

export function watchConfig(options: { prepareCandidate(config: ButlerConfig): () => void; log: LogMethods; initial: ButlerConfig }): { close(): void } {
  const path = CONFIG_PATH;
  let current = options.initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let closed = false;
  const applyCandidate = (candidate: ButlerConfig) => {
    validateCandidate(current, candidate);
    const apply = options.prepareCandidate(candidate);
    apply();
    current = candidate;
  };
  const reload = () => {
    timer = undefined;
    if (closed) return;
    try {
      const candidate = readConfig(path);
      if (sameValue(current, candidate)) return;
      applyCandidate(candidate);
      options.log.logInfo('Config reload applied');
    } catch (error) {
      if (error instanceof ConfigConflictError && error.coldPaths) options.log.logWarn('Config reload rejected; restart required', undefined, { coldPaths: error.coldPaths });
      else options.log.logWarn('Config reload rejected', error);
    }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void reload(); }, 250); };
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === basename(path)) schedule();
    });
    watcher.on('error', () => options.log.logError('Config watcher failed; service continues without further reloads'));
  } catch { options.log.logError('Config watcher failed; service continues without further reloads'); }
  return { close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; watcher?.close(); watcher = undefined; } };
}
