import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { run, which } from '../util.mjs';
import { parsePsTable, descendants, parsePsThreads, parseNettop, parseIoregGpu, parseFootprint } from '../parse/macos.mjs';
import { parseProcStat, parseProcStatus, parseProcIo, parseNetDev, parsePerfInterval, perfBandwidth } from '../parse/linux.mjs';

export function hostPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

export function createHostSampler(rootPid, opts = {}) {
  const platform = opts.platform ?? hostPlatform();
  if (platform === 'macos') return new MacSampler(rootPid, opts);
  if (platform === 'linux') return new LinuxSampler(rootPid, opts);
  throw new Error(`Sherlock can't sample processes on ${platform} yet. macOS and Linux are supported.`);
}

class BaseSampler {
  constructor(rootPid, opts) {
    this.rootPid = rootPid;
    this.includeChildren = opts.includeChildren ?? true;
    this.prev = null;
    this.netEvery = opts.netEvery ?? 2;
    this.gpuEvery = opts.gpuEvery ?? 4;
    this.tick = 0;
    this.lastNet = null;
    this.lastGpu = null;
    this.capabilities = {};
  }

  rate(curr, field, wallSeconds) {
    if (!this.prev || this.prev[field] == null || curr[field] == null || wallSeconds <= 0) return null;
    return Math.max(0, (curr[field] - this.prev[field]) / wallSeconds);
  }

  finish(raw, t) {
    const wall = this.prev ? (t - this.prev.t) / 1000 : 0;
    const cpuRate = this.rate(raw, 'cpuSeconds', wall);
    const sample = {
      t,
      alive: raw.alive,
      cpuPct: cpuRate == null ? null : cpuRate * 100,
      rssBytes: raw.rssBytes,
      residentBytes: raw.residentBytes ?? null,
      threads: raw.threads,
      processes: raw.processes,
      netInBps: null,
      netOutBps: null,
      diskReadBps: this.rate(raw, 'diskRead', wall),
      diskWriteBps: this.rate(raw, 'diskWrite', wall),
      gpuPct: raw.gpuPct ?? null,
      memBandwidthBps: raw.memBandwidthBps ?? null,
    };
    if (raw.netIn != null) {
      if (this.netPrev) {
        const dt = (t - this.netPrev.t) / 1000;
        if (dt > 0) {
          this.netRate = {
            in: Math.max(0, (raw.netIn - this.netPrev.in) / dt),
            out: Math.max(0, (raw.netOut - this.netPrev.out) / dt),
          };
        }
      }
      this.netPrev = { t, in: raw.netIn, out: raw.netOut };
    }
    if (this.netRate) {
      sample.netInBps = this.netRate.in;
      sample.netOutBps = this.netRate.out;
    }
    this.prev = { ...raw, t };
    return sample;
  }

  stop() {}
}

class MacSampler extends BaseSampler {
  constructor(rootPid, opts) {
    super(rootPid, opts);
    this.capabilities = {
      cpu: 'ps cumulative CPU time, process tree',
      memory: which('footprint') ? 'physical footprint (dirty + compressed memory, what Activity Monitor shows), process tree' : 'ps resident set size, process tree',
      threads: 'ps -M',
      network: which('nettop') ? 'nettop per-process bytes' : null,
      gpu: which('ioreg') ? 'ioreg IOAccelerator device utilization (whole GPU, not per process)' : null,
      memBandwidth: null,
      memBandwidthReason: 'macOS only exposes memory bandwidth through `sudo powermetrics`; Sherlock does not run sudo.',
    };
  }

  async sample(t = performance.now()) {
    this.tick++;
    const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,comm=']);
    const rows = parsePsTable(ps.stdout);
    const pids = this.includeChildren ? descendants(rows, this.rootPid) : new Set([this.rootPid]);
    const mine = rows.filter((r) => pids.has(r.pid));
    const alive = mine.some((r) => r.pid === this.rootPid);
    const resident = mine.reduce((a, r) => a + r.rssBytes, 0);
    let footprints = null;
    if (alive && which('footprint')) {
      const fp = await run('footprint', ['-f', 'bytes', ...mine.slice(0, 24).flatMap((r) => ['--pid', String(r.pid)])], { timeout: 4000 });
      footprints = parseFootprint(fp.stdout);
      if (!footprints.size) footprints = null;
    }
    const memOf = (r) => footprints?.get(r.pid) ?? r.rssBytes;
    const raw = {
      alive,
      cpuSeconds: mine.reduce((a, r) => a + r.cpuSeconds, 0),
      rssBytes: footprints ? mine.reduce((a, r) => a + memOf(r), 0) : resident,
      residentBytes: resident,
      processes: mine.map((r) => ({ pid: r.pid, ppid: r.ppid, rssBytes: memOf(r), residentBytes: r.rssBytes, cpuSeconds: r.cpuSeconds, command: r.command.split('/').pop() })),
      threads: null,
    };
    if (alive) {
      const th = await run('ps', ['-M', '-p', String(this.rootPid)]);
      raw.threads = parsePsThreads(th.stdout).length || null;
    }
    if (this.capabilities.network && (this.tick % this.netEvery === 1 || this.netEvery === 1)) {
      const nt = await run('nettop', ['-P', '-L', '1', '-n', '-x', '-J', 'bytes_in,bytes_out'], { timeout: 5000 });
      const byPid = parseNettop(nt.stdout);
      let netIn = 0;
      let netOut = 0;
      for (const pid of pids) {
        const v = byPid.get(pid);
        if (v) {
          netIn += v.bytesIn;
          netOut += v.bytesOut;
        }
      }
      raw.netIn = netIn;
      raw.netOut = netOut;
    }
    if (this.capabilities.gpu && (this.tick % this.gpuEvery === 1 || this.gpuEvery === 1)) {
      const io = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 5000 });
      const g = parseIoregGpu(io.stdout);
      this.lastGpu = g ? g.utilizationPct : null;
    }
    raw.gpuPct = this.lastGpu;
    return this.finish(raw, t);
  }
}

class LinuxSampler extends BaseSampler {
  constructor(rootPid, opts) {
    super(rootPid, opts);
    this.procRoot = opts.procRoot ?? '/proc';
    this.clockTicks = opts.clockTicks ?? 100;
    this.perf = null;
    this.perfEvents = [];
    this.capabilities = {
      cpu: '/proc/<pid>/stat utime+stime, process tree',
      memory: '/proc/<pid>/status VmRSS, process tree',
      threads: '/proc/<pid>/status Threads',
      network: '/proc/<pid>/net/dev (the network namespace, not just this process)',
      disk: '/proc/<pid>/io',
      gpu: null,
      memBandwidth: null,
      memBandwidthReason: 'Needs `perf` with permission to read LLC miss counters (perf_event_paranoid <= 1).',
    };
    if (opts.memBandwidth !== false && which('perf')) this.startPerf();
  }

  startPerf() {
    try {
      const child = spawn('perf', ['stat', '-x', ',', '-I', '1000', '-e', 'LLC-load-misses,LLC-store-misses', '-p', String(this.rootPid)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let buf = '';
      child.stderr.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const e = parsePerfInterval(line);
          if (e) {
            this.perfEvents.push(e);
            if (e.count != null) {
              this.capabilities.memBandwidth = 'perf LLC load+store misses × 64 B (estimate of DRAM traffic)';
              this.capabilities.memBandwidthReason = null;
            }
          }
        }
      });
      child.on('error', () => {});
      this.perf = child;
    } catch {
      this.perf = null;
    }
  }

  async childrenOf() {
    const pids = new Set([this.rootPid]);
    if (!this.includeChildren) return pids;
    const rows = [];
    let entries = [];
    try {
      entries = await readdir(this.procRoot);
    } catch {
      return pids;
    }
    await Promise.all(
      entries
        .filter((e) => /^\d+$/.test(e))
        .map(async (e) => {
          try {
            const st = parseProcStat(await readFile(`${this.procRoot}/${e}/stat`, 'utf8'));
            if (st) rows.push({ pid: st.pid, ppid: st.ppid });
          } catch {}
        }),
    );
    return descendants(rows, this.rootPid);
  }

  async sample(t = performance.now()) {
    this.tick++;
    const pids = await this.childrenOf();
    let cpuTicks = 0;
    let rss = 0;
    let threads = null;
    let diskRead = 0;
    let diskWrite = 0;
    let alive = false;
    const processes = [];
    for (const pid of pids) {
      try {
        const st = parseProcStat(await readFile(`${this.procRoot}/${pid}/stat`, 'utf8'));
        const status = parseProcStatus(await readFile(`${this.procRoot}/${pid}/status`, 'utf8'));
        if (!st) continue;
        if (st.state === 'Z') continue;
        if (pid === this.rootPid) {
          alive = true;
          threads = status.threads;
        }
        cpuTicks += st.utimeTicks + st.stimeTicks;
        rss += status.rssBytes ?? 0;
        processes.push({ pid, ppid: st.ppid, rssBytes: status.rssBytes, cpuSeconds: (st.utimeTicks + st.stimeTicks) / this.clockTicks, command: st.comm });
        try {
          const io = parseProcIo(await readFile(`${this.procRoot}/${pid}/io`, 'utf8'));
          diskRead += io.readBytes;
          diskWrite += io.writeBytes;
        } catch {}
      } catch {}
    }
    const raw = { alive, cpuSeconds: cpuTicks / this.clockTicks, rssBytes: rss, threads, processes, diskRead, diskWrite };
    try {
      const net = parseNetDev(await readFile(`${this.procRoot}/${this.rootPid}/net/dev`, 'utf8'));
      raw.netIn = net.bytesIn;
      raw.netOut = net.bytesOut;
    } catch {}
    if (this.perfEvents.length) {
      const latest = this.perfEvents[this.perfEvents.length - 1].time;
      const window = this.perfEvents.filter((e) => e.time === latest);
      const bytes = perfBandwidth(window);
      raw.memBandwidthBps = bytes;
    }
    return this.finish(raw, t);
  }

  stop() {
    if (this.perf) this.perf.kill('SIGINT');
  }
}
