import { Session, registerSession } from '../session.mjs';
import { createHostSampler } from './host.mjs';
import { sampleStacks, canSampleStacks } from '../stacks.mjs';
import { run, sleep } from '../util.mjs';
import { SETTLE_CPU_PCT } from '../launch.mjs';
import { parseAmStart, parseDumpsysMeminfo, parsePidof, parseResolveActivity, parseSimctlLaunch, parseBootedDevices } from '../parse/mobile.mjs';
import { parseProcStat, parseProcStatus, parseNetDev } from '../parse/linux.mjs';

const xcrun = () => process.env.SHERLOCK_XCRUN || 'xcrun';
const adbBin = () => process.env.SHERLOCK_ADB || 'adb';

export async function bootedSimulators() {
  const r = await run(xcrun(), ['simctl', 'list', 'devices', 'booted', '-j']);
  if (r.code !== 0) return [];
  try {
    return parseBootedDevices(r.stdout);
  } catch {
    return [];
  }
}

export async function profileIos(opts) {
  const device = opts.device ?? 'booted';
  const bundleId = opts.bundleId;
  if (!bundleId) throw new Error('Pass the app bundle id, for example: sherlock ios com.example.app');
  if (process.platform !== 'darwin' && !process.env.SHERLOCK_XCRUN) throw new Error('iOS Simulator profiling needs macOS.');
  const sims = await bootedSimulators();
  if (!sims.length && device === 'booted') throw new Error('No booted iOS Simulator. Boot one with `xcrun simctl boot "iPhone 17 Pro"` or open Simulator.app.');
  const session = registerSession(new Session({ kind: 'ios', target: bundleId, platform: 'ios-simulator', meta: { device: sims[0]?.name ?? device, runtime: sims[0]?.runtime } }));
  if (opts.cold !== false) await run(xcrun(), ['simctl', 'terminate', device, bundleId]);
  await sleep(150);
  const t0 = performance.now();
  session.t0 = t0;
  session.startup = { readyMs: null, readySignal: null, settledMs: null };
  const r = await run(xcrun(), ['simctl', 'launch', device, bundleId], { timeout: 60000 });
  const launched = parseSimctlLaunch(r.stdout);
  if (r.code !== 0 || !launched) {
    session.error = (r.stderr || r.stdout).trim() || 'simctl launch failed';
    session.setStatus('failed');
    session.stop();
    throw new Error(session.error);
  }
  const launchReturnedMs = session.elapsed();
  session.event('spawn', { pid: launched.pid });
  session.setStatus('running');
  session.mobile = { os: 'ios', bundleId, pid: launched.pid, launchCommandMs: launchReturnedMs, launchMs: null };
  session.phase('simctl launch', 0, launchReturnedMs);
  session.startSampling(createHostSampler(launched.pid, { includeChildren: false }), opts.intervalMs ?? 100);
  if (opts.stacks !== false && canSampleStacks() && !process.env.SHERLOCK_XCRUN) {
    session.stacksPromise = sampleStacks(launched.pid, opts.stackSeconds ?? 2).then((s) => {
      session.stacks = { window: 'startup', ...s };
    });
  }
  await waitForSettle(session, { after: launchReturnedMs, settleMs: opts.settleMs ?? 600, timeoutMs: opts.timeoutMs ?? 20000 });
  session.mobile.launchMs = session.startup.settledMs ?? launchReturnedMs;
  session.startup.readyMs = session.mobile.launchMs;
  session.startup.readySignal = session.startup.settledMs != null ? 'main thread went quiet' : 'simctl launch returned';
  if (session.startup.settledMs != null) session.phase('launch → quiet', launchReturnedMs, session.startup.settledMs);
  if (session.stacksPromise) await session.stacksPromise.catch(() => {});
  if (!opts.keepAlive) session.stop();
  else session.refreshFindings();
  return session;
}

async function waitForSettle(session, { after, settleMs, timeoutMs }) {
  const start = performance.now();
  let calmSince = null;
  while (performance.now() - start < timeoutMs && !session.stopped) {
    await sleep(50);
    const s = session.samples[session.samples.length - 1];
    if (!s || s.t < after || s.cpuPct == null) continue;
    if (s.cpuPct < SETTLE_CPU_PCT) {
      calmSince ??= s.t;
      if (s.t - calmSince >= settleMs) {
        session.startup.settledMs = calmSince;
        return;
      }
    } else calmSince = null;
  }
}

export function adb(args, opts = {}) {
  const serial = opts.serial ?? process.env.ANDROID_SERIAL;
  return run(adbBin(), [...(serial ? ['-s', serial] : []), ...args], { timeout: opts.timeout ?? 20000 });
}

export async function androidDevices() {
  const r = await run(adbBin(), ['devices']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[1] === 'device')
    .map((c) => c[0]);
}

class AdbSampler {
  constructor(pid, pkg, serial) {
    this.pid = pid;
    this.pkg = pkg;
    this.serial = serial;
    this.prev = null;
    this.tick = 0;
    this.pss = null;
    this.capabilities = {
      cpu: 'adb /proc/<pid>/stat',
      memory: 'adb /proc/<pid>/status VmRSS, dumpsys meminfo PSS every 8th sample',
      network: 'adb /proc/<pid>/net/dev (app network namespace)',
      gpu: null,
      memBandwidth: null,
      memBandwidthReason: 'Needs simpleperf or Perfetto counters on the device; not wired up in this release.',
    };
  }

  async sample(t = performance.now()) {
    this.tick++;
    const r = await adb(['shell', `cat /proc/${this.pid}/stat /proc/${this.pid}/status /proc/${this.pid}/net/dev 2>/dev/null`], { serial: this.serial, timeout: 5000 });
    const text = r.stdout;
    const statLine = text.split('\n').find((l) => l.startsWith(`${this.pid} (`));
    const st = statLine ? parseProcStat(statLine) : null;
    const status = parseProcStatus(text);
    const net = parseNetDev(text.slice(text.indexOf('Inter-|')));
    if (this.tick % 8 === 1) {
      const mi = await adb(['shell', 'dumpsys', 'meminfo', this.pkg], { serial: this.serial, timeout: 8000 });
      this.pss = parseDumpsysMeminfo(mi.stdout).totalPssBytes ?? this.pss;
    }
    const cpuSeconds = st ? (st.utimeTicks + st.stimeTicks) / 100 : null;
    const wall = this.prev ? (t - this.prev.t) / 1000 : 0;
    const out = {
      t,
      alive: !!st,
      cpuPct: this.prev && cpuSeconds != null && wall > 0 ? Math.max(0, ((cpuSeconds - this.prev.cpu) / wall) * 100) : null,
      rssBytes: status.rssBytes,
      pssBytes: this.pss,
      threads: status.threads,
      processes: null,
      netInBps: this.prev && wall > 0 ? Math.max(0, (net.bytesIn - this.prev.netIn) / wall) : null,
      netOutBps: this.prev && wall > 0 ? Math.max(0, (net.bytesOut - this.prev.netOut) / wall) : null,
      gpuPct: null,
      memBandwidthBps: null,
    };
    this.prev = { t, cpu: cpuSeconds, netIn: net.bytesIn, netOut: net.bytesOut };
    return out;
  }

  stop() {}
}

export async function profileAndroid(opts) {
  const serial = opts.serial;
  let component = opts.component ?? opts.target;
  if (!component) throw new Error('Pass a package or package/activity, for example: sherlock android com.example.app');
  const devices = await androidDevices();
  if (!devices.length) throw new Error('No Android device or emulator found by `adb devices`.');
  let pkg = component.split('/')[0];
  if (!component.includes('/')) {
    const r = await adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg], { serial });
    component = parseResolveActivity(r.stdout);
    if (!component) throw new Error(`Could not find a launcher activity for ${pkg}.`);
  }
  const session = registerSession(new Session({ kind: 'android', target: component, platform: 'android', meta: { device: serial ?? devices[0] } }));
  if (opts.cold !== false) await adb(['shell', 'am', 'force-stop', pkg], { serial });
  await sleep(200);
  session.t0 = performance.now();
  const r = await adb(['shell', 'am', 'start', '-W', '-n', component], { serial, timeout: 60000 });
  const start = parseAmStart(r.stdout);
  const commandMs = session.elapsed();
  if (start.error || (start.status && start.status !== 'ok')) {
    session.error = start.error ?? `am start status ${start.status}`;
    session.setStatus('failed');
    session.stop();
    throw new Error(session.error);
  }
  const pid = parsePidof((await adb(['shell', 'pidof', pkg], { serial })).stdout);
  session.mobile = { os: 'android', package: pkg, component, pid, ...start, launchCommandMs: commandMs };
  session.startup = { readyMs: start.totalTimeMs ?? commandMs, readySignal: start.totalTimeMs != null ? 'am start -W TotalTime (first frame)' : 'am start returned' };
  if (start.totalTimeMs != null) session.phase(`${(start.launchState ?? 'cold').toLowerCase()} start → first frame`, 0, start.totalTimeMs);
  session.event('spawn', { pid });
  session.setStatus('running');
  if (pid) session.startSampling(new AdbSampler(pid, pkg, serial), opts.intervalMs ?? 500);
  await sleep(opts.observeMs ?? 3000);
  if (!opts.keepAlive) session.stop();
  else session.refreshFindings();
  return session;
}
