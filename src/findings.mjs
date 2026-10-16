import { formatBytes, formatMs, linearSlope, median } from './util.mjs';

const MB = 1024 * 1024;

export function analyze(session) {
  const out = [];
  const add = (f) => out.push({ severity: 'info', ...f });
  const samples = session.samples ?? [];
  const startup = session.startup;
  const startupMs = startup?.readyMs ?? startup?.settledMs ?? null;

  if (startupMs != null && samples.length) {
    const window = samples.filter((s) => s.t <= startupMs && s.cpuPct != null);
    const avgCpu = window.length ? window.reduce((a, s) => a + s.cpuPct, 0) / window.length : null;
    const longest = [...(session.phases ?? [])].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    const severity = startupMs > 2000 ? 'high' : startupMs > 800 ? 'medium' : 'low';
    add({
      id: 'startup-total',
      severity,
      title: `Startup took ${formatMs(startupMs)}`,
      metric: startupMs,
      evidence: [
        startup.readySignal ? `ready signal: ${startup.readySignal}` : 'no ready signal given; measured to CPU settle',
        longest ? `longest phase: ${longest.name} (${formatMs(longest.end - longest.start)})` : null,
      ].filter(Boolean),
    });
    if (avgCpu != null && startupMs > 300) {
      if (avgCpu < 35) {
        add({
          id: 'startup-waiting',
          severity: startupMs > 1000 ? 'high' : 'medium',
          title: 'Startup is waiting, not computing',
          metric: avgCpu,
          evidence: [`average CPU during startup ${avgCpu.toFixed(0)}% of one core`],
          suggestion: 'Time is going to I/O, network, locks or sleeps. Look for blocking file reads, synchronous network calls or fixed timeouts before the first frame.',
        });
      } else if (avgCpu > 85) {
        add({
          id: 'startup-cpu-bound',
          severity: startupMs > 1000 ? 'high' : 'medium',
          title: 'Startup is CPU-bound',
          metric: avgCpu,
          evidence: [`average CPU during startup ${avgCpu.toFixed(0)}% of one core`],
          suggestion: 'Defer work that is not needed for the first frame, or move it off the main thread.',
        });
      }
    }
    const net = samples.filter((s) => s.t <= startupMs).reduce((a, s, i, arr) => {
      if (!i || s.netInBps == null) return a;
      return a + (s.netInBps + (s.netOutBps ?? 0)) * ((s.t - arr[i - 1].t) / 1000);
    }, 0);
    if (net > 50 * 1024) {
      add({
        id: 'startup-network',
        severity: 'medium',
        title: `Startup moved ${formatBytes(net)} over the network`,
        metric: net,
        evidence: ['network traffic before the app was ready'],
        suggestion: 'If the first screen waits on these requests, cache the last response or render before they finish.',
      });
    }
  }

  const stacks = session.stacks;
  if (stacks?.available && stacks.hot?.length) {
    const top = stacks.hot.filter((h) => h.symbol !== '???').slice(0, 3);
    const first = top[0];
    if (first && first.pctOfActive >= 0.1) {
      add({
        id: 'hot-function',
        severity: first.pctOfActive >= 0.3 ? 'high' : 'medium',
        title: `${shortSymbol(first.symbol)} is the hottest function`,
        metric: first.pctOfActive,
        evidence: top.map((h) => `${(h.pctOfActive * 100).toFixed(0)}% self · ${shortSymbol(h.symbol)} (${h.module}, ${h.thread})`),
        suggestion: first.thread.includes('main') ? 'It runs on the main thread. Move it off, make it lazy, or cache its result.' : undefined,
      });
    }
    const main = stacks.threads?.find((t) => /main/.test(t.name));
    if (main && stacks.activeSamples && main.activeSamples / stacks.activeSamples > 0.7) {
      add({
        id: 'main-thread-bound',
        severity: 'medium',
        title: 'Most work runs on the main thread',
        metric: main.activeSamples / stacks.activeSamples,
        evidence: [`${((main.activeSamples / stacks.activeSamples) * 100).toFixed(0)}% of busy samples are on ${main.name}`],
        suggestion: 'Other threads are mostly idle. Parallelize or defer the main-thread work.',
      });
    }
  }

  const leak = interactionLeak(session);
  if (leak) out.push(leak);

  const steady = samples.filter((s) => startupMs == null || s.t > startupMs + 1000);
  if (steady.length >= 8) {
    const pts = steady.filter((s) => s.rssBytes != null).map((s) => [s.t / 60000, s.rssBytes]);
    const slope = linearSlope(pts);
    const spanMin = (pts[pts.length - 1][0] - pts[0][0]) || 0;
    if (slope > 2 * MB && spanMin > 0.15 && !leak) {
      add({
        id: 'memory-growth',
        severity: slope > 20 * MB ? 'high' : 'medium',
        title: `Memory grows ${formatBytes(slope)}/min`,
        metric: slope,
        evidence: [`resident memory from ${formatBytes(pts[0][1])} to ${formatBytes(pts[pts.length - 1][1])}`],
        suggestion: 'Take two heap snapshots a minute apart and diff what was allocated in between.',
      });
    }
    const quiet = steady.filter((s) => s.cpuPct != null).map((s) => s.cpuPct);
    const idle = median(quiet);
    if (idle != null && (session.marks?.length ?? 0) === 0) {
      if (idle < 1.5) {
        add({ id: 'idle-clean', severity: 'ok', title: 'Idle is clean', metric: idle, evidence: [`median CPU at rest ${idle.toFixed(1)}%`] });
      } else if (idle > 5) {
        add({
          id: 'idle-busy',
          severity: idle > 20 ? 'high' : 'medium',
          title: `The app burns ${idle.toFixed(0)}% CPU while idle`,
          metric: idle,
          evidence: [`median CPU after startup ${idle.toFixed(1)}%`],
          suggestion: 'Look for polling loops, timers, animations that never stop, or busy-waiting threads.',
        });
      }
    }
  }

  const peakRss = samples.reduce((m, s) => Math.max(m, s.rssBytes ?? 0), 0);
  if (peakRss > 1024 * MB) {
    add({ id: 'memory-peak', severity: 'medium', title: `Peak memory ${formatBytes(peakRss)}`, metric: peakRss, evidence: ['across the process tree'] });
  }

  if (session.web) out.push(...webFindings(session.web));
  if (session.mobile) out.push(...mobileFindings(session.mobile));

  const order = { high: 0, medium: 1, low: 2, info: 3, ok: 4 };
  return out.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
}

export function interactionLeak(session) {
  const marks = session.marks ?? [];
  const samples = (session.samples ?? []).filter((s) => s.rssBytes != null);
  if (marks.length < 2 || samples.length < 4) return null;
  const byLabel = new Map();
  for (const m of marks) {
    if (!byLabel.has(m.label)) byLabel.set(m.label, []);
    byLabel.get(m.label).push(m);
  }
  let worst = null;
  for (const [label, ms] of byLabel) {
    if (ms.length < 2) continue;
    const before = (t) => [...samples].reverse().find((s) => s.t < t - 100)?.rssBytes;
    const settledAfter = (t, next) => {
      const from = next != null ? Math.max(t + 300, next - 1500) : t + 300;
      const win = samples.filter((s) => s.t > from && s.t < (next ?? Infinity));
      return win.length ? median(win.map((s) => s.rssBytes)) : null;
    };
    const deltas = [];
    const sorted = [...ms].sort((a, b) => a.t - b.t);
    const allSorted = [...marks].sort((a, b) => a.t - b.t);
    for (const m of sorted) {
      const next = allSorted.find((x) => x.t > m.t)?.t;
      const b = before(m.t);
      const a = settledAfter(m.t, next);
      if (b != null && a != null) deltas.push(a - b);
    }
    if (deltas.length < 2) continue;
    const typical = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const positive = deltas.filter((d) => d > 0.5 * MB).length;
    if (typical > 1 * MB && positive >= Math.ceil(deltas.length * 0.5)) {
      if (!worst || typical > worst.metric) {
        worst = {
          id: 'interaction-leak',
          severity: typical > 5 * MB ? 'high' : 'medium',
          title: `Every "${label}" keeps about ${formatBytes(typical)}`,
          metric: typical,
          evidence: [
            `${positive} of ${deltas.length} "${label}" kept memory; ${formatBytes(deltas.reduce((a, b) => a + b, 0))} retained in total`,
            `per interaction: ${deltas.slice(-8).map((d) => formatBytes(d)).join(', ')}${deltas.length > 8 ? ' (last 8)' : ''}`,
          ],
          suggestion: 'Memory rises after this interaction and does not come back. Check caches, listeners and lists that hold onto what it creates.',
        };
      }
    }
  }
  return worst;
}

function webFindings(web) {
  const out = [];
  const v = web.vitals ?? {};
  if (v.lcpMs != null) {
    out.push({
      id: 'web-lcp',
      severity: v.lcpMs > 4000 ? 'high' : v.lcpMs > 2500 ? 'medium' : 'ok',
      title: `Largest contentful paint ${formatMs(v.lcpMs)}`,
      metric: v.lcpMs,
      evidence: [`TTFB ${formatMs(v.ttfbMs)} · FCP ${formatMs(v.fcpMs)} · load ${formatMs(v.loadMs)}`],
      suggestion: v.lcpMs > 2500 ? 'Good is under 2.5 s. Preload the LCP image or font and cut render-blocking scripts.' : undefined,
    });
  }
  if (v.ttfbMs != null && v.ttfbMs > 800) {
    out.push({ id: 'web-ttfb', severity: 'medium', title: `Server took ${formatMs(v.ttfbMs)} to first byte`, metric: v.ttfbMs, evidence: ['time to first byte over 800 ms'] });
  }
  if (web.longTasks?.totalMs > 200) {
    out.push({
      id: 'web-long-tasks',
      severity: web.longTasks.totalMs > 600 ? 'high' : 'medium',
      title: `${formatMs(web.longTasks.totalMs)} of main-thread long tasks`,
      metric: web.longTasks.totalMs,
      evidence: [`${web.longTasks.count} tasks over 50 ms during load`],
      suggestion: 'Split long scripts, defer non-critical JS, and check hydration cost.',
    });
  }
  if (web.transfer?.bytes > 2 * MB) {
    out.push({ id: 'web-weight', severity: 'medium', title: `Page weighs ${formatBytes(web.transfer.bytes)}`, metric: web.transfer.bytes, evidence: [`${web.transfer.requests} requests`] });
  }
  return out;
}

function mobileFindings(m) {
  const out = [];
  if (m.os === 'android' && m.totalTimeMs != null) {
    out.push({
      id: 'android-start',
      severity: m.totalTimeMs > 5000 ? 'high' : m.totalTimeMs > 1500 ? 'medium' : 'ok',
      title: `${m.launchState ?? 'Cold'} start ${formatMs(m.totalTimeMs)} to first frame`,
      metric: m.totalTimeMs,
      evidence: [`am start -W TotalTime ${m.totalTimeMs} ms`],
      suggestion: m.totalTimeMs > 1500 ? 'Android vitals treats a cold start of 5 s or more as excessive. Look at Application.onCreate and the first Activity.' : undefined,
    });
  }
  if (m.os === 'ios' && m.launchMs != null) {
    out.push({
      id: 'ios-start',
      severity: m.launchMs > 2000 ? 'high' : m.launchMs > 400 ? 'medium' : 'ok',
      title: `Launch took ${formatMs(m.launchMs)} in the simulator`,
      metric: m.launchMs,
      evidence: ['measured from simctl launch to the process going quiet', 'simulator timing runs on the Mac CPU, so treat it as relative'],
    });
  }
  return out;
}

function shortSymbol(s) {
  const noArgs = s.replace(/\(.*\)\s*(const)?$/, '');
  return noArgs.length > 70 ? `…${noArgs.slice(-69)}` : noArgs;
}
