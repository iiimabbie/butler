import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GoogleAuthError, type GoogleAuth } from './google-auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../ui');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]] as const);

export function startUi(dbPath: string, port: number, options: { googleAuth?: GoogleAuth; publicOrigin?: string; cookiePath?: string; channelName?: (channelId: string) => Promise<string | undefined> } = {}): Promise<{ server: Server; close: () => Promise<void> }> {
  const publicOrigin = options.publicOrigin ?? `http://127.0.0.1:${port}`;
  const originUrl = new URL(publicOrigin);
  if (originUrl.origin !== publicOrigin || !['http:', 'https:'].includes(originUrl.protocol)) throw new Error('UI publicOrigin must be an explicit HTTP(S) origin');
  const cookiePath = options.cookiePath ?? '/';
  if (!/^\/[A-Za-z0-9/_-]*$/.test(cookiePath)) throw new Error('UI cookiePath must be an absolute URL path');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const server = createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" };
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, headers).end();
      return;
    }
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (pathname === '/api/google/status' && req.method === 'GET') {
        const status = options.googleAuth ? await options.googleAuth.status() : 'not_configured';
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ status })); return;
      }
      if (['/api/google/start', '/api/google/complete'].includes(pathname) && req.method === 'POST') {
        if (!options.googleAuth || req.headers.origin !== publicOrigin) { res.writeHead(403, headers).end(); return; }
        if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { res.writeHead(415, headers).end(); return; }
        const secure = originUrl.protocol === 'https:' ? '; Secure' : '';
        try {
          const payload = await readJsonBody(req);
          if (pathname === '/api/google/start') {
            const previous = parseCookies(req.headers.cookie ?? '').butler_google_browser;
            const browser = previous && /^[A-Za-z0-9_-]{32}$/.test(previous) ? previous : randomBytes(24).toString('base64url');
            const auth = await options.googleAuth.begin(browser);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Set-Cookie': `butler_google_browser=${browser}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=300${secure}` }).end(JSON.stringify(auth));
          } else {
            const browser = parseCookies(req.headers.cookie ?? '').butler_google_browser;
            const csrf = req.headers['x-csrf-token'];
            if (!browser || typeof csrf !== 'string') { res.writeHead(403, headers).end(); return; }
            if (typeof payload.url !== 'string') throw new URIError('invalid payload');
            await options.googleAuth.complete(payload.url, csrf, browser);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Set-Cookie': `butler_google_browser=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secure}` }).end(JSON.stringify({ status: 'connected' }));
          }
        } catch (error) {
          res.writeHead(400, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof GoogleAuthError ? error.message : '授權失敗，請重新開始' }));
        }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
      if (pathname === '/api/sessions') {
        const offset = numberParam(url.searchParams.get('offset'), 0);
        const state = url.searchParams.get('state') ?? 'active';
        if (state !== 'active' && state !== 'archived') throw new URIError('invalid session state');
        const stateFilter = state === 'active'
          ? 'EXISTS (SELECT 1 FROM channel_state cs WHERE cs.session_id=s.id)'
          : 'NOT EXISTS (SELECT 1 FROM channel_state cs WHERE cs.session_id=s.id)';
        const rows = db.prepare(`SELECT s.id,s.created_at,(SELECT substr(content,1,120) FROM messages m WHERE m.session_id=s.id ORDER BY rowid DESC LIMIT 1) latest_preview,
          COALESCE((SELECT MAX(COALESCE(ms.event_time,m.created_at)) FROM messages m LEFT JOIN message_sources ms ON ms.message_id=m.id WHERE m.session_id=s.id),s.created_at) last_active_at,
          (SELECT channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) channel_id,
          (SELECT source_type FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) source_type,
          (SELECT owner_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) owner_id,
          (SELECT NULLIF(bot_id,'') FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) bot_id,
          (SELECT cs.model FROM channel_state cs WHERE cs.channel_id=(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)) current_model,
          (SELECT CASE WHEN cs.model IS NULL THEN 1 ELSE 0 END FROM channel_state cs WHERE cs.channel_id=(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)) uses_default_model
          FROM sessions s WHERE ${stateFilter} ORDER BY s.rowid DESC LIMIT 51 OFFSET ?`).all(offset) as Record<string, unknown>[];
        const more = rows.length > 50;
        const items = rows.slice(0, 50);
        const channelIds = [...new Set(items.map(row => row.channel_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
        const names = await Promise.all(channelIds.map(async id => [id, await options.channelName?.(id).catch(() => undefined)] as const));
        const channelNames = new Map(names);
        for (const row of items) row.channel_name = typeof row.channel_id === 'string' ? channelNames.get(row.channel_id) ?? null : null;
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ items, offset, next_offset: more ? offset + 50 : null })); return;
      }
      const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(messages|tools)$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) { res.writeHead(404, headers).end(); return; }
        const offset = numberParam(url.searchParams.get('offset'), 0);
        const table = match[2] === 'messages' ? 'messages' : 'tool_calls';
        const sql = table === 'messages'
          ? 'SELECT m.id,m.session_id,m.role,m.content,m.created_at,s.author_id,s.is_bot,s.event_time,(SELECT json_group_array(json_object(\'filename\',a.filename,\'mimeType\',a.mime_type,\'size\',a.size,\'status\',a.status)) FROM message_input_attachments a WHERE a.message_id=m.id) attachments FROM messages m LEFT JOIN message_sources s ON s.message_id=m.id WHERE m.session_id=? ORDER BY m.rowid LIMIT 51 OFFSET ?'
          : `SELECT t.id,t.session_id,t.name,t.arguments,t.status,t.result,t.created_at,t.finished_at,d.status AS delivery_status,d.updated_at AS delivery_updated_at FROM tool_calls t LEFT JOIN attachment_deliveries d ON d.tool_call_id=t.id WHERE t.session_id=? ORDER BY t.rowid LIMIT 51 OFFSET ?`;
        const rows = db.prepare(sql).all(id, offset) as Record<string, unknown>[];
        const more = rows.length > 50;
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ items: rows.slice(0,50), offset, next_offset: more ? offset + 50 : null })); return;
      }
      if (pathname === '/api/latest-request') {
        const value = db.prepare('SELECT session_id,attempted_at,body_json FROM latest_cpa_request WHERE id=1').get() ?? null;
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(value)); return;
      }
      const asset = assets.get(pathname as '/');
      if (!asset) { res.writeHead(404, headers).end(); return; }
      const body = await readFile(join(root, asset[0]));
      res.writeHead(200, { ...headers, 'Content-Type': asset[1] });
      if (req.method === 'HEAD') res.end(); else res.end(body);
    } catch (error) {
      if (!res.headersSent) {
        const status = error instanceof URIError ? 400 : 500;
        res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: status === 400 ? '參數格式錯誤' : '讀取失敗' }));
      } else res.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', error => { db.close(); reject(error); });
    server.listen(port, '127.0.0.1', () => resolve({ server, close: () => new Promise<void>((done, fail) => server.close(error => { db.close(); error ? fail(error) : done(); })) }));
  });
}

function parseCookies(header: string): Record<string,string> {
  const result: Record<string,string> = {};
  for (const item of header.split(';')) { const i = item.indexOf('='); if (i > 0) result[item.slice(0,i).trim()] = item.slice(i+1).trim(); }
  return result;
}
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string,unknown>> {
  const chunks: Buffer[]=[]; let size=0;
  for await (const part of req) { const chunk=Buffer.isBuffer(part)?part:Buffer.from(part); size+=chunk.length; if(size>16_384) throw new URIError('payload too large'); chunks.push(chunk); }
  const value: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new URIError('invalid payload');
  return value as Record<string,unknown>;
}

function numberParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new URIError('invalid pagination');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) throw new URIError('invalid pagination');
  return parsed;
}
