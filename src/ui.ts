import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../ui');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]] as const);

export function startUi(dbPath: string, port: number): Promise<{ server: Server; close: () => Promise<void> }> {
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
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
      if (pathname === '/api/sessions') {
        const offset = numberParam(url.searchParams.get('offset'), 0);
        const rows = db.prepare(`SELECT s.id,s.created_at,(SELECT substr(content,1,120) FROM messages m WHERE m.session_id=s.id ORDER BY rowid DESC LIMIT 1) latest_preview,
          (SELECT channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) channel_id,
          (SELECT source_type FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) source_type,
          (SELECT owner_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) owner_id,
          (SELECT NULLIF(bot_id,'') FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1) bot_id,
          (SELECT cs.model FROM channel_state cs WHERE cs.channel_id=(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)) current_model,
          (SELECT CASE WHEN cs.model IS NULL THEN 1 ELSE 0 END FROM channel_state cs WHERE cs.channel_id=(SELECT ss.channel_id FROM session_sources ss WHERE ss.session_id=s.id ORDER BY rowid DESC LIMIT 1)) uses_default_model
          FROM sessions s ORDER BY s.rowid DESC LIMIT 51 OFFSET ?`).all(offset) as Record<string, unknown>[];
        const more = rows.length > 50;
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ items: rows.slice(0,50), offset, next_offset: more ? offset + 50 : null })); return;
      }
      const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(messages|tools)$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) { res.writeHead(404, headers).end(); return; }
        const offset = numberParam(url.searchParams.get('offset'), 0);
        const table = match[2] === 'messages' ? 'messages' : 'tool_calls';
        const sql = table === 'messages'
          ? 'SELECT id,session_id,role,content,created_at FROM messages WHERE session_id=? ORDER BY rowid LIMIT 51 OFFSET ?'
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

function numberParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new URIError('invalid pagination');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) throw new URIError('invalid pagination');
  return parsed;
}
