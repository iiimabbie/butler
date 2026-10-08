import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ImageConfig } from './image-tools.js';

export type GoogleClientConfig = { clientId: string; clientSecret: string };
export type ButlerConfig = {
  discord?: { token?: string; ownerId?: string; channelIds?: string[]; errorWebhookUrl?: string; errorWebhookMentionUserId?: string; errorWebhookThreadId?: string };
  llm?: { baseUrl?: string; apiKey?: string; model?: string };
  web?: { provider: 'tavily'; baseUrl?: string; apiKey?: string };
  ui?: { port: number; publicOrigin: string; cookiePath: string };
  paths?: { database?: string; attachments?: string };
  google?: GoogleClientConfig;
  memory?: { baseUrl: string; bankId: string; timeoutMs?: number };
  image?: ImageConfig;
  schedule?: { timezone?: string };
};

const CONFIG_PATH = fileURLToPath(new URL('../config.yaml', import.meta.url));

export function readConfig(path = CONFIG_PATH): ButlerConfig {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8'), { logLevel: 'silent' }); }
  catch { throw new Error('Butler config could not be read as YAML'); }
  if (!isRecord(raw)) throw new Error('Butler config must be an object');
  const config: ButlerConfig = {};
  for (const name of ['discord', 'llm', 'web', 'ui', 'paths', 'google', 'memory', 'image', 'schedule'] as const) {
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
      if (channelIds !== undefined && (!Array.isArray(channelIds) || !channelIds.length || channelIds.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('Butler config discord.channelIds must be a nonempty string array');
      const errorWebhookUrl = string('errorWebhookUrl');
      if (errorWebhookUrl !== undefined && !/^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/\d+\/[^/?#]+$/.test(errorWebhookUrl)) throw new Error('Butler config discord.errorWebhookUrl must be a Discord webhook URL without query or fragment');
      const errorWebhookMentionUserId = string('errorWebhookMentionUserId');
      if (errorWebhookMentionUserId !== undefined && !/^\d+$/.test(errorWebhookMentionUserId)) throw new Error('Butler config discord.errorWebhookMentionUserId must be a numeric Discord user ID');
      const errorWebhookThreadId = string('errorWebhookThreadId');
      if (errorWebhookThreadId !== undefined && !/^\d+$/.test(errorWebhookThreadId)) throw new Error('Butler config discord.errorWebhookThreadId must be a numeric Discord thread ID');
      config.discord = { token: string('token'), ownerId: string('ownerId'), channelIds: channelIds as string[] | undefined, errorWebhookUrl, errorWebhookMentionUserId, errorWebhookThreadId };
    } else if (name === 'llm') {
      const baseUrl = string('baseUrl');
      if (baseUrl !== undefined) validateHttpUrl(baseUrl, 'llm.baseUrl');
      config.llm = { baseUrl, apiKey: string('apiKey'), model: string('model') };
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
    } else if (name === 'schedule') {
      config.schedule = { timezone: string('timezone') ?? 'Asia/Taipei' };
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

export function watchConfig(options: { onCandidate(config: ButlerConfig): void; log(message: string): void; path?: string; initial?: ButlerConfig; debounceMs?: number }): { close(): void } {
  const path = options.path ?? CONFIG_PATH;
  let current = options.initial ?? readConfig(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let closed = false;
  const reload = () => {
    timer = undefined;
    if (closed) return;
    let candidate: ButlerConfig;
    try { candidate = readConfig(path); }
    catch (error) { options.log(`Config reload rejected: ${error instanceof Error ? error.message : 'invalid config'}`); return; }
    const cold = coldPaths.filter(key => !sameValue(valueAt(current, key), valueAt(candidate, key)));
    if (cold.length) { options.log(`Config reload rejected; restart required for: ${cold.join(', ')}`); return; }
    if (sameValue(current, candidate)) return;
    try { options.onCandidate(candidate); current = candidate; options.log('Config reload applied'); }
    catch (error) { options.log(`Config reload rejected: ${error instanceof Error ? error.message : 'runtime validation failed'}`); }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void reload(); }, options.debounceMs ?? 250); };
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === basename(path)) schedule();
    });
    watcher.on('error', () => options.log('Config watcher failed; service continues without further reloads'));
  } catch { options.log('Config watcher failed; service continues without further reloads'); }
  return { close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; watcher?.close(); watcher = undefined; } };
}
