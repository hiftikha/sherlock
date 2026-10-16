import { median } from './util.mjs';
import { sampleStacks } from './stacks.mjs';

const BUSY_CPU_PCT = 8;

/**
 * Per-interaction CPU and memory from the live samples: for each mark, how
 * long the process tree stayed busy afterwards, its CPU while busy, and memory
 * before, at the peak and once it settled. The window ends at the next mark,
 * after maxMs, or when the CPU has been quiet for settleMs.
 */
export function markSummaries(marks = [], samples = [], { maxMs = 10000, settleMs = 500, busyPct = BUSY_CPU_PCT } = {}) {
  const sortedMarks = [...marks].sort((a, b) => a.t - b.t);
  const lastT = samples.length ? samples[samples.length - 1].t : null;
  const out = [];
  for (let i = 0; i < sortedMarks.length; i++) {
    const m = sortedMarks[i];
    const next = sortedMarks[i + 1]?.t ?? Infinity;
    const end = Math.min(next, m.t + maxMs, lastT ?? -Infinity);
    const win = samples.filter((s) => s.t > m.t && s.t <= end);
    const cpu = win.filter((s) => s.cpuPct != null);
    if (cpu.length < 2) continue;
    let lastBusy = null;
    let calmSince = null;
    let settled = false;
    for (const s of cpu) {
      if (s.cpuPct >= busyPct) {
        lastBusy = s.t;
        calmSince = null;
      } else {
        calmSince ??= s.t;
        if (s.t - calmSince >= settleMs) {
          settled = true;
          break;
        }
      }
    }
    const busyEnd = lastBusy ?? m.t;
    const busySamples = cpu.filter((s) => s.t <= busyEnd);
    const stats = busySamples.length ? busySamples : cpu.slice(0, 1);
    const rss = win.filter((s) => s.rssBytes != null);
    const before = [...samples].reverse().find((s) => s.t < m.t - 100 && s.rssBytes != null) ?? [...samples].reverse().find((s) => s.t <= m.t && s.rssBytes != null);
    const settleT = settled ? calmSince + settleMs : end;
    const after = [...rss].reverse().find((s) => s.t <= settleT) ?? rss[rss.length - 1];
    const gaps = cpu.slice(1).map((s, k) => s.t - cpu[k].t);
    out.push({
      label: m.label,
      t: m.t,
      windowMs: Math.round(end - m.t),
      busyMs: Math.round(busyEnd - m.t),
      settled,
      cpuAvgPct: Math.round((stats.reduce((a, s) => a + s.cpuPct, 0) / stats.length) * 10) / 10,
      cpuPeakPct: Math.round(Math.max(...stats.map((s) => s.cpuPct)) * 10) / 10,
      rssBeforeBytes: before?.rssBytes ?? null,
      rssPeakBytes: rss.length ? Math.max(...rss.map((s) => s.rssBytes)) : null,
      rssAfterBytes: after?.rssBytes ?? null,
      rssDeltaBytes: before && after ? after.rssBytes - before.rssBytes : null,
      samples: win.length,
      resolutionMs: gaps.length ? Math.round(median(gaps)) : null,
    });
  }
  return out;
}

/**
 * Sample call stacks of the session's process for `seconds` right after a
 * mark, in the background. The result lands in session.interactions.
 */
export function captureMarkStacks(session, mark, seconds = 2) {
  const pid = session.meta?.pid ?? session.mobile?.pid;
  const record = { kind: 'native', label: mark.label, t: mark.t, input: 'marked', stacks: null };
  if (!pid) {
    record.stacks = { available: false, reason: 'This session has no local process to sample.' };
    session.addInteraction(record);
    return Promise.resolve(record);
  }
  return sampleStacks(pid, seconds).then(
    (result) => {
      record.stacks = { window: `${(mark.t / 1000).toFixed(1)}s–${((mark.t + seconds * 1000) / 1000).toFixed(1)}s`, ...result };
      record.summary = markSummaries([mark], session.samples, { maxMs: seconds * 1000 })[0] ?? null;
      session.addInteraction(record);
      return record;
    },
    (err) => {
      record.stacks = { available: false, reason: err.message };
      session.addInteraction(record);
      return record;
    },
  );
}
