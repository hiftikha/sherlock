// Pure parsers for Chrome DevTools trace events (the JSON array that
// Tracing.dataCollected delivers). Timestamps in a trace are microseconds on
// the browser's monotonic clock; everything returned here is milliseconds
// relative to the start of the interaction.

export const INTERACTION_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-display.framedisplayed',
  'blink.user_timing',
  'latencyInfo',
];

export const JS_PROFILER_CATEGORY = 'disabled-by-default-v8.cpu_profiler';

export const SEGMENTS = {
  input: 'input delay',
  handlers: 'event handlers',
  script: 'script',
  render: 'style, layout & paint',
  network: 'network',
  idle: 'idle (timers, waiting)',
  other: 'other main-thread work',
  frame: 'frame presentation',
};

const RENDER = new Set([
  'UpdateLayoutTree',
  'RecalculateStyles',
  'Layout',
  'PrePaint',
  'Paint',
  'PaintImage',
  'Layerize',
  'Commit',
  'UpdateLayer',
  'UpdateLayerTree',
  'CompositeLayers',
  'ScrollLayer',
  'Decode Image',
  'ParseAuthorStyleSheet',
  'IntersectionObserverController::computeIntersections',
]);

const SCRIPT = new Set([
  'FunctionCall',
  'EvaluateScript',
  'v8.compile',
  'v8.compileModule',
  'v8.evaluateModule',
  'TimerFire',
  'FireAnimationFrame',
  'FireIdleCallback',
  'XHRReadyStateChange',
  'XHRLoad',
  'RunMicrotasks',
  'MinorGC',
  'MajorGC',
  'ParseHTML',
]);

const HOVER = new Set(['mousemove', 'pointermove', 'mouseover', 'pointerover', 'mouseout', 'pointerout', 'mouseenter', 'pointerenter', 'mouseleave', 'pointerleave', 'pointerrawupdate']);
const PRECEDENCE = ['render', 'handlers', 'script', 'other'];

const ms = (us) => Math.round(us / 100) / 10;

function threadNames(events) {
  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name);
  return names;
}

function findMark(events, name, after = -Infinity) {
  return events.filter((e) => e.name === name && String(e.cat ?? '').includes('user_timing') && e.ts >= after).sort((a, b) => a.ts - b.ts)[0] ?? null;
}

// Pair async begin/end events ("b"/"e") that share a name and id.
function asyncSpans(events, name) {
  const open = new Map();
  const spans = [];
  for (const e of events) {
    if (e.name !== name) continue;
    const key = `${e.pid}:${e.id ?? e.id2?.local ?? e.id2?.global}`;
    if (e.ph === 'b') {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e);
    } else if (e.ph === 'e') {
      const begin = open.get(key)?.shift();
      if (begin) spans.push({ begin, end: e });
    }
  }
  return spans;
}

/**
 * Break one interaction down from a DevTools trace.
 *
 * options.startMark  user-timing mark placed just before the input was dispatched
 * options.doneMark   user-timing mark placed when the "done" condition became true
 * options.cutoffMark user-timing mark placed when Sherlock stopped waiting; work after it is ignored
 */
export function parseInteractionTrace(events, { startMark = 'sherlock-start', doneMark = 'sherlock-done', cutoffMark = 'sherlock-cutoff' } = {}) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const names = threadNames(sorted);
  const start = findMark(sorted, startMark);
  if (!start) return { available: false, reason: `the trace has no "${startMark}" mark, so the interaction window is unknown` };
  const cutoff = findMark(sorted, cutoffMark, start.ts);
  const done = findMark(sorted, doneMark, start.ts);
  const pid = start.pid;
  const mainTid = start.tid;
  if (names.get(`${pid}:${mainTid}`) !== 'CrRendererMain') return { available: false, reason: 'the start mark is not on a renderer main thread' };
  const onMain = (e) => e.pid === pid && e.tid === mainTid;
  const limit = cutoff?.ts ?? Infinity;

  // Input: Event Timing (what INP is built from) gives the input's own timestamp
  // and when its handlers started; fall back to the browser's input latency
  // span, then to the first event dispatch.
  const timings = asyncSpans(sorted, 'EventTiming').filter(({ begin }) => onMain(begin) && begin.ts >= start.ts && begin.ts < limit);
  const interactive = timings.filter(({ begin }) => begin.args?.data?.interactionId > 0).sort((a, b) => a.begin.ts - b.begin.ts);
  let entries = [];
  if (interactive.length) {
    const id = interactive[0].begin.args.data.interactionId;
    const first = interactive[0].begin.ts;
    const lastBegin = Math.max(...interactive.filter((t) => t.begin.args.data.interactionId === id).map((t) => t.begin.ts));
    entries = timings.filter(({ begin }) => begin.ts >= first && begin.ts <= lastBegin && !HOVER.has(begin.args?.data?.type));
  }
  const dispatches = sorted.filter((e) => onMain(e) && e.name === 'EventDispatch' && e.ph === 'X' && e.ts >= start.ts && e.ts < limit && !HOVER.has(e.args?.data?.type));
  let t0;
  let handlerStart;
  let inputSource;
  if (entries.length) {
    t0 = Math.min(...entries.map((x) => x.begin.ts));
    handlerStart = Math.min(...entries.map(({ begin }) => begin.ts + (begin.args.data.processingStart - begin.args.data.timeStamp) * 1000));
    inputSource = 'event timing';
  } else {
    const latency = sorted.find((e) => /^InputLatency::/.test(e.name) && e.ph === 'b' && !/Move/.test(e.name) && e.ts >= start.ts && e.ts < limit);
    handlerStart = dispatches[0]?.ts ?? null;
    if (latency) {
      t0 = latency.ts;
      inputSource = 'browser input latency';
    } else {
      t0 = handlerStart;
      inputSource = 'first event dispatch (input delay not measured)';
    }
  }
  if (t0 == null || handlerStart == null) return { available: false, reason: 'no input event for the interaction reached the page (did the click land on the element?)' };
  handlerStart = Math.max(t0, handlerStart);

  // Main-thread intervals by kind.
  const intervals = [];
  // Sherlock's own Runtime.evaluate calls (the tasks that placed the start and
  // cutoff marks) are not the page's work.
  const own = [start.ts, cutoff?.ts].filter((t) => t != null);
  for (const e of sorted) {
    if (!onMain(e) || e.ph !== 'X' || !e.dur || e.ts + e.dur < t0 || e.ts > limit) continue;
    if (own.some((t) => e.ts <= t && e.ts + e.dur >= t)) continue;
    let kind = null;
    if (RENDER.has(e.name)) kind = 'render';
    else if (e.name === 'EventDispatch') kind = HOVER.has(e.args?.data?.type) ? 'script' : 'handlers';
    else if (SCRIPT.has(e.name)) kind = 'script';
    else if (e.name === 'RunTask') kind = 'other';
    if (kind) intervals.push({ kind, start: e.ts, end: e.ts + e.dur, e });
  }
  const scriptSpans = asyncSpans(sorted, 'AnimationFrame::Script::Execute').filter(({ begin, end }) => onMain(begin) && end.ts >= t0 && begin.ts <= limit);
  for (const { begin, end } of scriptSpans) intervals.push({ kind: 'script', start: begin.ts, end: end.ts });

  // What the interaction changed reaches the screen through main-thread
  // commits. A commit counts when it follows the input or a piece of script
  // the interaction ran; commits from caret blinks or other timers with no
  // script in front of them do not move the end.
  const meaningful = intervals.filter((iv) => iv.kind !== 'other');
  const lastWorkEnd = lastWorkEndBefore(meaningful, limit, handlerStart);
  const commits = intervals.filter((iv) => iv.e?.name === 'Commit' && iv.start >= handlerStart && iv.start < limit).sort((a, b) => a.start - b.start);
  let anchor = null;
  if (done) {
    anchor = commits.find((c) => c.start >= done.ts)?.end ?? done.ts;
  } else {
    const causes = [handlerStart, ...meaningful.filter((iv) => (iv.kind === 'handlers' || iv.kind === 'script') && iv.start < limit).map((iv) => Math.min(iv.end, limit))];
    for (const c of causes) {
      const commit = commits.find((k) => k.start >= c);
      if (commit && (anchor == null || commit.end > anchor)) anchor = commit.end;
    }
  }

  // Frame shown: the first frame the display presented after that commit.
  const displayed = sorted.filter((e) => e.name === 'Display::FrameDisplayed').map((e) => e.ts);
  const presentations = displayed.length
    ? { source: 'Display::FrameDisplayed', ts: displayed }
    : { source: 'AnimationFrame::Presentation', ts: sorted.filter((e) => e.name === 'AnimationFrame::Presentation' && e.pid === pid).map((e) => e.ts) };
  const frameTs = anchor == null ? null : (presentations.ts.find((t) => t >= anchor) ?? null);
  const end = frameTs ?? (done ? anchor : lastWorkEnd);
  const workEnd = lastWorkEndBefore(meaningful, end, handlerStart);

  // Requests sent during the interaction.
  const finishes = new Map();
  for (const e of sorted) {
    if (e.name === 'ResourceFinish') finishes.set(e.args?.data?.requestId, e);
  }
  const responses = new Map();
  for (const e of sorted) if (e.name === 'ResourceReceiveResponse') responses.set(e.args?.data?.requestId, e);
  const requests = sorted
    .filter((e) => e.name === 'ResourceSendRequest' && e.pid === pid && e.ts >= t0 && e.ts < end)
    .map((e) => {
      const id = e.args?.data?.requestId;
      const fin = finishes.get(id);
      const finTs = fin ? (fin.args?.data?.finishTime ? fin.args.data.finishTime * 1e6 : fin.ts) : null;
      return {
        url: String(e.args?.data?.url ?? '').slice(0, 200),
        method: e.args?.data?.requestMethod,
        status: responses.get(id)?.args?.data?.statusCode ?? null,
        start: e.ts,
        end: finTs ?? end,
        pending: finTs == null || finTs > end,
        failed: !!fin?.args?.data?.didFail,
        bytes: fin?.args?.data?.encodedDataLength ?? null,
      };
    });

  // Sweep the window and give every slice of time one owner.
  const points = new Set([t0, handlerStart, workEnd, end]);
  for (const iv of intervals) {
    if (iv.end > t0 && iv.start < end) {
      points.add(Math.max(t0, iv.start));
      points.add(Math.min(end, iv.end));
    }
  }
  for (const r of requests) {
    points.add(Math.max(t0, r.start));
    points.add(Math.min(end, r.end));
  }
  const cuts = [...points].filter((p) => p >= t0 && p <= end).sort((a, b) => a - b);
  const segments = [];
  const totals = Object.fromEntries(Object.keys(SEGMENTS).map((k) => [k, 0]));
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b <= a) continue;
    const mid = (a + b) / 2;
    let key;
    if (mid < handlerStart) key = 'input';
    else {
      const busy = intervals.filter((iv) => iv.start <= mid && iv.end >= mid).map((iv) => iv.kind);
      key = PRECEDENCE.find((k) => busy.includes(k));
      if (!key) {
        if (requests.some((r) => r.start <= mid && r.end >= mid)) key = 'network';
        else if (mid >= workEnd) key = 'frame';
        else key = 'idle';
      }
    }
    totals[key] += b - a;
    const prev = segments[segments.length - 1];
    if (prev && prev.key === key) prev.end = b;
    else segments.push({ key, start: a, end: b });
  }

  const totalUs = end - t0;
  const rounded = Object.fromEntries(Object.entries(totals).filter(([, v]) => ms(v) > 0).map(([k, v]) => [k, ms(v)]));
  const slowestKey = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];

  const notes = [];
  if (!frameTs) notes.push(`No frame showing the result was presented (${anchor == null ? 'nothing on screen changed' : presentations.ts.length ? 'the last commit was never displayed' : 'the trace has no presentation events'}), so the breakdown ends at the last main-thread work and frame presentation is not measured.`);
  if (inputSource !== 'event timing') notes.push(`Input time comes from the ${inputSource}; Event Timing was not in the trace.`);
  if (!cutoff) notes.push('The trace has no cutoff mark; every task until the end of the trace was considered.');
  else if (!done && cutoff.ts - Math.max(lastWorkEnd, anchor ?? 0) < 100000) notes.push('The page was still working when Sherlock stopped waiting (an animation or polling?), so the end is approximate. Pass a done selector to end the interaction when its result appears.');

  return {
    available: true,
    inputSource,
    endSignal: done ? 'first frame after the done condition' : frameTs ? 'first frame after the last visual update' : 'last main-thread work',
    frameSource: frameTs ? presentations.source : null,
    frameShown: frameTs != null,
    totalMs: ms(totalUs),
    startOffsetMs: ms(t0 - start.ts),
    segments: coalesce(segments).map((s) => ({ key: s.key, label: SEGMENTS[s.key], start: ms(s.start - t0), end: ms(s.end - t0) })).filter((s) => s.end > s.start),
    totals: rounded,
    slowest: slowestKey && slowestKey[1] > 0 ? { key: slowestKey[0], label: SEGMENTS[slowestKey[0]], ms: ms(slowestKey[1]), share: totalUs ? Math.round((slowestKey[1] / totalUs) * 100) / 100 : null } : null,
    eventTiming: eventTimingSummary(entries),
    scripts: scriptSummary(scriptSpans, sorted.filter((e) => onMain(e) && e.name === 'FunctionCall' && e.ph === 'X' && e.ts >= t0 && e.ts < end), t0, end),
    requests: requests.map((r) => ({ url: r.url, method: r.method, status: r.status, startMs: ms(r.start - t0), ms: ms(Math.min(r.end, end) - r.start), bytes: r.bytes, failed: r.failed || undefined, pending: r.pending || undefined })),
    render: renderSummary(intervals.filter((iv) => iv.kind === 'render' && iv.start >= t0 && iv.start < end)),
    framesPresented: presentations.ts.filter((t) => t >= t0 && t <= end).length,
    traceWindowUs: [t0, end],
    notes,
  };
}

// For drawing: runs under half a millisecond (IPC bookkeeping between two
// network waits, say) fold into the run before them. `totals` stays exact.
export function coalesce(segments, minUs = 500) {
  const out = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && (prev.key === s.key || s.end - s.start < minUs)) prev.end = s.end;
    else if (prev && prev.end - prev.start < minUs && out.length > 1 && out[out.length - 2].key === s.key) {
      out.pop();
      out[out.length - 1].end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

function lastWorkEndBefore(intervals, before, floor) {
  return Math.max(floor, ...intervals.filter((iv) => iv.start < before).map((iv) => Math.min(iv.end, before)));
}

function eventTimingSummary(entries) {
  if (!entries.length) return null;
  const d = entries.map(({ begin }) => begin.args.data);
  const timeStamp = Math.min(...d.map((x) => x.timeStamp));
  const processingStart = Math.min(...d.map((x) => x.processingStart));
  const processingEnd = Math.max(...d.map((x) => x.processingEnd));
  const longest = d.reduce((m, x) => (x.duration > m.duration ? x : m), d[0]);
  const round = (v) => Math.round(v * 10) / 10;
  return {
    events: [...new Set(d.map((x) => x.type))],
    durationMs: round(longest.timeStamp + longest.duration - timeStamp),
    inputDelayMs: round(processingStart - timeStamp),
    processingMs: round(processingEnd - processingStart),
    presentationDelayMs: round(longest.timeStamp + longest.duration - processingEnd),
  };
}

function scriptSummary(spans, calls, t0, end) {
  const out = [];
  for (const { begin, end: e } of spans) {
    if (e.ts < t0 || begin.ts > end) continue;
    const info = begin.args?.animation_frame_script_timing_info ?? {};
    const what = [info.class_like_name, info.property_like_name].filter(Boolean).join('.');
    out.push({
      invoker: `${what || info.invoker_type || 'script'}${info.invoker_type ? ` (${info.invoker_type.toLowerCase().replace(/_/g, ' ')})` : ''}`,
      source: [info.source_location_url || null, info.source_location_function_name || null].filter(Boolean).join(' ') || null,
      startMs: ms(begin.ts - t0),
      ms: ms(e.ts - begin.ts),
    });
  }
  if (!out.length) {
    for (const c of calls) {
      const d = c.args?.data ?? {};
      out.push({ invoker: d.functionName || '(anonymous)', source: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : null, startMs: ms(c.ts - t0), ms: ms(c.dur) });
    }
  }
  return out.sort((a, b) => b.ms - a.ms).slice(0, 8);
}

function renderSummary(intervals) {
  const sum = (names) => ms(intervals.filter((iv) => names.includes(iv.e?.name)).reduce((a, iv) => a + (iv.end - iv.start), 0));
  const layouts = intervals.filter((iv) => iv.e?.name === 'Layout');
  return {
    styleMs: sum(['UpdateLayoutTree', 'RecalculateStyles']),
    layoutMs: sum(['Layout']),
    paintMs: sum(['PrePaint', 'Paint', 'Layerize', 'Commit', 'PaintImage', 'UpdateLayer', 'UpdateLayerTree', 'CompositeLayers']),
    layouts: layouts.length,
    layoutObjects: layouts.reduce((m, iv) => Math.max(m, iv.e.args?.beginData?.dirtyObjects ?? 0), 0) || null,
  };
}

/**
 * Hot JavaScript functions (self time) from the V8 sampling profiler's
 * ProfileChunk events, restricted to [fromTs, toTs] in trace microseconds.
 */
export function parseJsProfile(events, { fromTs = -Infinity, toTs = Infinity, pid } = {}) {
  const profiles = events.filter((e) => e.name === 'Profile' && (pid == null || e.pid === pid));
  if (!profiles.length) return { available: false, reason: 'the trace has no V8 CPU profile (stacks were not requested)' };
  const nodes = new Map();
  const self = new Map();
  let active = 0;
  let total = 0;
  for (const p of profiles) {
    let t = p.args?.data?.startTime ?? p.ts;
    const chunks = events.filter((e) => e.name === 'ProfileChunk' && e.pid === p.pid && e.id === p.id).sort((a, b) => a.ts - b.ts);
    for (const c of chunks) {
      const cp = c.args?.data?.cpuProfile ?? {};
      for (const n of cp.nodes ?? []) nodes.set(`${p.pid}:${p.id}:${n.id}`, n);
      const samples = cp.samples ?? [];
      const deltas = c.args?.data?.timeDeltas ?? [];
      for (let i = 0; i < samples.length; i++) {
        t += deltas[i] ?? 0;
        const next = deltas[i + 1] ?? 0;
        if (t < fromTs || t > toTs) continue;
        const node = nodes.get(`${p.pid}:${p.id}:${samples[i]}`);
        const fn = node?.callFrame?.functionName ?? '(unknown)';
        total += next;
        if (fn === '(idle)' || fn === '(root)') continue;
        active += next;
        const cf = node?.callFrame ?? {};
        const key = `${fn || '(anonymous)'}|${cf.url ?? ''}|${cf.lineNumber ?? ''}`;
        self.set(key, (self.get(key) ?? 0) + next);
      }
    }
  }
  if (!active) return { available: false, reason: 'the profiler took no busy samples during the interaction' };
  const hot = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([key, us]) => {
      const [fn, url, line] = key.split('|');
      return { symbol: fn, source: url ? `${url}:${Number(line) + 1}` : null, ms: ms(us), pctOfActive: Math.round((us / active) * 1000) / 1000 };
    });
  return { available: true, tool: 'V8 sampling profiler', activeMs: ms(active), sampledMs: ms(total), hot };
}
