import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { NotificationConfig } from './config.js';
import { NotificationConflictError } from './store.js';
import { logError } from './log.js';

export interface NotificationPayload { id: string; source: string; title: string; body: string; occurred_at: string }
export const MAX_NOTIFICATION_BYTES = 65_536;

class IntakeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function validateNotification(value: unknown): NotificationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntakeError(400, 'Invalid notification');
  const input = value as Record<string, unknown>;
  const string = (key: string, empty = false) => {
    const text = input[key];
    if (typeof text !== 'string' || (!empty && !text.trim())) throw new IntakeError(400, `Invalid notification ${key}`);
    return text;
  };
  const id = string('id');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new IntakeError(400, 'Invalid notification id');
  const occurred_at = string('occurred_at');
  if (!Number.isFinite(Date.parse(occurred_at))) throw new IntakeError(400, 'Invalid notification occurred_at');
  return { id, source: string('source'), title: string('title'), body: string('body', true), occurred_at };
}

async function readNotification(req: IncomingMessage): Promise<NotificationPayload> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new IntakeError(415, 'Expected application/json');
  if (Number(req.headers['content-length'] ?? 0) > MAX_NOTIFICATION_BYTES) throw new IntakeError(413, 'Notification too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_NOTIFICATION_BYTES) throw new IntakeError(413, 'Notification too large');
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new IntakeError(400, 'Invalid JSON'); }
  return validateNotification(value);
}

// The callback commits receipt before returning. Delivery is deliberately outside the HTTP lifecycle.
export function startNotificationListener(config: NotificationConfig, accept: (payload: NotificationPayload) => { duplicate: boolean; status: string }): Promise<{ close(): Promise<void> }> {
  const expected = Buffer.from(config.bearerToken);
  let closing = false;
  const server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      if (status >= 400) { res.setHeader('Connection', 'close'); req.resume(); }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
    };
    try {
      if (closing) throw new IntakeError(503, 'Notification intake unavailable');
      if (req.url !== '/notifications') throw new IntakeError(404, 'Not found');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new IntakeError(405, 'Method not allowed'); }
      const supplied = Buffer.from(/^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new IntakeError(401, 'Unauthorized');
      }
      const result = accept(await readNotification(req));
      respond(202, { accepted: true, ...result });
    } catch (error) {
      const conflict = error instanceof NotificationConflictError;
      if (!(error instanceof IntakeError) && !conflict) logError('Notification intake failed', error);
      respond(error instanceof IntakeError ? error.status : conflict ? 409 : 503, { error: error instanceof IntakeError ? error.message : conflict ? 'Notification id already has different content' : 'Notification intake unavailable' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.setTimeout(10_000, socket => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve({ close: () => {
      closing = true;
      return new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    } }));
  });
}
