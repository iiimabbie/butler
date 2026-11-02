import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GoogleAuthError, type GoogleAuth } from './google-auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../ui');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]] as const);

export function startUi(port: number, options: { googleAuth?: GoogleAuth; publicOrigin?: string; cookiePath?: string } = {}): Promise<{ server: Server; close: () => Promise<void> }> {
  const publicOrigin = options.publicOrigin ?? `http://127.0.0.1:${port}`;
  const originUrl = new URL(publicOrigin);
  if (originUrl.origin !== publicOrigin || !['http:', 'https:'].includes(originUrl.protocol)) throw new Error('UI publicOrigin must be an explicit HTTP(S) origin');
  const cookiePath = options.cookiePath ?? '/';
  if (!/^\/[A-Za-z0-9/_-]*$/.test(cookiePath)) throw new Error('UI cookiePath must be an absolute URL path');
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
        const accounts = options.googleAuth ? await options.googleAuth.accounts().catch(() => []) : [];
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ status, accounts })); return;
      }
      if (['/api/google/start', '/api/google/complete', '/api/google/default', '/api/google/remove'].includes(pathname) && req.method === 'POST') {
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
          } else if (pathname === '/api/google/complete') {
            const browser = parseCookies(req.headers.cookie ?? '').butler_google_browser;
            const csrf = req.headers['x-csrf-token'];
            if (!browser || typeof csrf !== 'string') { res.writeHead(403, headers).end(); return; }
            if (typeof payload.url !== 'string') throw new URIError('invalid payload');
            await options.googleAuth.complete(payload.url, csrf, browser);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Set-Cookie': `butler_google_browser=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secure}` }).end(JSON.stringify({ status: 'connected' }));
          } else {
            if (typeof payload.account !== 'string' || !payload.account) throw new URIError('invalid payload');
            const result = pathname === '/api/google/default' ? (await options.googleAuth.setDefault(payload.account), {}) : await options.googleAuth.removeAccount(payload.account);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(result));
          }
        } catch (error) {
          res.writeHead(400, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof GoogleAuthError ? error.message : '操作失敗，請重新開始' }));
        }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
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
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, close: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())) }));
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
