import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from '../src/platform/web.mjs';
import { sleep } from '../src/util.mjs';

const [url, out, waitMs = '4000', width = '1440', height = '900'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/screenshot.mjs <url> <out.webp|png> [waitMs] [width] [height]');
  process.exit(1);
}
const chrome = findChrome();
const profile = await mkdtemp(join(tmpdir(), 'sherlock-shot-'));
const proc = spawn(chrome, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--hide-scrollbars', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
let port;
for (let i = 0; i < 200 && !port; i++) {
  try {
    port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  } catch {
    await sleep(50);
  }
}
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) pending.get(m.id)(m.result);
});
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Page.navigate', { url });
await sleep(Number(waitMs));
const format = out.endsWith('.png') ? 'png' : 'webp';
const shot = await send('Page.captureScreenshot', { format, quality: format === 'webp' ? 88 : undefined });
await writeFile(out, Buffer.from(shot.data, 'base64'));
ws.close();
proc.kill();
setTimeout(() => rm(profile, { recursive: true, force: true }), 300);
console.log(out);
