import { AsyncLocalStorage } from 'node:async_hooks';
import type { ButlerConfig } from './config.js';

let webhookUrl: string | undefined;
let mentionUserId: string | undefined;
let threadId: string | undefined;
let secrets: string[] = [];
const mentionSuppression = new AsyncLocalStorage<boolean>();
export function withoutLogMention<T>(callback: () => T): T { return mentionSuppression.run(true, callback); }
let queue: Promise<void> = Promise.resolve();
let queued = 0;
let lastSentAt = 0;
const deduplicationWindowMs = 5 * 60 * 1000;
const recentErrors = new Map<string, number>();
export type LogMethods = { logInfo: typeof logInfo; logWarn: typeof logWarn; logError: typeof logError };
export function configureLogging(config: ButlerConfig): void {
  const discord = config.discord;
  webhookUrl = discord?.errorWebhookUrl; mentionUserId = discord?.errorWebhookMentionUserId; threadId = discord?.errorWebhookThreadId;
  secrets = [discord?.token, config.llm?.apiKey, config.web?.apiKey, config.google?.clientSecret, config.image?.apiKey, discord?.errorWebhookUrl].filter((value): value is string => Boolean(value));
}
function redact(value: string): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result.replace(/https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/\d+\/[^\s"'<>]+/gi, '[REDACTED_WEBHOOK]').replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]').replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:token|key|secret)=?["']?[A-Za-z0-9._-]{12,})/gi, '[REDACTED]');
}
export function formatLogTimestamp(date = new Date()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date).replace(/, /, 'T') + `.${String(date.getMilliseconds()).padStart(3, '0')}+08:00`; }
function serializeError(value: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (value instanceof Error) { const cause = 'cause' in value ? serializeError(value.cause, depth + 1) : ''; return `${value.stack ?? `${value.name}: ${value.message}`}${cause ? `\nCaused by: ${cause}` : ''}`; }
  return typeof value === 'string' ? value : '';
}
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}
function formatIdentityError(value: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (value instanceof Error) { const cause = 'cause' in value ? formatIdentityError(value.cause, depth + 1) : ''; return `${value.name}:${value.message}${cause ? `\nCaused by: ${cause}` : ''}`; }
  return typeof value === 'string' ? value : '';
}
function truncate(value: string, limit: number): string {
  const suffix = '…（完整錯誤見 .data/service/butler.log）';
  if (value.length <= limit) return value;
  let end = limit - suffix.length;
  if (end > 0 && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF) end--;
  return `${value.slice(0, end)}${suffix}`;
}
function escapeControls(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function escapeEvent(value: string): string { return escapeControls(redact(value)).replace(/\|/g, '\\u007c'); }
function formatFieldValue(value: unknown): string {
  const serialized = JSON.stringify(redactValue(value));
  return escapeControls(serialized === undefined ? String(value) : serialized);
}
function output(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields?: Record<string, unknown>, error?: unknown): string {
  const timestamp = formatLogTimestamp().replace('T', ' ').slice(0, 19);
  const details = fields ? Object.keys(fields).sort().map(key => `${escapeControls(key)}=${formatFieldValue(fields[key])}`) : [];
  if (error !== undefined) details.push(`error=${formatFieldValue(redact(serializeError(error)))}`);
  const line = `${timestamp} | ${level} | ${escapeEvent(event)}${details.length ? ` | ${details.join(' ')}` : ''}`;
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.info)(line);
  return line;
}
export function logInfo(event: string, fields?: Record<string, unknown>): void { output('INFO', event, fields); }
export function logWarn(event: string, error?: unknown, fields?: Record<string, unknown>): void { output('WARN', event, fields, error); }
export function logError(event: string, error?: unknown, options: { notify?: boolean; mention?: boolean; deduplicationKey?: string; fields?: Record<string, unknown>; onNotifySettled?: (delivered: boolean) => void } = {}): void {
  const line = output('ERROR', event, options.fields, error);
  const settle = (delivered: boolean) => { try { options.onNotifySettled?.(delivered); } catch {} };
  if (!webhookUrl || options.notify === false) { settle(false); return; }
  const identity = `${options.deduplicationKey ?? event}\n${formatIdentityError(error)}`;
  const now = Date.now();
  for (const [key, at] of recentErrors) if (now - at >= deduplicationWindowMs) recentErrors.delete(key);
  const previous = recentErrors.get(identity); if (previous !== undefined && now - previous < deduplicationWindowMs) { settle(false); return; }
  if (queued >= 50) { logError('Error notifier queue full', undefined, { notify: false }); settle(false); return; }
  recentErrors.set(identity, now); queued++;
  const target = webhookUrl, notifyUserId = mentionSuppression.getStore() || options.mention === false ? undefined : mentionUserId, notifyThreadId = threadId;
  const body = { ...(notifyUserId ? { content: `<@${notifyUserId}>` } : {}), embeds: [{ title: 'Butler ERROR', description: truncate(line, 4096), color: 0xED4245, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] as string[], ...(notifyUserId ? { users: [notifyUserId] } : {}) } };
  queue = queue.then(async () => {
    try {
      const wait = Math.max(0, 500 - (Date.now() - lastSentAt)); if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      const destination = new URL(target); destination.searchParams.set('wait', 'true'); if (notifyThreadId) destination.searchParams.set('thread_id', notifyThreadId);
      let response: Response;
      try { response = await fetch(destination, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); }
      catch (cause) { logError('Error notifier network failure', cause, { notify: false }); settle(false); return; }
      if (response.status === 429) {
        let retryAfterMs: number | undefined;
        try { const rate = await response.json() as { retry_after?: unknown }; if (typeof rate.retry_after === 'number' && Number.isFinite(rate.retry_after) && rate.retry_after >= 0) retryAfterMs = rate.retry_after * 1000; } catch {}
        if (retryAfterMs === undefined || retryAfterMs > 30_000) { logError('Error notifier retry delay invalid', undefined, { notify: false }); settle(false); return; }
        if (retryAfterMs) await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        try { response = await fetch(destination, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); }
        catch (cause) { logError('Error notifier retry failed', cause, { notify: false }); settle(false); return; }
      }
      if (!response.ok) { const status = response.status; try { await response.body?.cancel(); } catch {} logError('Error notifier response failed', undefined, { notify: false, fields: { status } }); settle(false); return; }
      lastSentAt = Date.now(); try { await response.body?.cancel(); } catch {} settle(true);
    } catch (cause) { logError('Error notifier internal failure', cause, { notify: false }); settle(false); }
    finally { queued--; }
  });
}
export async function flushLogs(): Promise<void> { await queue; }
