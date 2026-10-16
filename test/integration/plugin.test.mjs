import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Session } from '../../src/session.mjs';
import { startDashboard, writeReport } from '../../src/server.mjs';
import { run, which } from '../../src/util.mjs';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'cli/sherlock.mjs');
const json = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

test('plugin manifest, marketplace and MCP config agree', async () => {
  const plugin = await json('.claude-plugin/plugin.json');
  const market = await json('.claude-plugin/marketplace.json');
  const mcp = await json('.mcp.json');
  const pkg = await json('package.json');
  assert.equal(plugin.name, 'sherlock');
  assert.match(plugin.name, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, 'MIT');
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  assert.deepEqual(mcp.mcpServers.sherlock.args, ['${CLAUDE_PLUGIN_ROOT}/cli/sherlock.mjs', 'mcp']);
  assert.equal(mcp.mcpServers.sherlock.command, 'node');
  const skill = await readFile(join(ROOT, 'skills/profile/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: profile\ndescription: .+\n/);
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.replace(/```[\s\S]*?```/g, '').split(/\s+/).length > 40, 'README has at least 40 words outside code');
  const top = await readdir(ROOT);
  assert.ok(!top.includes('bin'), 'no top-level bin/ (claude.ai will not install it)');
  assert.ok(!top.includes('.DS_Store'));
  assert.ok(!top.includes('package-lock.json'), 'no lockfile in the plugin root');
});

test('claude plugin validate', { skip: !which('claude') && 'Claude Code not installed', timeout: 60000 }, async () => {
  for (const target of [ROOT, join(ROOT, '.claude-plugin/plugin.json'), join(ROOT, 'skills')]) {
    const r = await run('claude', ['plugin', 'validate', target], { timeout: 55000 });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /Validation passed/);
  }
});

function mcpClient() {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  return {
    call: (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
      }),
    notify: (method) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => proc.stdin.end(),
    proc,
  };
}

test('MCP server: initialize, list tools, call tools, report errors', { timeout: 60000 }, async () => {
  const c = mcpClient();
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'sherlock');
    assert.ok(init.result.capabilities.tools);
    c.notify('notifications/initialized');
    const list = await c.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['sherlock_detect', 'sherlock_launch', 'sherlock_attach', 'sherlock_web', 'sherlock_ios', 'sherlock_android', 'sherlock_mark', 'sherlock_dashboard', 'sherlock_note', 'sherlock_stop']) assert.ok(names.includes(n), n);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
    const detect = await c.call('tools/call', { name: 'sherlock_detect', arguments: { dir: join(ROOT, 'test/fixtures/rust-app') } });
    assert.match(detect.result.content[0].text, /"rust"/);
    const bad = await c.call('tools/call', { name: 'sherlock_launch', arguments: {} });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /command/);
    const launch = await c.call('tools/call', {
      name: 'sherlock_launch',
      arguments: { command: `${process.execPath} ${join(ROOT, 'test/fixtures/apps/slow-start.mjs')}`, ready_log: '^READY', stacks: false, keep_alive: false },
    });
    const digest = JSON.parse(launch.result.content[0].text);
    assert.ok(digest.metrics.startup);
    assert.ok(digest.findings.length > 0);
    const missing = await c.call('nope/method', {});
    assert.equal(missing.error.code, -32601);
  } finally {
    c.close();
  }
});

test('dashboard: serves the UI, streams samples over SSE, accepts marks and notes', { timeout: 30000 }, async () => {
  const s = new Session({ kind: 'attach', target: 'test', platform: 'test' });
  s.setStatus('running');
  const ui = await startDashboard(s);
  try {
    const html = await (await fetch(ui.url)).text();
    assert.match(html, /<title>Sherlock<\/title>/);
    assert.match(await (await fetch(`${ui.url}app.js`)).text(), /number-flow/);
    assert.equal((await fetch(`${ui.url}../../etc/passwd`)).status, 404);

    const res = await fetch(`${ui.url}api/stream`);
    const reader = res.body.getReader();
    const events = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      let text = '';
      while (events.length < 4) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
        const parts = text.split('\n\n');
        text = parts.pop();
        for (const p of parts) {
          const ev = p.match(/^event: (\w+)/m);
          if (ev) events.push(ev[1]);
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    s.addSample({ t: performance.now(), cpuPct: 12, rssBytes: 1000 });
    const mark = await (await fetch(`${ui.url}api/mark`, { method: 'POST', body: JSON.stringify({ label: 'open doc' }) })).json();
    assert.equal(mark.label, 'open doc');
    await fetch(`${ui.url}api/note`, { method: 'POST', body: JSON.stringify({ title: 'hello', body: 'world' }) });
    await pump;
    reader.cancel();
    assert.deepEqual(events.slice(0, 4), ['session', 'sample', 'mark', 'note']);
    const snap = await (await fetch(`${ui.url}api/session`)).json();
    assert.equal(snap.marks.length, 1);
    assert.equal(snap.notes[0].title, 'hello');
    const paths = await writeReport(s, join(tmpdir(), `sherlock-report-${process.pid}`));
    const report = await readFile(paths.htmlPath, 'utf8');
    assert.match(report, /window.__SHERLOCK__/);
    assert.ok(!report.includes('src="app.js"'), 'report is self-contained');
  } finally {
    s.stop();
    await ui.close();
  }
});

test('CLI: help, version, detect and a one-shot launch', { timeout: 60000 }, async () => {
  const help = await run(process.execPath, [CLI, '--help']);
  assert.match(help.stdout, /sherlock launch/);
  const version = await run(process.execPath, [CLI, '--version']);
  assert.equal(version.stdout.trim(), (await json('package.json')).version);
  const detect = await run(process.execPath, [CLI, 'detect', join(ROOT, 'test/fixtures/rust-app'), '--json']);
  assert.deepEqual(JSON.parse(detect.stdout).stacks, ['rust']);
  const launch = await run(process.execPath, [CLI, 'launch', '--exit', '--json', '--no-stacks', '--ready-log', '^READY', '--', process.execPath, join(ROOT, 'test/fixtures/apps/slow-start.mjs')], {
    cwd: tmpdir(),
    timeout: 50000,
  });
  assert.equal(launch.code, 0, launch.stderr);
  const d = JSON.parse(launch.stdout);
  assert.equal(d.startup.readySignal, 'log: READY true');
  assert.ok(d.report.jsonPath.endsWith('.json'));
  const bad = await run(process.execPath, [CLI, 'frobnicate']);
  assert.equal(bad.code, 1);
});
