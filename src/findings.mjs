import { formatBytes, formatMs, linearSlope, median } from './util.mjs';
import { markSummaries } from './interaction.mjs';
import { SEGMENTS } from './parse/trace.mjs';

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

  out.push(...interactionFindings(session));
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

const SEGMENT_ADVICE = {
  input: 'The main thread was busy when the input arrived. Break up long tasks that run around the interaction, or yield with scheduler.yield().',
  handlers: 'The event handlers themselves are slow. Do only what the next frame needs in the handler and defer the rest.',
  script: 'Script after the handlers (promise callbacks, timers) dominates. Move the heavy part off the main thread or split it across frames.',
  render: 'Style, layout and paint dominate. Render fewer nodes (virtualize long lists), avoid layout thrashing, and use content-visibility for off-screen content.',
  network: 'The interaction waits on the network. Prefetch on hover, cache the response, or show the result optimistically before it arrives.',
  idle: 'The main thread sat idle with no request in flight: a timer, debounce or animation delay holds the result back.',
  other: 'Main-thread work that is not script or rendering (IPC, loading). Record a DevTools trace of the same interaction to see the tasks.',
  frame: 'Work finished but the frame took long to reach the screen: compositing, raster or GPU. Check for large layers, filters or images decoded on demand.',
};

export function interactionFindings(session) {
  const out = [];
  const records = session.interactions ?? [];
  const web = new Map();
  for (const r of records) {
    if (r.kind !== 'web') continue;
    if (!web.has(r.label)) web.set(r.label, []);
    web.get(r.label).push(r);
  }
  for (const [label, runs] of web) {
    const ok = runs.filter((r) => r.available && r.slowest);
    if (!ok.length) {
      out.push({ id: 'interaction-unmeasured', severity: 'info', title: `Could not break down "${label}"`, evidence: [runs[runs.length - 1].reason ?? 'no breakdown'] });
      continue;
    }
    const worst = ok.reduce((m, r) => (r.totalMs > m.totalMs ? r : m), ok[0]);
    const seg = worst.slowest;
    const order = Object.keys(SEGMENTS);
    const parts = order.filter((k) => worst.totals[k] >= 0.5).map((k) => `${SEGMENTS[k]} ${formatMs(worst.totals[k])}`);
    const evidence = [
      `${worst.frameShown ? 'input → frame shown' : 'input → last main-thread work'} ${formatMs(worst.totalMs)}${ok.length > 1 ? ` (slowest of ${ok.length} runs; median ${formatMs(median(ok.map((r) => r.totalMs)))})` : ''}`,
      parts.join(' · '),
    ];
    if (seg.key === 'network' && worst.requests?.length) {
      const r = [...worst.requests].sort((a, b) => b.ms - a.ms)[0];
      evidence.push(`slowest request ${r.method ?? 'GET'} ${r.url} ${formatMs(r.ms)}${r.bytes != null ? `, ${formatBytes(r.bytes)}` : ''}`);
    }
    if (['handlers', 'script', 'input'].includes(seg.key) && worst.scripts?.length) {
      const sc = worst.scripts[0];
      evidence.push(`longest script ${sc.invoker} ${formatMs(sc.ms)}${sc.source ? ` at ${sc.source}` : ''}`);
    }
    if (seg.key === 'render' && worst.render) {
      evidence.push(`style ${formatMs(worst.render.styleMs)} · layout ${formatMs(worst.render.layoutMs)}${worst.render.layoutObjects ? ` over ${worst.render.layoutObjects} objects` : ''} · paint ${formatMs(worst.render.paintMs)}`);
    }
    if (worst.stacks?.available && worst.stacks.hot?.length) {
      const h = worst.stacks.hot.find((x) => !/^\(/.test(x.symbol)) ?? worst.stacks.hot[0];
      evidence.push(`hottest JS ${h.symbol}${h.source ? ` (${h.source})` : ''} ${formatMs(h.ms)}`);
    }
    const et = worst.eventTiming;
    if (et) evidence.push(`Event Timing ${formatMs(et.durationMs)} to next paint = ${formatMs(et.inputDelayMs)} input delay + ${formatMs(et.processingMs)} processing + ${formatMs(et.presentationDelayMs)} presentation`);
    out.push({
      id: 'interaction-slowest-segment',
      severity: worst.totalMs > 500 ? 'high' : worst.totalMs > 200 ? 'medium' : 'ok',
      title: `Slowest segment of "${label}" is ${seg.label}: ${formatMs(seg.ms)}`,
      metric: seg.ms,
      label,
      segment: seg.key,
      evidence,
      suggestion: worst.totalMs > 200 ? SEGMENT_ADVICE[seg.key] : undefined,
    });
  }

  for (const r of records) {
    if (r.kind !== 'native' || !r.stacks?.available) continue;
    const top = r.stacks.hot.filter((h) => h.symbol !== '???').slice(0, 3);
    if (!top.length) continue;
    out.push({
      id: 'interaction-hot-function',
      severity: top[0].pctOfActive >= 0.3 ? 'medium' : 'info',
      title: `${shortSymbol(top[0].symbol)} is the hottest function during "${r.label}"`,
      metric: top[0].pctOfActive,
      label: r.label,
      evidence: [
        ...top.map((h) => `${(h.pctOfActive * 100).toFixed(0)}% self · ${shortSymbol(h.symbol)} (${h.module}, ${h.thread})`),
        `call stacks sampled ${r.stacks.window} with ${r.stacks.tool}`,
      ],
    });
  }

  const measured = new Set(web.keys());
  const byLabel = new Map();
  for (const m of markSummaries((session.marks ?? []).filter((x) => x.source !== 'sherlock'), session.samples)) {
    if (measured.has(m.label)) continue;
    const prev = byLabel.get(m.label);
    if (!prev || m.busyMs > prev.busyMs) byLabel.set(m.label, m);
  }
  for (const [label, m] of byLabel) {
    if (m.busyMs < 250) continue;
    out.push({
      id: 'interaction-busy',
      severity: m.busyMs > 1000 ? 'high' : 'medium',
      title: `"${label}" keeps the CPU busy for ${formatMs(m.busyMs)}`,
      metric: m.busyMs,
      label,
      evidence: [
        `CPU ${m.cpuAvgPct.toFixed(0)}% average, ${m.cpuPeakPct.toFixed(0)}% peak while busy${m.settled ? '' : ' (had not settled when the window ended)'}`,
        m.rssDeltaBytes != null ? `memory ${formatBytes(m.rssBeforeBytes)} → peak ${formatBytes(m.rssPeakBytes)} → ${formatBytes(m.rssAfterBytes)}` : null,
        `from samples every ~${m.resolutionMs} ms, so the busy time is ± one sample`,
      ].filter(Boolean),
      suggestion: 'Mark it again with stacks (sherlock_mark stacks_seconds) to see which functions burn the time.',
    });
  }
  return out;
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
