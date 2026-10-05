import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export type GoogleClientConfig = { clientId: string; clientSecret: string };
export type ButlerConfig = {
  discord?: { token?: string; ownerId?: string; channelIds?: string[]; applicationId?: string; guildId?: string };
  llm?: { baseUrl?: string; apiKey?: string; model?: string };
  web?: { provider: 'tavily'; baseUrl?: string; apiKey?: string };
  ui?: { port: number; publicOrigin: string; cookiePath: string };
  paths?: { database?: string; attachments?: string };
  google?: GoogleClientConfig;
  memory?: { baseUrl: string; bankId: string; timeoutMs?: number; recallBudget?: string; reflectBudget?: string; maxTokens?: number };
};

const CONFIG_PATH = fileURLToPath(new URL('../config.yaml', import.meta.url));

export function readConfig(path = CONFIG_PATH): ButlerConfig {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8'), { logLevel: 'silent' }); }
  catch { throw new Error('Butler config could not be read as YAML'); }
  if (!isRecord(raw)) throw new Error('Butler config must be an object');
  const config: ButlerConfig = {};
  for (const name of ['discord', 'llm', 'web', 'ui', 'paths', 'google', 'memory'] as const) {
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
      config.discord = { token: string('token'), ownerId: string('ownerId'), channelIds: channelIds as string[] | undefined, applicationId: string('applicationId'), guildId: string('guildId') };
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
      const maxTokens = section.maxTokens;
      if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > 32000)) throw new Error('Butler config memory.maxTokens must be an integer from 1 to 32000');
      config.memory = { baseUrl: baseUrl.replace(/\/$/, ''), bankId: requireSetting(string('bankId'), 'memory.bankId'), timeoutMs: timeoutMs as number | undefined, recallBudget: string('recallBudget'), reflectBudget: string('reflectBudget'), maxTokens: maxTokens as number | undefined };
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
