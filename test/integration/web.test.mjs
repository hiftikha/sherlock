import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileWeb, findChrome, interactWeb } from '../../src/platform/web.mjs';
import { startInteractionServer } from '../fixtures/apps/interaction-page.mjs';
import { callTool } from '../../src/tools.mjs';
import { Session, registerSession } from '../../src/session.mjs';

const chrome = findChrome();

test('web: page startup vitals, long tasks, wasm and requests in headless Chrome', { skip: !chrome && 'needs Chrome or Chromium (set CHROME_PATH)', timeout: 90000 }, async () => {
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>t</title><h1 id="hero" style="font-size:64px">Sherlock fixture</h1>
<script>const e=Date.now()+250;while(Date.now()<e){}</script>
<script>WebAssembly.instantiateStreaming(fetch('/m.wasm'))</script>
<img src="/slow.svg" width="800" height="400">`);
    } else if (req.url === '/m.wasm') {
      res.setHeader('content-type', 'application/wasm');
      res.end(wasm);
    } else {
      setTimeout(() => {
        res.setHeader('content-type', 'image/svg+xml');
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#ffb224"/></svg>');
      }, 300);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const session = await profileWeb({ url, settleMs: 1200 });
    const j = session.toJSON();
    assert.equal(j.kind, 'web');
    assert.ok(j.web.vitals.ttfbMs > 0);
    assert.ok(j.web.vitals.loadMs > 0);
    if (j.web.vitals.fcpMs != null && j.web.vitals.lcpMs != null) assert.ok(j.web.vitals.lcpMs >= j.web.vitals.fcpMs);
    assert.ok(j.web.longTasks.totalMs >= 200, `long tasks ${j.web.longTasks.totalMs}`);
    assert.ok(j.web.transfer.requests >= 3);
    assert.ok(j.web.wasm.length === 1, 'the .wasm request is reported');
    assert.ok(j.web.slowest.some((r) => r.name.endsWith('/slow.svg') && r.ms >= 250));
    assert.ok(j.web.runtime.scriptMs >= 200);
    assert.ok(j.samples.length > 0, 'browser process tree sampled');
    assert.ok(j.findings.some((f) => f.id === 'web-long-tasks'));
    assert.ok(j.phases.length >= 1);
  } finally {
    server.close();
  }
});

test('web: rejects a non-http URL', async () => {
  await assert.rejects(profileWeb({ url: 'file:///etc/passwd', chromePath: process.execPath }), /http\(s\) URL/);
});

// When an attribution assertion fails, keep the raw trace so CI can upload it.
async function keepTrace(name, events, err) {
  const dir = process.env.SHERLOCK_TRACE_DIR;
  if (dir && events) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.json`), JSON.stringify(events));
  }
  throw err;
}

test('web: closed-loop breakdown of a click, a key press and a done condition', { skip: !chrome && 'needs Chrome or Chromium (set CHROME_PATH)', timeout: 120000 }, async () => {
  const server = await startInteractionServer();
  const session = await profileWeb({ url: server.url, keepOpen: true, settleMs: 300 });
  let raw;
  try {
    const click = await interactWeb(session, { selector: '#open', label: 'open list', onTrace: (e) => (raw = e) });
    const why = JSON.stringify({ totals: click.totals, notes: click.notes, reason: click.reason });
    try {
      assert.equal(click.available, true, why);
      assert.equal(click.inputSource, 'event timing', why);
      // The request takes ~300 ms. On slow CI machines the main thread can be
      // blocked (in untraced tasks) for part of that wait, which is then
      // reported as other main-thread work rather than network.
      assert.ok(['network', 'other'].includes(click.slowest.key), why);
      assert.ok(click.requests.find((r) => r.url.endsWith('/api/items')).ms >= 250, why);
      assert.ok(click.totals.network + (click.totals.other ?? 0) >= 250, why);
      assert.ok(click.totals.handlers >= 100, why);
      assert.ok(click.totals.script >= 30, why);
      assert.ok(click.totals.render > 0, why);
      assert.ok(click.totalMs >= 450, why);
      assert.equal(click.frameShown, true, why);
      assert.ok(click.requests.some((r) => r.url.endsWith('/api/items') && r.status === 200));
    } catch (err) {
      await keepTrace('click', raw, err);
    }
    assert.equal(session.marks.at(-1).label, 'open list');

    // The profiler adds overhead, so this run only checks that it found the hot function.
    await session.cdp.send('Runtime.evaluate', { expression: `document.getElementById('done').remove()` });
    const profiled = await interactWeb(session, { selector: '#open', label: 'open list (profiled)', stacks: true });
    assert.equal(profiled.available, true, profiled.reason);
    assert.ok(profiled.stacks.available, profiled.stacks.reason);
    assert.ok(profiled.stacks.hot.some((h) => h.symbol === 'burn'), JSON.stringify(profiled.stacks.hot.slice(0, 5)));

    const key = await interactWeb(session, { selector: '#q', key: 'a', label: 'type' });
    assert.equal(key.available, true, key.reason);
    assert.ok(key.totals.handlers >= 50, JSON.stringify(key.totals));

    await session.cdp.send('Runtime.evaluate', { expression: `document.getElementById('done').remove()` });
    const done = await interactWeb(session, { selector: '#open', label: 'open list', doneSelector: '#done' });
    assert.equal(done.endSignal, 'first frame after the done condition', JSON.stringify(done.notes));
    assert.ok(done.requests.some((r) => r.url.endsWith('/api/items') && r.ms >= 250), JSON.stringify(done.requests));

    await assert.rejects(interactWeb(session, { selector: '#nope', label: 'x' }), /No element matches/);
    await assert.rejects(interactWeb(session, { selector: '#open', label: 'x', doneSelector: '#done' }), /already matches/);

    const j = session.toJSON();
    assert.equal(j.interactions.length, 4);
    const f = j.findings.find((x) => x.id === 'interaction-slowest-segment' && x.label === 'open list');
    assert.match(f.title, /^Slowest segment of "open list" is .+: (\d+ ms|\d+\.\d\d s)$/);
    assert.ok(j.findings.some((x) => x.id === 'interaction-slowest-segment' && x.label === 'type'));
  } finally {
    session.stop();
    server.close();
  }
  assert.ok(session.child.killed || session.child.exitCode != null || session.child.signalCode != null, 'Chrome is closed when the session stops');
});

test('sherlock_interact: opens the url, repeats, and refuses native sessions', { skip: !chrome && 'needs Chrome or Chromium (set CHROME_PATH)', timeout: 120000 }, async () => {
  const server = await startInteractionServer({ apiDelayMs: 150 });
  let id;
  try {
    const out = await callTool('sherlock_interact', { url: server.url, selector: '#open', label: 'open list', repeat: 2 });
    id = out.session;
    assert.equal(out.runs.length, 2);
    assert.match(out.runs[0].slowest, /^[a-z ,&()-]+ (\d+ ms|\d+\.\d\d s) \(\d+%\)$/);
    assert.ok(out.runs[0].breakdown.some((b) => b.startsWith('event handlers: ')));
    assert.match(out.finding.title, /^Slowest segment of "open list" is /);
    await assert.rejects(callTool('sherlock_interact', { session: id, selector: '#open', label: 'again', done_selector: '#done' }), /already matches/);
  } finally {
    if (id) await callTool('sherlock_stop', { session: id, out_dir: join(tmpdir(), `sherlock-interact-${process.pid}`) });
    server.close();
  }
  const native = new Session({ kind: 'attach', target: 'x', platform: 'test' });
  registerSession(native);
  await assert.rejects(callTool('sherlock_interact', { session: native.id, selector: '#x', label: 'x' }), /drives web pages.*sherlock_mark with stacks_seconds/);
  native.stop();
});
