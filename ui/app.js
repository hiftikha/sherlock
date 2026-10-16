const NUMBER_FLOW = 'https://cdn.jsdelivr.net/npm/number-flow@0.6.2/+esm';
let flow = false;
try {
  await import(NUMBER_FLOW);
  flow = !!customElements.get('number-flow');
} catch {
  flow = false;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let S = null;
let view = 'all';
let booted = false;
let renderQueued = false;

function bytesParts(b) {
  if (b == null) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: v, digits: v >= 100 || i === 0 ? 0 : 1, suffix: ` ${units[i]}` };
}

function msParts(ms) {
  if (ms == null) return null;
  if (ms >= 1000) return { value: ms / 1000, digits: 2, suffix: 's' };
  return { value: Math.round(ms), digits: 0, suffix: 'ms' };
}

function pctParts(p) {
  return p == null ? null : { value: p, digits: 0, suffix: '%' };
}

function rateParts(bps) {
  const b = bytesParts(bps);
  return b ? { ...b, suffix: `${b.suffix}/s` } : null;
}

function setNumber(host, parts) {
  if (!parts) {
    host.textContent = '—';
    host.classList.add('na');
    return;
  }
  host.classList.remove('na');
  if (flow) {
    let el = host.querySelector('number-flow');
    if (!el) {
      host.textContent = '';
      el = document.createElement('number-flow');
      host.append(el);
    }
    el.format = { minimumFractionDigits: parts.digits, maximumFractionDigits: parts.digits, useGrouping: false };
    el.numberSuffix = parts.suffix;
    el.update(Number(parts.value.toFixed(parts.digits)));
  } else {
    host.textContent = `${parts.value.toFixed(parts.digits)}${parts.suffix}`;
  }
}

const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const fmtBytes = (b) => {
  const p = bytesParts(b);
  return p ? `${p.value.toFixed(p.digits)}${p.suffix}` : '—';
};

function last(arr, key) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i][key] != null) return arr[i][key];
  return null;
}

function peak(arr, key) {
  let m = null;
  for (const s of arr) if (s[key] != null && (m == null || s[key] > m)) m = s[key];
  return m;
}

function startupMs() {
  return S?.startup?.readyMs ?? S?.startup?.settledMs ?? null;
}

function windowRange() {
  const samples = S.samples;
  const lastT = samples.length ? samples[samples.length - 1].t : 0;
  const end = Math.max(lastT, S.summary?.durationMs && !S.live ? Math.min(S.summary.durationMs, lastT || S.summary.durationMs) : lastT, 1000);
  if (view === 'live') return [end - 60000, end];
  const st = startupMs();
  if (view === 'startup' && st != null) {
    const phaseEnd = Math.max(st, ...(S.phases ?? []).map((p) => p.end));
    return [0, Math.max(phaseEnd * 1.35, 500)];
  }
  return [0, end * 1.02];
}

function renderMeta() {
  const short = String(S.target ?? '')
    .split(' ')
    .map((w) => (w.includes('/') && !/^https?:/.test(w) ? w.split('/').pop() : w))
    .join(' ');
  const parts = [`<b>${esc(short)}</b>`, esc(S.kind), esc(S.platform)];
  if (S.mobile?.pid || S.meta?.pid) parts.push(`pid ${S.mobile?.pid ?? S.meta.pid}`);
  if (S.meta?.device) parts.push(esc(S.meta.device));
  $('meta').innerHTML = parts.join(' · ');
  const st = $('status');
  const running = S.live && (S.status === 'running' || S.status === 'starting');
  st.className = `status mono ${running ? 'live' : 'done'}`;
  st.querySelector('span').textContent = running ? `LIVE · ${fmtClock(S.samples.at(-1)?.t ?? 0)}` : `${(S.status ?? 'report').toUpperCase()} · ${fmtClock(S.summary?.durationMs ?? 0)}`;
  $('stop').disabled = !running;
  $('mark-label').disabled = !S.live;
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderHero() {
  const st = startupMs();
  const samples = S.samples;
  if (st != null && view !== 'live') {
    $('hero-label').textContent = S.kind === 'web' ? 'Navigation → largest contentful paint' : S.kind === 'android' ? 'Cold start → first frame' : `Launch → ${S.startup.readySignal ? 'ready' : 'idle'}`;
    setNumber($('hero-num'), msParts(st));
    const d = $('hero-delta');
    d.textContent = S.startup.readySignal ? `signal: ${S.startup.readySignal}` : '';
    d.className = 'hero-delta mono';
  } else {
    $('hero-label').textContent = /footprint/.test(S.capabilities?.memory ?? '') ? 'Memory footprint' : 'Resident memory';
    setNumber($('hero-num'), bytesParts(last(samples, 'rssBytes')));
    const leak = (S.findings ?? []).find((f) => f.id === 'interaction-leak' || f.id === 'memory-growth');
    const d = $('hero-delta');
    d.textContent = leak ? leak.title : `peak ${fmtBytes(peak(samples, 'rssBytes'))}`;
    d.className = `hero-delta mono ${leak ? 'bad' : ''}`;
  }
  const kpis = [
    ['cpu', 'CPU', pctParts(last(samples, 'cpuPct'))],
    ['mem', 'Memory', bytesParts(last(samples, 'rssBytes'))],
    ['bw', 'Mem BW', rateParts(last(samples, 'memBandwidthBps'))],
    ['gpu', 'GPU', pctParts(last(samples, 'gpuPct'))],
    ['net', 'Net', rateParts((last(samples, 'netInBps') ?? 0) + (last(samples, 'netOutBps') ?? 0) || (last(samples, 'netInBps') == null ? null : 0))],
    ['thr', 'Threads', last(samples, 'threads') == null ? null : { value: last(samples, 'threads'), digits: 0, suffix: '' }],
  ];
  const host = $('kpis');
  if (!host.children.length) {
    host.innerHTML = kpis.map(([k, label]) => `<div class="kpi ${k}"><span class="label mono">${label}</span><span class="v" data-k="${k}"></span></div>`).join('');
  }
  for (const [k, , parts] of kpis) setNumber(host.querySelector(`[data-k="${k}"]`), parts);
}

const LANES = [
  { key: 'cpuPct', title: 'CPU', color: 'var(--amber)', fill: true, sub: (s) => `${fmtPct(peak(s, 'cpuPct'))} peak`, cap: 'cpu', max: (v) => Math.max(100, v) },
  { key: 'rssBytes', title: 'Memory', color: 'var(--ice)', fill: true, sub: (s) => `${fmtBytes(last(s, 'rssBytes'))} · peak ${fmtBytes(peak(s, 'rssBytes'))}`, cap: 'memory', floor: true },
  { key: 'memBandwidthBps', title: 'Memory bandwidth', color: 'var(--soft)', sub: (s) => `${fmtBytes(peak(s, 'memBandwidthBps'))}/s peak`, cap: 'memBandwidth' },
  { key: 'gpuPct', title: 'GPU', color: 'var(--soft)', sub: (s) => `${fmtPct(peak(s, 'gpuPct'))} peak · whole GPU`, cap: 'gpu', max: () => 100 },
  { key: 'net', title: 'Network', color: 'var(--soft)', sub: (s) => `${fmtBytes(peak(s, 'net'))}/s peak`, cap: 'network' },
];

const fmtPct = (p) => (p == null ? '—' : `${p.toFixed(0)}%`);

function renderAxis(w0, w1) {
  const span = w1 - w0;
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  const step = steps.find((s) => span / s <= 6) ?? 600000;
  const ticks = [];
  for (let t = Math.ceil(Math.max(w0, view === 'live' ? w0 : 0) / step) * step; t <= w1; t += step) {
    const x = ((t - w0) / span) * 100;
    const label = view === 'live' ? (w1 - t < step / 2 ? 'now' : `−${((w1 - t) / 1000).toFixed(0)}s`) : t >= 1000 ? `${(t / 1000).toFixed(step < 1000 ? 1 : 0)}s` : `${t}ms`;
    ticks.push(`<span class="tick" style="left:${x}%">${label}</span>`);
  }
  $('axis').innerHTML = ticks.join('');
}

function chartPath(points, w0, w1, max, floorVal, width, height) {
  if (points.length < 2) return null;
  const span = w1 - w0 || 1;
  const top = 4;
  const usable = height - top - 2;
  const minV = floorVal ?? 0;
  const range = Math.max(max - minV, 1e-9);
  const xy = points.map(([t, v]) => [((t - w0) / span) * width, top + usable - ((v - minV) / range) * usable]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy.at(-1)[0].toFixed(1)} ${height} L${xy[0][0].toFixed(1)} ${height} Z`;
  return { line, area };
}

function renderLanes(w0, w1) {
  const lanes = $('lanes');
  const width = lanes.clientWidth - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label')) || 800;
  const samples = S.samples.map((s) => ({ ...s, net: s.netInBps == null ? null : s.netInBps + (s.netOutBps ?? 0) }));
  const visible = samples.filter((s) => s.t >= w0 - 2000 && s.t <= w1);
  const html = [];
  const span = w1 - w0 || 1;
  const pct = (t) => `${(((t - w0) / span) * 100).toFixed(3)}%`;

  if (S.phases?.length && view !== 'live') {
    const longest = [...S.phases].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    const blocks = S.phases
      .filter((p) => p.end > p.start)
      .map((p) => {
        const wpct = ((p.end - p.start) / span) * 100;
        const crit = p === longest && S.phases.length > 1;
        return `<div class="phase mono ${crit ? 'crit' : ''}" style="left:${pct(p.start)};width:${wpct.toFixed(3)}%" title="${esc(p.name)} ${fmtMs(p.end - p.start)}"><span>${wpct > 6 ? esc(p.name) : ''}</span><span>${wpct > 12 ? fmtMs(p.end - p.start) : ''}</span></div>`;
      });
    html.push(`<div class="lane-row lane-phases rule"><div class="lane-label"><div class="t">Startup phases</div><div class="s mono">${fmtMs(startupMs())} total</div></div><div class="lane-track">${blocks.join('')}</div></div>`);
  }

  const marks = (S.marks ?? []).filter((m) => m.t >= w0 && m.t <= w1);
  const trackPx = Math.max(1, width);
  let lastPx = -Infinity;
  const pills = marks.map((m) => {
    const w = 26 + m.label.length * 7;
    const at = ((m.t - w0) / span) * trackPx;
    const left = (m.t - w0) / span > 0.85 ? at - w : at;
    const dense = left < lastPx;
    if (!dense) lastPx = left + w;
    return { m, dense };
  });
  html.push(
    `<div class="lane-row lane-marks rule"><div class="lane-label"><div class="t">Interactions</div><div class="s mono">${(S.marks ?? []).length} marked</div></div><div class="lane-track">${pills
      .filter(({ dense }) => !dense)
      .map(({ m, dense }) => `<div class="pill mono ${m.source === 'sherlock' ? '' : 'user'} ${dense ? 'dense' : ''} ${(m.t - w0) / span > 0.85 ? 'flip' : ''}" style="left:${pct(m.t)}" title="${esc(m.label)} @ ${fmtMs(m.t)}">${dense ? '' : esc(m.label)}</div>`)
      .join('')}</div></div>`,
  );

  for (const lane of LANES) {
    const caps = S.capabilities ?? {};
    const pts = visible.filter((s) => s[lane.key] != null).map((s) => [s.t, s[lane.key]]);
    const unavailable = caps[lane.cap] === null && !pts.length;
    let body;
    if (unavailable) {
      const reason = lane.cap === 'memBandwidth' ? caps.memBandwidthReason : 'not available for this target';
      body = `<div class="unavailable mono">unavailable · ${esc(reason ?? '')}</div>`;
    } else if (pts.length < 2) {
      body = `<div class="unavailable mono">${S.live ? 'waiting for samples…' : 'no data'}</div>`;
    } else {
      const hi = Math.max(...pts.map((p) => p[1]));
      const lo = lane.floor ? Math.min(...pts.map((p) => p[1])) * 0.92 : 0;
      const max = lane.max ? lane.max(hi) : hi * 1.1 || 1;
      const p = chartPath(pts, w0, w1, max, lo, width, 52);
      body = `<svg viewBox="0 0 ${width} 52" preserveAspectRatio="none">${lane.fill ? `<path d="${p.area}" fill="${lane.color}" fill-opacity=".15"/>` : ''}<path d="${p.line}" fill="none" stroke="${lane.color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
    }
    html.push(`<div class="lane-row lane-chart"><div class="lane-label"><div class="t">${lane.title}</div><div class="s mono">${esc(lane.sub(samples))}</div></div><div class="lane-track">${body}</div></div>`);
  }
  lanes.innerHTML = html.join('');

  const overlay = [];
  const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label')) || 148;
  const trackW = lanes.clientWidth - labelW;
  const x = (t) => labelW + ((t - w0) / span) * trackW;
  const phasesH = S.phases?.length && view !== 'live' ? 56 : 0;
  for (const m of marks) overlay.push(`<div class="vline ${m.source === 'sherlock' ? '' : 'user'}" style="left:${x(m.t)}px;top:${28 + phasesH + 12}px"></div>`);
  const st = startupMs();
  if (st != null && st >= w0 && st <= w1) overlay.push(`<div class="vline ready" data-label="${S.kind === 'web' ? 'LCP' : 'READY'} ${fmtMs(st)}" style="left:${x(st)}px"></div>`);
  $('overlay').innerHTML = overlay.join('');
}

function renderPanels() {
  const out = [];
  const stacks = S.stacks;
  if (stacks?.available && stacks.hot?.length) {
    const rows = stacks.hot.slice(0, 12).map(
      (h) => `<tr><td class="sym">${esc(h.symbol)}<div class="bar" style="width:${Math.max(2, h.pctOfActive * 100).toFixed(1)}%"></div></td><td class="dim">${esc(h.module)}</td><td class="dim">${esc(h.thread)}</td><td class="num">${(h.pctOfActive * 100).toFixed(1)}%</td></tr>`,
    );
    out.push(`<div class="panel"><h3>Where the ${stacks.window === 'startup' ? 'startup' : 'CPU'} time went <span class="mono muted small">${esc(stacks.tool)} · ${stacks.activeSamples} busy of ${stacks.totalSamples} samples</span></h3><table><thead><tr><th>Function (self time)</th><th>Module</th><th>Thread</th><th style="text-align:right">Busy</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
  } else if (stacks && !stacks.available) {
    out.push(`<div class="panel"><h3>Call stacks <span class="mono muted small">${esc(stacks.reason ?? 'unavailable')}</span></h3></div>`);
  }
  if (S.web) {
    const v = S.web.vitals ?? {};
    const grade = (val, good, poor) => (val == null ? '' : val <= good ? 'good' : val <= poor ? 'warn' : 'bad');
    const cell = (label, val, g, fmt = fmtMs) => `<div class="vital ${g}"><span class="label mono">${label}</span><span class="v">${val == null ? '—' : fmt(val)}</span></div>`;
    out.push(
      `<div class="panel"><h3>Page load <span class="mono muted small">${esc(S.web.url)}</span></h3><div class="vitals">${cell('TTFB', v.ttfbMs, grade(v.ttfbMs, 800, 1800))}${cell('FCP', v.fcpMs, grade(v.fcpMs, 1800, 3000))}${cell('LCP', v.lcpMs, grade(v.lcpMs, 2500, 4000))}${cell('CLS', v.cls, grade(v.cls, 0.1, 0.25), (c) => c.toFixed(3))}${cell('Long tasks', S.web.longTasks?.totalMs, grade(S.web.longTasks?.totalMs, 200, 600))}${cell('JS heap', S.web.runtime?.jsHeapUsedBytes, '', fmtBytes)}</div>${
        S.web.slowest?.length
          ? `<table><thead><tr><th>Slowest requests</th><th style="text-align:right">Time</th><th style="text-align:right">Bytes</th></tr></thead><tbody>${S.web.slowest.map((r) => `<tr><td class="sym">${esc(r.name)}</td><td class="num">${fmtMs(r.ms)}</td><td class="num">${fmtBytes(r.bytes)}</td></tr>`).join('')}</tbody></table>`
          : ''
      }</div>`,
    );
  }
  if (S.mobile) {
    const m = S.mobile;
    const rows = Object.entries(m)
      .filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => `<tr><td class="dim">${esc(k)}</td><td class="sym">${esc(v)}</td></tr>`);
    out.push(`<div class="panel"><h3>${m.os === 'ios' ? 'iOS Simulator' : 'Android'} launch</h3><table><tbody>${rows.join('')}</tbody></table></div>`);
  }
  const procs = S.samples.at(-1)?.processes;
  if (procs?.length) {
    const rows = [...procs].sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0)).slice(0, 12);
    out.push(`<div class="panel"><h3>Process tree <span class="mono muted small">${procs.length} process${procs.length === 1 ? '' : 'es'}</span></h3><table><thead><tr><th>PID</th><th>Command</th><th style="text-align:right">Memory</th><th style="text-align:right">CPU time</th></tr></thead><tbody>${rows.map((p) => `<tr><td class="dim">${p.pid}</td><td class="sym">${esc(p.command)}</td><td class="num">${fmtBytes(p.rssBytes)}</td><td class="num">${(p.cpuSeconds ?? 0).toFixed(2)}s</td></tr>`).join('')}</tbody></table></div>`);
  }
  if (S.output?.length) {
    out.push(`<div class="panel"><h3>Output <span class="mono muted small">last ${S.output.length} lines</span></h3><pre class="out">${S.output.map((l) => `${String(l.t).padStart(6)}ms  ${esc(l.text)}`).join('\n')}</pre></div>`);
  }
  $('panels').innerHTML = out.join('');
}

function renderRail() {
  const findings = S.findings ?? [];
  const notes = S.notes ?? [];
  $('rail-count').textContent = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  const headline = notes.at(-1)?.title || findings.find((f) => f.severity !== 'ok')?.title || (S.live ? 'Watching…' : 'Nothing stands out.');
  $('headline').textContent = headline;
  $('notes').innerHTML = notes
    .slice(-3)
    .reverse()
    .map((n) => `<div class="note"><div class="title">${esc(n.title)}</div>${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}</div>`)
    .join('');
  $('findings').innerHTML = findings
    .map(
      (f, i) => `<li class="finding ${esc(f.severity)}"><div class="n mono">${String(i + 1).padStart(2, '0')}</div><div class="b"><div class="title">${esc(f.title)}</div>${
        f.evidence?.length ? `<div class="ev mono">${f.evidence.map(esc).join('<br>')}</div>` : ''
      }${f.suggestion ? `<div class="sug">${esc(f.suggestion)}</div>` : ''}</div></li>`,
    )
    .join('');
  const caps = S.capabilities ?? {};
  const missing = Object.entries(caps).filter(([k, v]) => v === null && !k.endsWith('Reason')).map(([k]) => k);
  $('caps').textContent = missing.length ? `Not measured on this target: ${missing.join(', ')}.` : '';
}

function render() {
  renderQueued = false;
  if (!S) return;
  const [w0, w1] = windowRange();
  renderMeta();
  renderHero();
  renderAxis(w0, w1);
  renderLanes(w0, w1);
  renderPanels();
  renderRail();
}

function schedule() {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
}

function connect() {
  if (window.__SHERLOCK__) {
    S = window.__SHERLOCK__;
    S.notes ??= [];
    if (S.startup) setView('startup');
    render();
    return;
  }
  const es = new EventSource('api/stream');
  es.addEventListener('session', (e) => {
    S = JSON.parse(e.data);
    if (!booted) {
      booted = true;
      const fromHash = location.hash.slice(1);
      if (['live', 'all', 'startup'].includes(fromHash)) setView(fromHash);
      else if (S.live && S.kind === 'attach') setView('live');
      else if (S.startup && S.kind !== 'attach') setView('startup');
    }
    schedule();
  });
  es.addEventListener('sample', (e) => {
    if (!S) return;
    S.samples.push(JSON.parse(e.data));
    schedule();
  });
  es.addEventListener('mark', (e) => {
    S?.marks.push(JSON.parse(e.data));
    schedule();
  });
  es.addEventListener('phase', (e) => {
    S?.phases.push(JSON.parse(e.data));
    schedule();
  });
  es.addEventListener('findings', (e) => {
    if (S) S.findings = JSON.parse(e.data);
    schedule();
  });
  es.addEventListener('status', (e) => {
    if (S) S.status = JSON.parse(e.data);
    schedule();
  });
  es.addEventListener('stacks', (e) => {
    if (S) S.stacks = JSON.parse(e.data);
    schedule();
  });
  es.addEventListener('note', (e) => {
    S?.notes.push(JSON.parse(e.data));
    schedule();
  });
  es.onerror = () => {
    const st = $('status');
    if (S && S.status === 'running') st.querySelector('span').textContent = 'RECONNECTING';
  };
  setInterval(async () => {
    if (!S?.live || S.status !== 'running') return;
    try {
      const fresh = await (await fetch('api/session')).json();
      S.findings = fresh.findings;
      S.startup = fresh.startup;
      S.summary = fresh.summary;
      S.capabilities = fresh.capabilities;
      schedule();
    } catch {}
  }, 3000);
}

function setView(v) {
  view = v;
  try {
    history.replaceState(null, '', `#${v}`);
  } catch {}
  $('view-startup').classList.toggle('on', v === 'startup');
  $('view-all').classList.toggle('on', v === 'all');
  $('view-live').classList.toggle('on', v === 'live');
  schedule();
}

function setRail(open) {
  $('rail').classList.toggle('closed', !open);
  $('rail-toggle').setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem('sherlock.rail', open ? 'open' : 'closed');
  } catch {}
  setTimeout(schedule, 260);
}

$('view-startup').onclick = () => setView('startup');
$('view-all').onclick = () => setView('all');
$('view-live').onclick = () => setView('live');
$('rail-toggle').onclick = () => setRail($('rail').classList.contains('closed'));
try {
  if (localStorage.getItem('sherlock.rail') === 'closed') setRail(false);
} catch {}

$('mark-form').onsubmit = async (e) => {
  e.preventDefault();
  const label = $('mark-label').value.trim() || 'interaction';
  $('mark-label').value = '';
  await fetch('api/mark', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
};
$('stop').onclick = () => fetch('api/stop', { method: 'POST' });
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sherlock-${S?.id ?? 'report'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ']') setRail($('rail').classList.contains('closed'));
  if (e.key === 'm' && S?.live) {
    e.preventDefault();
    setRail(true);
    $('mark-label').focus();
  }
});

const timeline = $('timeline');
timeline.addEventListener('mousemove', (e) => {
  if (!S?.samples.length) return;
  const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label')) || 148;
  const rect = timeline.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < labelW) return ($('cursor').hidden = true);
  const [w0, w1] = windowRange();
  const t = w0 + ((x - labelW) / (rect.width - labelW)) * (w1 - w0);
  let best = S.samples[0];
  for (const s of S.samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  const cur = $('cursor');
  cur.hidden = false;
  cur.style.left = `${x}px`;
  const tip = $('cursor-tip');
  tip.textContent = [
    `t   ${fmtMs(best.t)}`,
    `cpu ${fmtPct(best.cpuPct)}`,
    `mem ${fmtBytes(best.rssBytes)}`,
    best.gpuPct != null ? `gpu ${fmtPct(best.gpuPct)}` : null,
    best.memBandwidthBps != null ? `bw  ${fmtBytes(best.memBandwidthBps)}/s` : null,
    best.netInBps != null ? `net ${fmtBytes(best.netInBps + (best.netOutBps ?? 0))}/s` : null,
  ]
    .filter(Boolean)
    .join('\n');
  tip.style.left = x > rect.width - 200 ? '-170px' : '8px';
});
timeline.addEventListener('mouseleave', () => ($('cursor').hidden = true));
new ResizeObserver(schedule).observe($('lanes'));

connect();
