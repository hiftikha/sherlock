import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, registerSession } from '../session.mjs';
import { createHostSampler, hostPlatform } from './host.mjs';
import { which, sleep } from '../util.mjs';

export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [];
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge']) {
      const bin = app === 'Microsoft Edge' ? 'Microsoft Edge' : app;
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${bin}`);
      candidates.push(join(homedir(), `Applications/${app}.app/Contents/MacOS/${bin}`));
    }
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(join(base, 'Google/Chrome/Application/chrome.exe'));
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const p = which(name);
      if (p) candidates.push(p);
    }
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return findPlaywrightChrome();
}

function findPlaywrightChrome() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    join(homedir(), 'AppData/Local/ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const options = [
        join(root, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(root, d, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(root, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(root, d, 'chrome-linux64/chrome'),
        join(root, d, 'chrome-linux/chrome'),
        join(root, d, 'chrome-win/chrome.exe'),
      ];
      for (const o of options) if (existsSync(o)) return o;
    }
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Could not connect to Chrome at ${url}`)), { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      this.on(method, (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const COLLECT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, p.startTime]));
  const lcp = (window.__sherlockLcp || []).slice(-1)[0];
  const lts = window.__sherlockLongTasks || [];
  let loaf = [];
  try { loaf = performance.getEntriesByType('long-animation-frame'); } catch (e) {}
  const frames = loaf.length ? loaf : [];
  const scripts = [];
  for (const f of frames) for (const s of (f.scripts || [])) scripts.push({ source: (s.sourceURL || s.invoker || 'inline').slice(0, 160), invoker: (s.invoker || '').slice(0, 120), ms: Math.round(s.duration) });
  scripts.sort((a, b) => b.ms - a.ms);
  const res = performance.getEntriesByType('resource');
  const mem = performance.memory || {};
  return {
    ttfbMs: nav.responseStart || null,
    domContentLoadedMs: nav.domContentLoadedEventEnd || null,
    loadMs: nav.loadEventEnd || null,
    fcpMs: paints['first-contentful-paint'] ?? null,
    fpMs: paints['first-paint'] ?? null,
    lcpMs: lcp ? lcp.startTime : null,
    lcpElement: lcp && lcp.element ? (lcp.element.tagName + (lcp.element.id ? '#' + lcp.element.id : '')) : null,
    cls: (window.__sherlockCls || 0),
    longTasks: frames.length
      ? { source: 'long-animation-frame', count: frames.length, totalMs: Math.round(frames.reduce((a, f) => a + f.duration, 0)), blockingMs: Math.round(frames.reduce((a, f) => a + (f.blockingDuration || 0), 0)), longestMs: Math.round(frames.reduce((a, f) => Math.max(a, f.duration), 0)), scripts: scripts.slice(0, 5) }
      : { source: 'longtask', count: lts.length, totalMs: Math.round(lts.reduce((a, t) => a + t.duration, 0)), longestMs: Math.round(lts.reduce((a, t) => Math.max(a, t.duration), 0)) },
    transfer: { requests: res.length + 1, bytes: res.reduce((a, r) => a + (r.transferSize || 0), 0) + (nav.transferSize || 0) },
    slowest: res.sort((a, b) => b.duration - a.duration).slice(0, 5).map(r => ({ name: r.name.slice(0, 160), ms: Math.round(r.duration), bytes: r.transferSize || 0, type: r.initiatorType })),
    jsHeapUsedBytes: mem.usedJSHeapSize || null,
    wasm: res.filter(r => r.name.endsWith('.wasm')).map(r => ({ name: r.name.slice(0, 160), ms: Math.round(r.duration), bytes: r.transferSize || 0 })),
  };
})()`;

const OBSERVE = `
window.__sherlockLcp = [];
window.__sherlockLongTasks = [];
window.__sherlockCls = 0;
try { new PerformanceObserver(l => window.__sherlockLcp.push(...l.getEntries())).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
try { new PerformanceObserver(l => window.__sherlockLongTasks.push(...l.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true }); } catch (e) {}
try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__sherlockCls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
`;

export async function profileWeb(opts) {
  const chrome = opts.chromePath ?? findChrome();
  if (!chrome) throw new Error('No Chrome or Chromium found. Install Chrome, or set CHROME_PATH to a Chromium-based browser.');
  const url = opts.url;
  if (!/^https?:\/\//.test(url)) throw new Error(`Expected an http(s) URL, got "${url}".`);
  const session = registerSession(new Session({ kind: 'web', target: url, platform: hostPlatform(), meta: { browser: chrome.split('/').pop() } }));
  const profile = await mkdtemp(join(tmpdir(), 'sherlock-chrome-'));
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    opts.headless === false ? null : '--headless=new',
    process.platform === 'linux' && (process.env.CI || process.getuid?.() === 0) ? '--no-sandbox' : null,
    `--window-size=${opts.width ?? 1365},${opts.height ?? 900}`,
    'about:blank',
  ].filter(Boolean);
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.child = proc;
  let cdp;
  try {
    const port = await waitForDevtoolsPort(profile, proc, 20000);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome started without a page target.');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    session.setStatus('running');
    session.startSampling(createHostSampler(proc.pid, { includeChildren: true }), opts.intervalMs ?? 100);
    await cdp.send('Page.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    if (opts.cacheDisabled !== false) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
    if (opts.cpuThrottle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(opts.cpuThrottle) });

    const traceEvents = [];
    cdp.on('Tracing.dataCollected', (p) => traceEvents.push(...p.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });

    const t0 = session.elapsed();
    session.startup = { navigationStartMs: t0, readyMs: null, readySignal: null };
    session.mark('navigate', { source: 'sherlock' });
    const loaded = cdp.once('Page.loadEventFired', opts.timeoutMs ?? 30000);
    await cdp.send('Page.navigate', { url });
    await loaded;
    session.mark('load', { source: 'sherlock' });
    await sleep(opts.settleMs ?? 1500);
    const result = await cdp.send('Runtime.evaluate', { expression: COLLECT, returnByValue: true });
    const vitals = result.result?.value ?? {};
    const traced = cdp.once('Tracing.tracingComplete', 15000);
    await cdp.send('Tracing.end');
    await traced;
    const traceTasks = longTasksFromTrace(traceEvents);
    const metrics = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.metrics.map((x) => [x.name, x.value]));
    session.web = {
      url,
      vitals: {
        ttfbMs: vitals.ttfbMs,
        fcpMs: vitals.fcpMs,
        lcpMs: vitals.lcpMs,
        domContentLoadedMs: vitals.domContentLoadedMs,
        loadMs: vitals.loadMs,
        cls: vitals.cls,
        lcpElement: vitals.lcpElement,
      },
      longTasks: traceTasks ?? vitals.longTasks,
      transfer: vitals.transfer,
      slowest: vitals.slowest,
      wasm: vitals.wasm,
      runtime: {
        scriptMs: Math.round((m.ScriptDuration ?? 0) * 1000),
        layoutMs: Math.round((m.LayoutDuration ?? 0) * 1000),
        styleMs: Math.round((m.RecalcStyleDuration ?? 0) * 1000),
        taskMs: Math.round((m.TaskDuration ?? 0) * 1000),
        jsHeapUsedBytes: m.JSHeapUsedSize ?? vitals.jsHeapUsedBytes,
        domNodes: m.Nodes,
      },
    };
    const v = session.web.vitals;
    session.startup.readyMs = v.lcpMs ?? v.loadMs ?? null;
    session.startup.readySignal = v.lcpMs != null ? 'largest contentful paint' : 'load event';
    session.phases = [];
    const nav = t0;
    if (v.ttfbMs != null) session.phase('server → first byte', nav, nav + v.ttfbMs);
    if (v.fcpMs != null) session.phase('first byte → first paint', nav + (v.ttfbMs ?? 0), nav + v.fcpMs);
    if (v.lcpMs != null && v.fcpMs != null && v.lcpMs > v.fcpMs) session.phase('first paint → largest paint', nav + v.fcpMs, nav + v.lcpMs);
    if (v.loadMs != null) session.phase('load event', nav, nav + v.loadMs);
    if (opts.keepOpen) {
      session.cdp = cdp;
      session.refreshFindings();
      return session;
    }
    session.stop();
    return session;
  } catch (err) {
    session.error = err.message;
    session.setStatus('failed');
    session.stop();
    throw err;
  } finally {
    if (!opts.keepOpen) {
      cdp?.close();
      proc.kill('SIGTERM');
      setTimeout(() => rm(profile, { recursive: true, force: true }).catch(() => {}), 500);
    }
  }
}

export function longTasksFromTrace(events) {
  const main = new Set();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') main.add(`${e.pid}:${e.tid}`);
  }
  if (!main.size) return null;
  const tasks = events
    .filter((e) => e.ph === 'X' && e.name === 'RunTask' && main.has(`${e.pid}:${e.tid}`) && e.dur >= 50000)
    .map((e) => e.dur / 1000);
  return {
    source: 'trace',
    count: tasks.length,
    totalMs: Math.round(tasks.reduce((a, b) => a + b, 0)),
    blockingMs: Math.round(tasks.reduce((a, b) => a + Math.max(0, b - 50), 0)),
    longestMs: Math.round(tasks.reduce((a, b) => Math.max(a, b), 0)),
  };
}

async function waitForDevtoolsPort(profile, proc, timeoutMs) {
  const file = join(profile, 'DevToolsActivePort');
  const start = Date.now();
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode != null) throw new Error(`Chrome exited early: ${stderr.trim().split('\n').pop()}`);
    try {
      const text = await readFile(file, 'utf8');
      const port = Number(text.split('\n')[0]);
      if (port) return port;
    } catch {}
    await sleep(50);
  }
  throw new Error('Chrome did not open a DevTools port in time.');
}
