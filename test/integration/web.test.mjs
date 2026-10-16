import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { profileWeb, findChrome } from '../../src/platform/web.mjs';

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
