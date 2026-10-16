export function parseProcStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close === -1) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 2).trim().split(/\s+/);
  return {
    pid,
    comm,
    state: rest[0],
    ppid: Number(rest[1]),
    utimeTicks: Number(rest[11]),
    stimeTicks: Number(rest[12]),
    numThreads: Number(rest[17]),
    startTimeTicks: Number(rest[19]),
    rssPages: Number(rest[21]),
  };
}

export function parseProcStatus(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) out[m[1]] = Number(m[2]) * 1024;
    const t = line.match(/^Threads:\s+(\d+)/);
    if (t) out.Threads = Number(t[1]);
    const n = line.match(/^Name:\s+(.*)$/);
    if (n) out.Name = n[1].trim();
  }
  return {
    name: out.Name,
    rssBytes: out.VmRSS ?? null,
    peakRssBytes: out.VmHWM ?? null,
    threads: out.Threads ?? null,
  };
}

export function parseProcIo(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return {
    readBytes: out.read_bytes ?? out.rchar ?? 0,
    writeBytes: out.write_bytes ?? out.wchar ?? 0,
  };
}

export function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const cols = m[2].trim().split(/\s+/).map(Number);
    if (cols.length < 9) continue;
    rx += cols[0];
    tx += cols[8];
  }
  return { bytesIn: rx, bytesOut: tx };
}

export function parsePerfInterval(line) {
  const cols = line.trim().split(',');
  if (cols.length < 4) return null;
  const time = Number(cols[0]);
  const count = cols[1] === '<not counted>' || cols[1] === '<not supported>' ? null : Number(cols[1]);
  const event = cols[3];
  if (Number.isNaN(time) || !event) return null;
  return { time, count, event };
}

export function perfBandwidth(events, cacheLineBytes = 64) {
  let lines = 0;
  let any = false;
  for (const e of events) {
    if (e.count == null) continue;
    if (/LLC-(load|store)-misses|cache-misses/.test(e.event)) {
      lines += e.count;
      any = true;
    }
  }
  return any ? lines * cacheLineBytes : null;
}
