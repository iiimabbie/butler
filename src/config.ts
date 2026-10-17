import { readFileSync, watch, type FSWatcher, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument } from 'yaml';
import type { ImageConfig } from './image-tools.js';
import type { AudioTranscriptionConfig } from './audio-transcription.js';
import type { LogMethods } from './log.js';

export type GoogleClientConfig = { clientId: string; clientSecret: string };
export type ButlerConfig = {
  discord?: { token?: string; ownerId?: string; channelIds?: string[]; alertChannelIds?: string[]; errorWebhookUrl?: string; errorWebhookMentionUserId?: string; errorWebhookThreadId?: string };
  llm?: { baseUrl?: string; apiKey?: string; model?: string; maxContextTokens?: number; modelContextTokens?: Record<string, number> };
  web?: { provider: 'tavily'; baseUrl?: string; apiKey?: string };
  hledger?: { enabled: boolean; journalPath: string; executablePath: string; allowedRequesterIds: string[]; allowedChannelIds: string[] };
  ui?: { port: number; publicOrigin: string; cookiePath: string };
  paths?: { database?: string; attachments?: string };
  google?: GoogleClientConfig;
  memory?: { baseUrl: string; bankId: string; timeoutMs?: number };
  image?: ImageConfig;
  transcription?: AudioTranscriptionConfig;
  schedule?: { timezone?: string };
  subagent?: { model: string; maxTurns?: number; timeoutMs?: number; toolsEnabled?: boolean };
};

const CONFIG_PATH = fileURLToPath(new URL('../config.yaml', import.meta.url));

export function readConfig(path = CONFIG_PATH): ButlerConfig {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8'), { logLevel: 'silent' }); }
  catch { throw new Error('Butler config could not be read as YAML'); }
  return validateConfig(raw);
}

function validateConfig(raw: unknown): ButlerConfig {
  if (!isRecord(raw)) throw new Error('Butler config must be an object');
  const config: ButlerConfig = {};
  for (const name of ['discord', 'llm', 'web', 'hledger', 'ui', 'paths', 'google', 'memory', 'image', 'transcription', 'schedule', 'subagent'] as const) {
    if (raw[name] === undefined) continue;
    if (!isRecord(raw[name])) throw new Error(`Butler config ${name} must be an object`);
    const section = raw[name];
    const string = (field: string): string | undefined => {
      const value = section[field];
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Butler config ${name}.${field} must be a nonempty string`);
      return value;
    };
    if (name === 'discord') {
      const channelIds = section.channelIds;
      if (channelIds !== undefined && (!Array.isArray(channelIds) || !channelIds.length || channelIds.some(id => typeof id !== 'string' || !/^\d{17,20}$/.test(id)))) throw new Error('Butler config discord.channelIds must be a nonempty string array');
      const alertChannelIds = section.alertChannelIds;
      if (alertChannelIds !== undefined && (!Array.isArray(alertChannelIds) || alertChannelIds.some(id => typeof id !== 'string' || !/^\d{17,20}$/.test(id)) || new Set(alertChannelIds).size !== alertChannelIds.length)) throw new Error('Butler config discord.alertChannelIds must be a unique string array of Discord channel IDs');
      const errorWebhookUrl = string('errorWebhookUrl');
      if (errorWebhookUrl !== undefined && !/^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/\d+\/[^/?#]+$/.test(errorWebhookUrl)) throw new Error('Butler config discord.errorWebhookUrl must be a Discord webhook URL without query or fragment');
      const errorWebhookMentionUserId = string('errorWebhookMentionUserId');
      if (errorWebhookMentionUserId !== undefined && !/^\d+$/.test(errorWebhookMentionUserId)) throw new Error('Butler config discord.errorWebhookMentionUserId must be a numeric Discord user ID');
      const errorWebhookThreadId = string('errorWebhookThreadId');
      if (errorWebhookThreadId !== undefined && !/^\d+$/.test(errorWebhookThreadId)) throw new Error('Butler config discord.errorWebhookThreadId must be a numeric Discord thread ID');
      config.discord = { token: string('token'), ownerId: string('ownerId'), channelIds: channelIds as string[] | undefined, alertChannelIds: (alertChannelIds as string[] | undefined) ?? [], errorWebhookUrl, errorWebhookMentionUserId, errorWebhookThreadId };
    } else if (name === 'llm') {
      const baseUrl = string('baseUrl');
      if (baseUrl !== undefined) validateHttpUrl(baseUrl, 'llm.baseUrl');
      const maxContextTokens = section.maxContextTokens;
      if (maxContextTokens !== undefined && (!Number.isSafeInteger(maxContextTokens) || (maxContextTokens as number) <= 0)) throw new Error('Butler config llm.maxContextTokens must be a positive integer');
      const modelContextTokens = section.modelContextTokens;
      if (modelContextTokens !== undefined && (!isRecord(modelContextTokens) || Object.entries(modelContextTokens).some(([model, limit]) => !model.trim() || !Number.isSafeInteger(limit) || (limit as number) <= 0))) throw new Error('Butler config llm.modelContextTokens must map model IDs to positive integers');
      config.llm = { baseUrl, apiKey: string('apiKey'), model: string('model'), maxContextTokens: (maxContextTokens as number | undefined) ?? 150000, modelContextTokens: (modelContextTokens as Record<string, number> | undefined) ?? {} };
    } else if (name === 'hledger') {
      const enabled = section.enabled;
      if (typeof enabled !== 'boolean') throw new Error('Butler config hledger.enabled must be boolean');
      const journalPath = requireSetting(string('journalPath'), 'hledger.journalPath');
      const executablePath = requireSetting(string('executablePath'), 'hledger.executablePath');
      const allowedRequesterIds = section.allowedRequesterIds;
      const allowedChannelIds = section.allowedChannelIds;
      const validSnowflakeList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && /^[0-9]{17,20}$/.test(id)) && new Set(value).size === value.length;
      if (enabled && !validSnowflakeList(allowedRequesterIds)) throw new Error('Butler config hledger.allowedRequesterIds must be a nonempty unique string array of Discord IDs when enabled');
      if (enabled && !validSnowflakeList(allowedChannelIds)) throw new Error('Butler config hledger.allowedChannelIds must be a nonempty unique string array of Discord IDs when enabled');
      if (!enabled && allowedRequesterIds !== undefined && !validSnowflakeList(allowedRequesterIds)) throw new Error('Butler config hledger.allowedRequesterIds must be a nonempty unique string array of Discord IDs');
      if (!enabled && allowedChannelIds !== undefined && !validSnowflakeList(allowedChannelIds)) throw new Error('Butler config hledger.allowedChannelIds must be a nonempty unique string array of Discord IDs');
      const projectRoot = fileURLToPath(new URL('../', import.meta.url));
      if (!isAbsolute(journalPath) || resolve(journalPath) !== resolve(projectRoot, '.data/finance/main.journal')) throw new Error('Butler config hledger.journalPath must be the private .data/finance/main.journal');
      if (!isAbsolute(executablePath)) throw new Error('Butler config hledger.executablePath must be absolute');
      config.hledger = { enabled, journalPath, executablePath, allowedRequesterIds: (allowedRequesterIds as string[] | undefined) ?? [], allowedChannelIds: (allowedChannelIds as string[] | undefined) ?? [] };
    } else if (name === 'web') {
      if (section.provider !== 'tavily') throw new Error('Butler config web.provider must be tavily');
      const baseUrl = string('baseUrl');
      if (baseUrl !== undefined) validateHttpUrl(baseUrl, 'web.baseUrl');
      config.web = { provider: 'tavily', baseUrl, apiKey: string('apiKey') };
    } else if (name === 'paths') {
      const database = string('database');
      const attachments = string('attachments');
      for (const [field, value] of Object.entries({ database, attachments })) {
        if (value !== undefined && !isAbsolute(value)) throw new Error(`Butler config paths.${field} must be an absolute path`);
      }
      config.paths = { database, attachments };
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
      if (section.protocol !== 'images') throw new Error('Butler config image.protocol must be images');
      const timeoutMs = section.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300000)) throw new Error('Butler config image.timeoutMs must be an integer from 1 to 300000');
      const identityReferencePath = string('identityReferencePath');
      if (identityReferencePath !== undefined && !isAbsolute(identityReferencePath)) throw new Error('Butler config image.identityReferencePath must be an absolute path');
      config.image = { baseUrl: baseUrl.replace(/\/$/, ''), apiKey: string('apiKey'), model: requireSetting(string('model'), 'image.model'), protocol: 'images', timeoutMs: timeoutMs as number | undefined, identityReferencePath };
    } else if (name === 'transcription') {
      if (section.provider !== 'groq') throw new Error('Butler config transcription.provider must be groq');
      config.transcription = { provider: 'groq', apiKey: requireSetting(string('apiKey'), 'transcription.apiKey') };
    } else if (name === 'schedule') {
      config.schedule = { timezone: string('timezone') ?? 'Asia/Taipei' };
    } else if (name === 'subagent') {
      const model = requireSetting(string('model'), 'subagent.model');
      const maxTurns = section.maxTurns;
      if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || (maxTurns as number) < 1 || (maxTurns as number) > 100)) throw new Error('Butler config subagent.maxTurns must be an integer from 1 to 100');
      const timeoutMs = section.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300000)) throw new Error('Butler config subagent.timeoutMs must be an integer from 1 to 300000');
      const toolsEnabled = section.toolsEnabled;
      if (toolsEnabled !== undefined && typeof toolsEnabled !== 'boolean') throw new Error('Butler config subagent.toolsEnabled must be boolean');
      config.subagent = { model, maxTurns: (maxTurns as number | undefined) ?? 30, timeoutMs: (timeoutMs as number | undefined) ?? 120000, toolsEnabled: (toolsEnabled as boolean | undefined) ?? true };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


const coldPaths = [
  'discord.token', 'discord.ownerId', 'paths', 'ui', 'google',
  'memory.enabled', 'memory.baseUrl', 'memory.bankId',
] as const;
function valueAt(config: ButlerConfig, path: string): unknown {
  if (path === 'memory.enabled') return Boolean(config.memory);
  return path === 'paths' || path === 'ui' || path === 'google' ? config[path] : path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, config);
}
function sameValue(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export class ConfigConflictError extends Error {
  readonly status = 409;
  constructor(message: string, readonly coldPaths?: readonly string[]) { super(message); this.name = 'ConfigConflictError'; }
}

class ConfigInputError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'ConfigInputError'; }
}

function validateCandidate(current: ButlerConfig, candidate: ButlerConfig): void {
  const cold = coldPaths.filter(key => !sameValue(valueAt(current, key), valueAt(candidate, key)));
  if (cold.length) throw new ConfigConflictError(`Config changes require restart: ${cold.join(', ')}`, cold);
}

function addChannelToFile(path: string, channelId: string): { candidate: ButlerConfig; original: Buffer } {
  if (!/^\d{17,20}$/.test(channelId)) throw new ConfigInputError('Discord channel ID must be a snowflake');
  const original = readFileSync(path);
  const document = parseDocument(original.toString('utf8'), { logLevel: 'silent' });
  if (document.errors.length) throw new Error('Butler config could not be read as YAML');
  const raw = document.toJS() as unknown;
  if (!isRecord(raw)) throw new Error('Butler config must be an object');
  const discord: Record<string, unknown> = isRecord(raw.discord) ? raw.discord : {};
  (raw as Record<string, unknown>).discord = discord;
  const ids = discord.channelIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^\d{17,20}$/.test(id)))) throw new Error('Butler config discord.channelIds must contain snowflakes');
  const channelIds = (ids ?? []) as string[];
  if (channelIds.includes(channelId)) throw new ConfigConflictError('Discord channel is already allowed');
  document.setIn(['discord', 'channelIds'], [...channelIds, channelId]);
  return { candidate: validateConfig(document.toJS()), original };
}

export function watchConfig(options: { onCandidate(config: ButlerConfig): void; prepareCandidate?(config: ButlerConfig): () => void; log: LogMethods; path?: string; initial?: ButlerConfig; debounceMs?: number }): { close(): void; addChannel(channelId: string): void } {
  const path = options.path ?? CONFIG_PATH;
  let current = options.initial ?? readConfig(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let closed = false;
  const applyCandidate = (candidate: ButlerConfig) => {
    validateCandidate(current, candidate);
    const apply = options.prepareCandidate?.(candidate);
    if (apply) apply(); else options.onCandidate(candidate);
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
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void reload(); }, options.debounceMs ?? 250); };
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === basename(path)) schedule();
    });
    watcher.on('error', () => options.log.logError('Config watcher failed; service continues without further reloads'));
  } catch { options.log.logError('Config watcher failed; service continues without further reloads'); }
  return {
    close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; watcher?.close(); watcher = undefined; },
    addChannel(channelId: string) {
      if (closed) throw new Error('Config watcher is closed');
      const { candidate, original } = addChannelToFile(path, channelId);
      validateCandidate(current, candidate);
      const apply = options.prepareCandidate?.(candidate);
      const currentBytes = readFileSync(path);
      if (!currentBytes.equals(original)) throw new ConfigConflictError('Config file changed while adding channel');
      const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
      const mode = statSync(path).mode & 0o777;
      try {
        writeFileSync(temp, (() => { const doc = parseDocument(original.toString('utf8'), { logLevel: 'silent' }); doc.setIn(['discord', 'channelIds'], candidate.discord?.channelIds); return doc.toString(); })(), { mode, flag: 'wx' });
        if (!readFileSync(path).equals(original)) throw new ConfigConflictError('Config file changed while adding channel');
        renameSync(temp, path);
      } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
      if (apply) apply(); else options.onCandidate(candidate);
      current = candidate;
    },
  };
}
