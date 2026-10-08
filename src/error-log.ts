import { AsyncLocalStorage } from 'node:async_hooks';
import type { ButlerConfig } from './config.js';

let webhookUrl: string | undefined;
let mentionUserId: string | undefined;
let threadId: string | undefined;
let secrets: string[] = [];
const mentionSuppression = new AsyncLocalStorage<boolean>();

export function withoutErrorLogMention<T>(callback: () => T): T {
  return mentionSuppression.run(true, callback);
}
let queue: Promise<void> = Promise.resolve();
let queued = 0;
let lastSentAt = 0;
const deduplicationWindowMs = 5 * 60 * 1000;
const recentErrors = new Map<string, number>();

export function configureErrorLogging(config: ButlerConfig): void {
  const discord = config.discord;
  webhookUrl = discord?.errorWebhookUrl;
  mentionUserId = discord?.errorWebhookMentionUserId;
  threadId = discord?.errorWebhookThreadId;
  secrets = [discord?.token, config.llm?.apiKey, config.web?.apiKey, config.google?.clientSecret, config.image?.apiKey, discord?.errorWebhookUrl].filter((value): value is string => Boolean(value));
}

function redact(value: string): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/\d+\/[^\s"'<>]+/gi, '[REDACTED_WEBHOOK]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:token|key|secret)=?["']?)[A-Za-z0-9._-]{12,}/gi, '[REDACTED]');
}

function truncate(value: string, limit: number): string {
  const suffix = '…（完整錯誤見 .data/service/butler.log）';
  if (value.length <= limit) return value;
  let end = limit - suffix.length;
  if (end > 0 && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF) end--;
  return `${value.slice(0, end)}${suffix}`;
}

export function logError(context: string, error?: unknown, options: { notify?: boolean; deduplicationKey?: string } = {}): void {
  const formatError = (value: unknown, depth = 0): string => {
    if (depth > 4) return '';
    if (value instanceof Error) {
      const stack = value.stack ?? `${value.name}: ${value.message}`;
      const cause = 'cause' in value ? formatError(value.cause, depth + 1) : '';
      return `${stack}${cause ? `\nCaused by: ${cause}` : ''}`;
    }
    return typeof value === 'string' ? value : '';
  };
  const formatIdentityError = (value: unknown, depth = 0): string => {
    if (depth > 4) return '';
    if (value instanceof Error) {
      const own = `${value.name}:${value.message}`;
      const cause = 'cause' in value ? formatIdentityError(value.cause, depth + 1) : '';
      return `${own}${cause ? `\nCaused by: ${cause}` : ''}`;
    }
    return typeof value === 'string' ? value : '';
  };
  const isHttp429 = (value: unknown, depth = 0): boolean => {
    if (depth > 4) return false;
    if (typeof value === 'string') return /\bHTTP\s+429\b/i.test(value) || /^429\b/.test(value);
    if (typeof value !== 'object' || value === null) return false;
    const record = value as { status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
    if (record.status === 429 || record.status === '429' || record.statusCode === 429 || record.statusCode === '429') return true;
    if (typeof record.message === 'string' && (/\bHTTP\s+429\b/i.test(record.message) || /^429\b/.test(record.message))) return true;
    return 'cause' in record && isHttp429(record.cause, depth + 1);
  };
  const detail = formatError(error);
  const timestamp = new Date().toISOString();
  const line = redact(`${timestamp} ERROR ${context}${detail ? `: ${detail}` : ''}`);
  console.error(line);
  if (!webhookUrl) return;
  // Explicit operational tool failures must not be hidden by a status in their message.
  if (options.notify === false || (options.notify !== true && (isHttp429(context) || isHttp429(error)))) return;
  const deduplicationKey = `${options.deduplicationKey ?? context}\n${formatIdentityError(error)}`;
  const now = Date.now();
  for (const [key, notifiedAt] of recentErrors) {
    if (now - notifiedAt >= deduplicationWindowMs) recentErrors.delete(key);
  }
  const previousNotification = recentErrors.get(deduplicationKey);
  if (previousNotification !== undefined && now - previousNotification < deduplicationWindowMs) return;
  if (queued >= 50) { console.error('Butler error notifier queue full; notification skipped'); return; }
  recentErrors.set(deduplicationKey, now);
  queued++;
  const target = webhookUrl;
  const suppressed = mentionSuppression.getStore() === true;
  const notifyUserId = !suppressed ? mentionUserId : undefined;
  const notifyThreadId = threadId;
  const content = notifyUserId ? `<@${notifyUserId}>` : undefined;
  const body = {
    ...(content ? { content } : {}),
    embeds: [{ title: 'Butler ERROR', description: truncate(line, 4096), color: 0xED4245, timestamp }],
    allowed_mentions: { parse: [] as string[], ...(notifyUserId ? { users: [notifyUserId] } : {}) },
  };
  queue = queue.then(async () => {
    try {
      const wait = Math.max(0, 500 - (Date.now() - lastSentAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      let response: Response;
      const signal = AbortSignal.timeout(5000);
      const destination = new URL(target);
      destination.searchParams.set('wait', 'true');
      if (notifyThreadId) destination.searchParams.set('thread_id', notifyThreadId);
      try { response = await fetch(destination, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }); }
      catch { console.error('Butler error notifier failed: network_or_timeout'); return; }
      if (response.status === 429) {
        let retryAfterMs: number | undefined;
        try { const rateLimit = await response.json() as { retry_after?: unknown }; if (typeof rateLimit.retry_after === 'number' && Number.isFinite(rateLimit.retry_after) && rateLimit.retry_after >= 0) retryAfterMs = rateLimit.retry_after * 1000; } catch {}
        if (retryAfterMs === undefined) { console.error('Butler error notifier failed: rate_limit_wait_invalid'); return; }
        if (retryAfterMs > 30_000) { console.error('Butler error notifier failed: rate_limit_wait_exceeded'); return; }
        if (retryAfterMs) await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        try { response = await fetch(destination, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); }
        catch { console.error('Butler error notifier failed: network_or_timeout'); return; }
      } else {
        try { await response.body?.cancel(); } catch {}
      }
      if (!response.ok) { const status = response.status; try { await response.body?.cancel(); } catch {} console.error(`Butler error notifier failed: HTTP ${status}`); return; }
      lastSentAt = Date.now();
      try { await response.body?.cancel(); } catch {}
    } catch { console.error('Butler error notifier failed: internal'); }
    finally { queued--; }
  });
}

export async function flushErrorLogs(): Promise<void> { await queue; }
