import { demangle } from '../demangle.mjs';

export function parseCpuTime(text) {
  if (!text) return 0;
  let s = text.trim();
  let days = 0;
  const dash = s.indexOf('-');
  if (dash > 0) {
    days = Number(s.slice(0, dash));
    s = s.slice(dash + 1);
  }
  const parts = s.split(':').map(Number);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return days * 86400 + seconds;
}

export function parsePsTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpuSeconds: parseCpuTime(m[3]),
      rssBytes: Number(m[4]) * 1024,
      command: m[5].trim(),
    });
  }
  return rows;
}

export function descendants(rows, rootPid) {
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r.pid);
  }
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return seen;
}

export function parsePsThreads(text) {
  const threads = [];
  const lines = text.split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const times = line.match(/\d+:\d+(?::\d+)?\.\d+/g);
    if (!times || times.length < 2) continue;
    const pct = line.match(/\s(\d+\.\d+)\s+[A-Z]/);
    const [stime, utime] = times.slice(-2);
    threads.push({
      cpuPct: pct ? Number(pct[1]) : 0,
      cpuSeconds: parseCpuTime(stime) + parseCpuTime(utime),
    });
  }
  return threads;
}

export function parseNettop(text) {
  const byPid = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const name = cols[0];
    const m = name.match(/\.(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const bytesIn = Number(cols[1]);
    const bytesOut = Number(cols[2]);
    if (Number.isNaN(bytesIn) || Number.isNaN(bytesOut)) continue;
    const prev = byPid.get(pid) ?? { bytesIn: 0, bytesOut: 0 };
    byPid.set(pid, { bytesIn: prev.bytesIn + bytesIn, bytesOut: prev.bytesOut + bytesOut });
  }
  return byPid;
}

export function parseFootprint(text) {
  const byPid = new Map();
  for (const m of text.matchAll(/\[(\d+)\]:.*?Footprint:\s+([\d.]+)\s*(B|KB|MB|GB)\b/g)) {
    const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[3]];
    byPid.set(Number(m[1]), Math.round(Number(m[2]) * mult));
  }
  return byPid;
}

export function parseIoregGpu(text) {
  let best = null;
  const re = /"PerformanceStatistics" = \{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const util = body.match(/"Device Utilization %"=(\d+)/);
    const mem = body.match(/"In use system memory"=(\d+)/);
    const entry = {
      utilizationPct: util ? Number(util[1]) : null,
      inUseBytes: mem ? Number(mem[1]) : null,
    };
    if (entry.utilizationPct == null) continue;
    if (!best || entry.utilizationPct > best.utilizationPct) best = entry;
  }
  return best;
}

export const IDLE_SYMBOLS = new Set([
  'kevent',
  'kevent64',
  'kevent_id',
  '__psynch_cvwait',
  '__psynch_mutexwait',
  'semaphore_wait_trap',
  'semaphore_timedwait_trap',
  'mach_msg_trap',
  'mach_msg2_trap',
  '__workq_kernreturn',
  '__select',
  '__semwait_signal',
  'poll',
  '__ulock_wait',
  '__ulock_wait2',
  'start_wqthread',
  'thread_start',
  '__sigsuspend',
  'read',
  '__read_nocancel',
]);

const frameRe = /^([ +!:|]*)(\d+)\s+(.+?)\s+\(in ([^)]+)\)/;

export function parseSample(text) {
  const start = text.indexOf('Call graph:');
  if (start === -1) return { totalSamples: 0, threads: [], hot: [] };
  const endIdx = text.indexOf('Total number in stack', start);
  const body = text.slice(start + 'Call graph:'.length, endIdx === -1 ? undefined : endIdx);
  const lines = body.split('\n');
  const threads = [];
  let current = null;
  const stack = [];

  const finish = () => {
    while (stack.length) closeFrame(stack.pop());
  };
  const closeFrame = (frame) => {
    const self = frame.count - frame.childCount;
    if (self > 0 && current) {
      const key = `${frame.symbol}\u0000${frame.module}`;
      current.self.set(key, (current.self.get(key) ?? 0) + self);
    }
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const threadMatch = raw.match(/^\s{4}(\d+)\s+(Thread_\d+.*)$/);
    if (threadMatch) {
      finish();
      const label = threadMatch[2].trim();
      const queue = label.match(/DispatchQueue_\d+:\s*([^\s(]+)/);
      const named = label.match(/Thread_\d+:\s*(.+)$/);
      current = {
        name: queue ? queue[1] : named ? named[1].trim() : label.split(/\s+/)[0],
        samples: Number(threadMatch[1]),
        self: new Map(),
      };
      threads.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.replace(/^\s{4}/, '');
    const m = line.match(frameRe);
    if (!m) continue;
    const depth = m[1].length;
    const frame = { depth, count: Number(m[2]), symbol: cleanSymbol(m[3]), module: m[4].trim(), childCount: 0 };
    while (stack.length && stack[stack.length - 1].depth >= depth) closeFrame(stack.pop());
    if (stack.length) stack[stack.length - 1].childCount += frame.count;
    stack.push(frame);
  }
  finish();

  const totalSamples = threads.reduce((a, t) => a + t.samples, 0);
  const hotMap = new Map();
  for (const t of threads) {
    for (const [key, count] of t.self) {
      const [symbol, module] = key.split('\u0000');
      if (IDLE_SYMBOLS.has(symbol)) continue;
      const k = `${symbol}\u0000${module}\u0000${t.name}`;
      hotMap.set(k, (hotMap.get(k) ?? 0) + count);
    }
  }
  const activeSamples = [...hotMap.values()].reduce((a, b) => a + b, 0);
  const hot = [...hotMap.entries()]
    .map(([k, self]) => {
      const [symbol, module, thread] = k.split('\u0000');
      return { symbol, module, thread, self, pctOfActive: activeSamples ? self / activeSamples : 0 };
    })
    .sort((a, b) => b.self - a.self)
    .slice(0, 25);

  return {
    totalSamples,
    activeSamples,
    threads: threads.map((t) => {
      let active = 0;
      for (const [key, count] of t.self) if (!IDLE_SYMBOLS.has(key.split('\u0000')[0])) active += count;
      return { name: t.name, samples: t.samples, activeSamples: active };
    }),
    hot,
  };
}

function cleanSymbol(s) {
  return demangle(s.replace(/\s+\+\s+\d+\s*$/, '').trim());
}
