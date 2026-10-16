import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { Session, registerSession } from './session.mjs';
import { createHostSampler, hostPlatform } from './platform/host.mjs';
import { sampleStacks, canSampleStacks, canWaitForName, startWaitingSampler } from './stacks.mjs';
import { splitCommand, run, sleep } from './util.mjs';
import { parsePsTable } from './parse/macos.mjs';

export const SETTLE_CPU_PCT = 8;

export function launchNative(opts) {
  const argv = opts.argv ?? splitCommand(opts.command ?? '');
  if (!argv.length) throw new Error('Nothing to launch. Pass a command, for example: sherlock launch -- ./target/release/my-app');
  const session = registerSession(
    new Session({ kind: 'launch', target: argv.join(' '), platform: hostPlatform(), meta: { cwd: opts.cwd ?? process.cwd(), label: opts.label } }),
  );
  const wantStacks = opts.stacks !== false && canSampleStacks();
  session.done = (async () => {
    if (wantStacks) {
      session.setStatus('warming up');
      session.event('stack-pass', { note: 'warm-up launch to capture call stacks; timing comes from the next launch' });
      try {
        const stacks = await stackPass(argv, opts);
        session.stacks = { window: 'startup', pass: 'warm-up launch', ...stacks };
        session.emit('stacks', session.stacks);
      } catch (err) {
        session.stacks = { available: false, reason: err.message };
      }
      session.meta.warmStart = true;
    }
    if (session.stopped) return session;
    return measuredLaunch(session, argv, opts);
  })();
  return session;
}

async function stackPass(argv, opts, attempt = 1) {
  const seconds = opts.stackSeconds ?? 2;
  const early = canWaitForName(argv[0]);
  const waiting = early ? startWaitingSampler(argv[0], seconds) : null;
  if (early) await sleep(400);
  const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdio: 'ignore' });
  const spawned = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!spawned) {
    waiting?.catch(() => {});
    throw new Error(`Could not start ${argv[0]}`);
  }
  const result = early ? await waiting : await sampleStacks(child.pid, seconds);
  if (child.exitCode == null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await sleep(250);
  if (!result.available && result.activeSamples == null && attempt < 2) return stackPass(argv, opts, attempt + 1);
  return { ...result, fromFirstInstruction: early };
}

function measuredLaunch(session, argv, opts) {
  const interval = opts.intervalMs ?? 100;
  const settleMs = opts.settleMs ?? 750;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const readyLog = opts.readyLog ? new RegExp(opts.readyLog) : null;
  const ready = { log: readyLog, port: opts.readyPort ? Number(opts.readyPort) : null, url: opts.readyUrl ?? null };

  session.samples = [];
  session.events = session.events.filter((e) => e.type === 'stack-pass');
  const t0 = performance.now();
  session.t0 = t0;
  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  session.child = child;
  session.startup = { spawnMs: null, firstOutputMs: null, readyMs: null, readySignal: null, settledMs: null, exitedMs: null, exitCode: null };

  const markReady = (signal) => {
    if (session.startup.readyMs != null) return;
    session.startup.readyMs = session.elapsed();
    session.startup.readySignal = signal;
    session.event('ready', { signal });
    session.emit('ready');
  };

  child.on('spawn', () => {
    session.startup.spawnMs = session.elapsed();
    session.meta.pid = child.pid;
    session.event('spawn', { pid: child.pid });
    session.setStatus('running');
    session.startSampling(createHostSampler(child.pid, { includeChildren: true }), interval);
  });

  child.on('error', (err) => {
    session.error = `Could not start ${argv[0]}: ${err.message}`;
    session.event('error', { message: session.error });
    session.setStatus('failed');
    session.stop();
  });

  const onData = (stream) => (chunk) => {
    const text = String(chunk);
    if (session.startup.firstOutputMs == null) {
      session.startup.firstOutputMs = session.elapsed();
      session.event('first-output', { stream });
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      session.log(stream, line);
      if (ready.log && ready.log.test(line)) markReady(`log: ${line.trim().slice(0, 80)}`);
    }
    if (opts.passthrough) process[stream === 'stdout' ? 'stdout' : 'stderr'].write(chunk);
  };
  child.stdout.on('data', onData('stdout'));
  child.stderr.on('data', onData('stderr'));

  child.on('exit', (code, signal) => {
    session.startup.exitedMs = session.elapsed();
    session.startup.exitCode = code ?? signal;
    session.event('exit', { code, signal });
  });

  if (ready.port || ready.url) {
    (async () => {
      while (session.startup.readyMs == null && !session.stopped && performance.now() - t0 < timeoutMs) {
        if (ready.port && (await portOpen(ready.port))) {
          markReady(`port ${ready.port}`);
          break;
        }
        if (ready.url) {
          try {
            const res = await fetch(ready.url, { signal: AbortSignal.timeout(1000) });
            if (res.status < 500) {
              markReady(`url ${ready.url} → ${res.status}`);
              break;
            }
          } catch {}
        }
        await sleep(50);
      }
    })();
  }

  let calmSince = null;
  session.on('sample', (s) => {
    if (session.startup.settledMs != null || s.cpuPct == null) return;
    const after = session.startup.readyMs ?? session.startup.firstOutputMs ?? session.startup.spawnMs ?? 0;
    if (s.t < after) return;
    if (s.cpuPct < SETTLE_CPU_PCT) {
      calmSince ??= s.t;
      if (s.t - calmSince >= settleMs) {
        session.startup.settledMs = calmSince;
        session.event('settled', { at: calmSince });
        session.emit('settled');
      }
    } else {
      calmSince = null;
    }
  });

  session.kill = () => {
    if (child.exitCode == null) child.kill('SIGTERM');
  };
  session.once('stopped', () => session.kill());

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      buildPhases(session);
      session.refreshFindings();
      resolve(session);
    };
    const timer = setTimeout(() => {
      session.event('startup-timeout', { timeoutMs });
      finish();
    }, timeoutMs);
    const check = () => {
      const s = session.startup;
      const haveReady = s.readyMs != null || (!ready.log && !ready.port && !ready.url);
      if ((haveReady && s.settledMs != null) || s.exitedMs != null || session.status === 'failed') finish();
    };
    session.on('settled', check);
    session.on('ready', check);
    session.on('stopped', check);
    child.on('exit', () => setTimeout(check, interval * 2));
  });
}

export function buildPhases(session) {
  const s = session.startup;
  if (!s) return;
  session.phases = [];
  const marks = [
    ['spawn', s.spawnMs],
    ['first output', s.firstOutputMs],
    ['ready', s.readyMs],
    ['settled', s.settledMs],
  ].filter(([, v]) => v != null);
  let prev = 0;
  let prevName = 'launch';
  for (const [name, at] of marks) {
    if (at < prev) continue;
    session.phase(phaseLabel(prevName, name), prev, at);
    prev = at;
    prevName = name;
  }
}

function phaseLabel(from, to) {
  if (to === 'spawn') return 'process spawn';
  if (to === 'first output') return 'init → first output';
  if (to === 'ready') return from === 'spawn' ? 'init → ready' : 'output → ready';
  if (to === 'settled') return 'ready → idle';
  return `${from} → ${to}`;
}

export async function attachNative(opts) {
  let pid = opts.pid ? Number(opts.pid) : null;
  if (!pid && opts.name) pid = await findPid(opts.name);
  if (!pid) throw new Error(`No running process matches "${opts.name ?? opts.pid}".`);
  const session = registerSession(new Session({ kind: 'attach', target: opts.name ?? `pid ${pid}`, platform: hostPlatform(), meta: { pid } }));
  session.setStatus('running');
  session.startSampling(createHostSampler(pid, { includeChildren: opts.includeChildren ?? true }), opts.intervalMs ?? 250);
  return session;
}

export async function captureStacks(session, seconds = 2) {
  const pid = session.meta?.pid ?? session.mobile?.pid;
  if (!pid) throw new Error('This session has no local process to sample.');
  const at = session.elapsed();
  const result = await sampleStacks(pid, seconds);
  session.stacks = { window: `${(at / 1000).toFixed(1)}s–${((at + seconds * 1000) / 1000).toFixed(1)}s`, ...result };
  session.emit('stacks', session.stacks);
  session.refreshFindings();
  return session.stacks;
}

export async function findPid(name) {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,comm=']);
  const rows = parsePsTable(r.stdout).filter((row) => row.pid !== process.pid);
  const lower = name.toLowerCase();
  const exact = rows.find((row) => row.command.split('/').pop().toLowerCase() === lower);
  if (exact) return exact.pid;
  const partial = rows.find((row) => row.command.toLowerCase().includes(lower));
  return partial?.pid ?? null;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(300, () => done(false));
  });
}
