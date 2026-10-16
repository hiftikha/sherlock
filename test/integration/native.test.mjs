import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchNative, attachNative, captureStacks } from '../../src/launch.mjs';
import { canSampleStacks } from '../../src/stacks.mjs';
import { sleep } from '../../src/util.mjs';

const host = process.platform === 'darwin' || process.platform === 'linux';
const APP = fileURLToPath(new URL('../fixtures/apps/slow-start.mjs', import.meta.url));
const MB = 1024 * 1024;

test(`launch measures startup on ${process.platform}`, { skip: !host && 'macOS and Linux only', timeout: 60000 }, async () => {
  const session = launchNative({ argv: [process.execPath, APP], readyLog: '^READY', env: { WAIT_MS: '300', BURN_MS: '400', LEAK_MB: '64', LIFE_MS: '4000' }, stacks: false });
  await session.done;
  const j = session.toJSON();
  session.stop();
  assert.equal(j.startup.readySignal, 'log: READY true');
  assert.ok(j.startup.readyMs >= 650 && j.startup.readyMs < 3000, `ready at ${j.startup.readyMs} ms`);
  assert.ok(j.startup.firstOutputMs < j.startup.readyMs);
  assert.ok(j.phases.length >= 3);
  assert.ok(j.samples.length >= 5, `${j.samples.length} samples`);
  assert.ok(j.summary.peakRssBytes > 64 * MB, `peak rss ${j.summary.peakRssBytes}`);
  assert.ok(j.summary.peakCpuPct > 50, `peak cpu ${j.summary.peakCpuPct}`);
  assert.ok(j.summary.threads >= 1);
  assert.ok(j.findings.some((f) => f.id === 'startup-total'));
});

test('launch reports a command that cannot start', { skip: !host && 'macOS and Linux only', timeout: 20000 }, async () => {
  const session = launchNative({ argv: ['/definitely/not/a/binary'], stacks: false, timeoutMs: 5000 });
  await session.done;
  assert.equal(session.status, 'failed');
  assert.match(session.error, /Could not start/);
});

test('launch with a ready port', { skip: !host && 'macOS and Linux only', timeout: 30000 }, async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const session = launchNative({
    argv: [process.execPath, '-e', `setTimeout(()=>require('http').createServer((q,r)=>r.end('ok')).listen(${port}),400)`],
    readyPort: port,
    stacks: false,
  });
  await session.done;
  session.stop();
  assert.equal(session.startup.readySignal, `port ${port}`);
  assert.ok(session.startup.readyMs >= 350);
});

test('attach samples a running process and its interaction marks', { skip: !host && 'macOS and Linux only', timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [APP], { env: { ...process.env, WAIT_MS: '0', BURN_MS: '0', LIFE_MS: '20000' }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.on('data', (d) => String(d).includes('READY') && resolve()));
  const session = await attachNative({ pid: child.pid, intervalMs: 150 });
  await sleep(600);
  for (let i = 0; i < 3; i++) {
    session.mark('open doc');
    process.kill(child.pid, 'SIGUSR2');
    await sleep(900);
  }
  session.stop();
  child.kill();
  const j = session.toJSON();
  assert.equal(j.kind, 'attach');
  assert.equal(j.marks.length, 3);
  assert.ok(j.samples.length >= 10);
  const leak = j.findings.find((f) => f.id === 'interaction-leak');
  assert.ok(leak, `expected a leak finding, got ${j.findings.map((f) => f.id)}`);
  assert.match(leak.title, /open doc/);
});

test('macOS: startup call stacks from a warm-up launch', { skip: !canSampleStacks() && 'needs macOS sample', timeout: 90000 }, async () => {
  const session = launchNative({ argv: [process.execPath, APP], readyLog: '^READY', env: { WAIT_MS: '0', BURN_MS: '2500', LIFE_MS: '3500' } });
  await session.done;
  session.stop();
  assert.ok(session.stacks, 'stacks recorded');
  assert.equal(session.stacks.pass, 'warm-up launch');
  assert.ok(session.stacks.available, session.stacks.reason);
  assert.ok(session.stacks.hot.length > 0);
});

test('macOS: on-demand stacks during a live session', { skip: !canSampleStacks() && 'needs macOS sample', timeout: 60000 }, async () => {
  const busy = spawn(process.execPath, ['-e', 'const e=Date.now()+8000;let x=0;while(Date.now()<e)x+=Math.sqrt(x+1)'], { stdio: 'ignore' });
  const session = await attachNative({ pid: busy.pid });
  const st = await captureStacks(session, 1);
  session.stop();
  busy.kill();
  assert.ok(st.available, st.reason);
  assert.ok(st.hot[0].pctOfActive > 0.05);
});
