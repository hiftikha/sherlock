import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export async function startDashboard(source, { port = 0, open = false, host = '127.0.0.1' } = {}) {
  const live = typeof source.on === 'function';
  const clients = new Set();
  const snapshot = () => ({ ...(live ? source.toJSON() : source), live });
  const broadcast = (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  if (live) {
    for (const type of ['sample', 'mark', 'phase', 'findings', 'status', 'stacks', 'event']) {
      source.on(type, (data) => broadcast(type, data));
    }
    source.on('stopped', () => broadcast('session', snapshot()));
    source.on('note', (n) => broadcast('note', n));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: session\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mark') {
        if (!live) return json(res, { error: 'This report is not live.' }, 409);
        const body = await readBody(req);
        return json(res, source.mark(body.label || 'interaction', { source: 'dashboard' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/note') {
        if (!live) return json(res, { error: 'This report is not live.' }, 409);
        const body = await readBody(req);
        return json(res, source.note(body.title ?? '', body.body ?? ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (live) source.stop();
        return json(res, { ok: true });
      }
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[\w.-]+$/.test(name)) return notFound(res);
        const file = join(UI, name);
        const ext = name.slice(name.lastIndexOf('.'));
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(body);
      }
      notFound(res);
    } catch (err) {
      if (err.code === 'ENOENT') return notFound(res);
      json(res, { error: err.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = `http://${host}:${server.address().port}/`;
  if (open) openBrowser(address);
  return {
    url: address,
    close: () =>
      new Promise((resolve) => {
        for (const c of clients) c.end();
        server.close(resolve);
      }),
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

export async function writeReport(session, outDir) {
  await mkdir(outDir, { recursive: true });
  const data = typeof session.toJSON === 'function' ? session.toJSON() : session;
  const jsonPath = join(outDir, `sherlock-${data.id}.json`);
  await writeFile(jsonPath, JSON.stringify(data, null, 2));
  const [html, css, js] = await Promise.all(['index.html', 'app.css', 'app.js'].map((f) => readFile(join(UI, f), 'utf8')));
  const inlined = html
    .replace('<link rel="stylesheet" href="app.css">', `<style>${css}</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      `<script>window.__SHERLOCK__ = ${JSON.stringify({ ...data, live: false }).replace(/</g, '\\u003c')};</script><script type="module">${js}</script>`,
    );
  const htmlPath = join(outDir, `sherlock-${data.id}.html`);
  await writeFile(htmlPath, inlined);
  return { jsonPath, htmlPath };
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}
