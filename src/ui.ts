import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GoogleAuthError, type GoogleAuth } from './google-auth.js';
import type { ChannelManagement, ChannelSettingsPatch } from './channel-settings.js';
import { logWarn } from './log.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../ui');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]] as const);

export function startUi(dbPath: string, port: number, options: { googleAuth?: GoogleAuth; publicOrigin?: string; cookiePath?: string; channelName?: (channelId: string) => Promise<string | undefined>; channelManagement?: ChannelManagement } = {}): Promise<{ server: Server; close: () => Promise<void> }> {
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
      if (pathname === '/api/channels' || pathname === '/api/models' || /^\/api\/channels\/[^/]+(?:\/tracking)?$/.test(pathname)) {
        const management = options.channelManagement;
        if (!management) { res.writeHead(503, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '頻道管理服務尚未啟用' })); return; }
        const respond = (status: number, value: unknown) => res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(value));
        const invalid = (message = '參數格式錯誤') => respond(400, { error: message });
        const sendMutationError = (error: unknown) => {
          if (error && typeof error === 'object' && ('status' in error) && ((error as { status?: unknown }).status === 400 || (error as { status?: unknown }).status === 409)) {
            const message = 'message' in error && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '操作無法完成';
            respond((error as { status: 400 | 409 }).status, { error: message });
          } else { logWarn('UI channel management request failed', error); respond(500, { error: '操作失敗' }); }
        };
        if (req.method === 'GET' && pathname === '/api/channels') { respond(200, { channels: await management.listChannels() }); return; }
        if (req.method === 'GET' && pathname === '/api/models') { respond(200, await management.models()); return; }
        if (pathname === '/api/channels' && req.method === 'POST') {
          if (req.headers.origin !== publicOrigin) { respond(403, { error: '禁止的來源' }); return; }
          if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { respond(415, { error: '需要 application/json' }); return; }
          try {
            let body: Record<string, unknown>;
            try { body = await readJsonBody(req); } catch (error) { if (error instanceof SyntaxError) { invalid(); return; } throw error; }
            if (Object.keys(body).length !== 1 || Object.keys(body).some(key => key !== 'channelId') || typeof body.channelId !== 'string' || !/^\d{17,20}$/.test(body.channelId)) { invalid(); return; }
            respond(200, { channel: await management.addChannel(body.channelId) });
          } catch (error) { if (error instanceof URIError) invalid(); else sendMutationError(error); }
          return;
        }
        const match = pathname.match(/^\/api\/channels\/([^/]+)(\/tracking)?$/);
        if (match && ['PATCH', 'DELETE'].includes(req.method ?? '')) {
          if (req.headers.origin !== publicOrigin) { respond(403, { error: '禁止的來源' }); return; }
          let id: string;
          try { id = decodeURIComponent(match[1]!); } catch { invalid(); return; }
          if (!/^\d{17,20}$/.test(id)) { invalid(); return; }
          try {
            let channel;
            if (req.method === 'DELETE') {
              if (!match[2]) { respond(404, { error: '找不到路由' }); return; }
              channel = await management.stopTracking(id);
            } else {
              if (match[2]) { respond(404, { error: '找不到路由' }); return; }
              if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { respond(415, { error: '需要 application/json' }); return; }
              let body: Record<string, unknown>;
              try { body = await readJsonBody(req); } catch (error) { if (error instanceof SyntaxError) { invalid(); return; } throw error; }
              const allowed = new Set(['tracked', 'botReply', 'hindsightWrite', 'replyMode', 'mode', 'model', 'effort', 'imageModel']);
              if (Object.keys(body).some(key => !allowed.has(key))) { invalid(); return; }
              const booleanKeys = ['tracked', 'botReply', 'hindsightWrite'];
              const enumValues: Record<string, string[]> = { replyMode: ['none', 'mention', 'all'], mode: ['queue', 'steer'], effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'] };
              for (const [key, value] of Object.entries(body)) {
                if (booleanKeys.includes(key) && value !== null && typeof value !== 'boolean') { invalid(); return; }
                                if (key in enumValues && value !== null && (typeof value !== 'string' || !enumValues[key]!.includes(value))) { invalid(); return; }
                if ((key === 'model' || key === 'imageModel') && value !== null && (typeof value !== 'string' || value.trim().length === 0)) { invalid(); return; }
              }
              channel = await management.updateChannel(id, body as ChannelSettingsPatch);
            }
            respond(200, { channel });
          } catch (error) { if (error instanceof URIError) invalid(); else sendMutationError(error); }
          return;
        }
        respond(405, { error: '方法不允許' }); return;
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
        const channelId = url.searchParams.get('channel_id');
        const scope = url.searchParams.get('scope');
        if (channelId !== null && (!/^\d{17,20}$/.test(channelId) || scope !== null)) throw new URIError('invalid session scope');
        if (scope !== null && scope !== 'history') throw new URIError('invalid session scope');
        const state = url.searchParams.get('state') ?? 'active';
        if (state !== 'active' && state !== 'archived') throw new URIError('invalid session state');
        const stateFilter = state === 'active'
          ? 'EXISTS (SELECT 1 FROM channel_state cs WHERE cs.session_id=s.id)'
          : 'NOT EXISTS (SELECT 1 FROM channel_state cs WHERE cs.session_id=s.id)';
        const filters = [stateFilter];
        const params: (string | number)[] = [];
        const latestChannel = '(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)';
        if (channelId !== null) { filters.push(`${latestChannel}=?`); params.push(channelId); }
        if (scope === 'history') {
          if (!options.channelManagement) { res.writeHead(503, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '頻道管理服務尚未啟用' })); return; }
          const authorized = (await options.channelManagement.listChannels()).filter(channel => channel.authorized).map(channel => channel.channelId);
          if (authorized.length) { filters.push(`(${latestChannel} IS NULL OR ${latestChannel} NOT IN (${authorized.map(() => '?').join(',')}))`); params.push(...authorized); }
        }
        const rows = db.prepare(`SELECT s.id,s.created_at,(SELECT substr(content,1,120) FROM messages m WHERE m.session_id=s.id ORDER BY rowid DESC LIMIT 1) latest_preview,
          COALESCE((SELECT MAX(COALESCE(ms.event_time,m.created_at)) FROM messages m LEFT JOIN message_sources ms ON ms.message_id=m.id WHERE m.session_id=s.id),s.created_at) last_active_at,
          (SELECT channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) channel_id,
          (SELECT source_type FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) source_type,
          (SELECT owner_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) owner_id,
          (SELECT NULLIF(bot_id,'') FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) bot_id,
          (SELECT cs.model FROM channel_state cs WHERE cs.channel_id=(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)) current_model,
          (SELECT CASE WHEN cs.model IS NULL THEN 1 ELSE 0 END FROM channel_state cs WHERE cs.channel_id=(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)) uses_default_model
          FROM sessions s WHERE ${filters.join(' AND ')} ORDER BY s.rowid DESC LIMIT 51 OFFSET ?`).all(...params, offset) as Record<string, unknown>[];
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
          ? 'SELECT m.id,m.session_id,m.role,m.content,m.created_at,s.author_id,s.author_name,s.event_time,(SELECT json_group_array(json_object(\'filename\',a.filename,\'mimeType\',a.mime_type,\'status\',a.status)) FROM message_input_attachments a WHERE a.message_id=m.id) attachments FROM messages m LEFT JOIN message_sources s ON s.message_id=m.id WHERE m.session_id=? ORDER BY m.rowid LIMIT 51 OFFSET ?'
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
