import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { detectProject } from './detect.mjs';
import { launchNative, attachNative, captureStacks } from './launch.mjs';
import { profileWeb, interactWeb } from './platform/web.mjs';
import { captureMarkStacks } from './interaction.mjs';
import { canSampleStacks } from './stacks.mjs';
import { SEGMENTS } from './parse/trace.mjs';
import { profileIos, profileAndroid } from './platform/mobile.mjs';
import { getSession, listSessions } from './session.mjs';
import { startDashboard, writeReport } from './server.mjs';
import { formatBytes, formatMs, run, which, sleep } from './util.mjs';

const dashboards = new Map();

export async function ensureDashboard(session, { open = false } = {}) {
  if (dashboards.has(session.id)) return dashboards.get(session.id);
  const d = await startDashboard(session, { open });
  dashboards.set(session.id, d);
  return d;
}

export async function closeDashboards() {
  for (const d of dashboards.values()) await d.close();
  dashboards.clear();
}

function need(session, id) {
  if (!session) throw new Error(id ? `No session ${id}.` : 'No session yet. Start one with sherlock_launch, sherlock_attach, sherlock_web, sherlock_ios or sherlock_android.');
  return session;
}

export function describeInteraction(r) {
  if (r.kind === 'native') {
    return {
      label: r.label,
      at: formatMs(r.t),
      stacks: r.stacks?.available ? r.stacks.hot.slice(0, 8).map((h) => `${(h.pctOfActive * 100).toFixed(1)}% ${h.symbol} [${h.module}] on ${h.thread}`) : `call stacks unavailable: ${r.stacks?.reason ?? 'still sampling'}`,
      summary: r.summary ? summaryLine(r.summary) : undefined,
    };
  }
  if (!r.available) return { label: r.label, at: formatMs(r.t), input: r.input, measured: false, reason: r.reason };
  return {
    label: r.label,
    at: formatMs(r.t),
    input: r.input,
    total: `${formatMs(r.totalMs)} ${r.frameShown ? 'input → frame shown' : 'input → last main-thread work (no frame presented)'}`,
    slowest: `${r.slowest.label} ${formatMs(r.slowest.ms)} (${Math.round((r.slowest.share ?? 0) * 100)}%)`,
    breakdown: Object.keys(SEGMENTS)
      .filter((k) => r.totals[k] >= 0.5)
      .map((k) => `${SEGMENTS[k]}: ${formatMs(r.totals[k])}`),
    timeline: r.segments.filter((x) => x.end - x.start >= 1).map((x) => `${x.start.toFixed(0)}–${x.end.toFixed(0)} ms ${x.label}`),
    eventTiming: r.eventTiming ? `${formatMs(r.eventTiming.durationMs)} to next paint (${formatMs(r.eventTiming.inputDelayMs)} input delay, ${formatMs(r.eventTiming.processingMs)} processing, ${formatMs(r.eventTiming.presentationDelayMs)} presentation) for ${r.eventTiming.events.join(', ')}` : undefined,
    scripts: r.scripts?.length ? r.scripts.slice(0, 4).map((x) => `${formatMs(x.ms)} ${x.invoker}${x.source ? ` · ${x.source}` : ''}`) : undefined,
    requests: r.requests?.length ? r.requests.slice(0, 5).map((x) => `${formatMs(x.ms)} ${x.method ?? 'GET'} ${x.url}${x.status ? ` → ${x.status}` : ''}${x.pending ? ' (still pending)' : ''}`) : undefined,
    render: r.render && (r.render.layoutMs || r.render.styleMs || r.render.paintMs) ? `style ${formatMs(r.render.styleMs)}, layout ${formatMs(r.render.layoutMs)}${r.render.layoutObjects ? ` (${r.render.layoutObjects} objects)` : ''}, paint ${formatMs(r.render.paintMs)}` : undefined,
    hotJs: r.stacks ? (r.stacks.available ? r.stacks.hot.slice(0, 6).map((h) => `${formatMs(h.ms)} ${h.symbol}${h.source ? ` ${h.source}` : ''}`) : `unavailable: ${r.stacks.reason}`) : undefined,
    endSignal: r.endSignal,
    notes: r.notes?.length ? r.notes : undefined,
  };
}

function summaryLine(m) {
  return `busy ${formatMs(m.busyMs)}${m.settled ? '' : '+'} · cpu ${m.cpuAvgPct.toFixed(0)}% avg / ${m.cpuPeakPct.toFixed(0)}% peak · memory ${m.rssDeltaBytes == null ? '—' : `${m.rssDeltaBytes >= 0 ? '+' : ''}${formatBytes(m.rssDeltaBytes)}`} (peak ${formatBytes(m.rssPeakBytes)})`;
}

export function digest(session, { dashboardUrl } = {}) {
  const j = session.toJSON();
  const s = j.summary;
  const pick = (n) => {
    const step = Math.max(1, Math.ceil(j.samples.length / n));
    return j.samples.filter((_, i) => i % step === 0).map((x) => [x.t, x.cpuPct == null ? null : Math.round(x.cpuPct), x.rssBytes == null ? null : Math.round(x.rssBytes / 1048576)]);
  };
  const missing = Object.entries(j.capabilities ?? {})
    .filter(([k, v]) => v === null && !k.endsWith('Reason'))
    .map(([k]) => k);
  return {
    session: j.id,
    kind: j.kind,
    target: j.target,
    status: j.status,
    error: j.error ?? undefined,
    dashboard: dashboardUrl ?? dashboards.get(j.id)?.url,
    startup: j.startup ?? undefined,
    phases: j.phases?.length ? j.phases.map((p) => `${p.name}: ${formatMs(p.end - p.start)}`) : undefined,
    metrics: {
      duration: formatMs(s.durationMs),
      startup: s.startupMs == null ? undefined : formatMs(s.startupMs),
      peakCpu: s.peakCpuPct == null ? undefined : `${s.peakCpuPct.toFixed(0)}%`,
      avgCpu: s.avgCpuPct == null ? undefined : `${s.avgCpuPct.toFixed(0)}%`,
      peakRss: formatBytes(s.peakRssBytes),
      currentRss: formatBytes(s.currentRssBytes),
      peakGpu: s.peakGpuPct == null ? undefined : `${s.peakGpuPct}% (whole GPU)`,
      peakMemBandwidth: s.peakMemBandwidthBps == null ? undefined : `${formatBytes(s.peakMemBandwidthBps)}/s`,
      peakNet: s.peakNetInBps == null ? undefined : `${formatBytes((s.peakNetInBps ?? 0) + (s.peakNetOutBps ?? 0))}/s`,
      threads: s.threads ?? undefined,
      processes: s.processes ?? undefined,
    },
    notMeasured: missing.length ? missing.map((m) => (m === 'memBandwidth' && j.capabilities.memBandwidthReason ? `memBandwidth (${j.capabilities.memBandwidthReason})` : m)) : undefined,
    marks: j.marks?.length ? j.marks.map((m) => `${formatMs(m.t)} ${m.label}`) : undefined,
    perInteraction: j.markSummaries?.length ? j.markSummaries.map((m) => `${formatMs(m.t)} ${m.label}: ${summaryLine(m)}`) : undefined,
    interactions: j.interactions?.length ? j.interactions.slice(-6).map(describeInteraction) : undefined,
    findings: j.findings.map((f) => ({ severity: f.severity, title: f.title, evidence: f.evidence, suggestion: f.suggestion })),
    hotFunctions: j.stacks?.available
      ? j.stacks.hot.slice(0, 10).map((h) => `${(h.pctOfActive * 100).toFixed(1)}% ${h.symbol} [${h.module}] on ${h.thread}`)
      : j.stacks
        ? `call stacks unavailable: ${j.stacks.reason}`
        : undefined,
    web: j.web ?? undefined,
    mobile: j.mobile ?? undefined,
    timeline: `[t_ms, cpu_%, rss_MB] ${JSON.stringify(pick(24))}`,
    outputTail: j.output?.length ? j.output.slice(-8).map((o) => `${o.stream}: ${o.text}`) : undefined,
  };
}

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

export const TOOLS = [
  {
    name: 'sherlock_detect',
    description:
      'Look at a project folder and work out what it is (Rust, Tauri, Electron, Next.js/Vite web app, iOS, Android, Go, Python, Rust→WASM) and how to launch it for profiling. Call this first in an unfamiliar repo.',
    input_schema: { type: 'object', properties: { dir: str('Project folder. Defaults to the current directory.') }, additionalProperties: false },
    run: async ({ dir }) => detectProject(dir ? resolve(dir) : process.cwd()),
  },
  {
    name: 'sherlock_launch',
    description:
      'Launch a native app or server (any command: a Rust/Go/Swift binary, an Electron or Tauri app, node, python, a dev server) and measure its startup: time to first output, to a ready signal, and to going idle, with CPU, memory, threads, network, GPU and memory bandwidth sampled every 100 ms across the whole process tree. On macOS it also captures startup call stacks in a separate warm-up launch so they do not skew the timing. Returns when startup is measured; the app keeps running for live observation unless keep_alive is false.',
    input_schema: {
      type: 'object',
      properties: {
        command: str('Command line to run, e.g. "./target/release/my-app --flag". Prefer a release build over `cargo run`.'),
        cwd: str('Working directory. Defaults to the current directory.'),
        ready_log: str('Regex matched against stdout/stderr lines; the first match marks the app ready.'),
        ready_port: num('TCP port on 127.0.0.1; the app is ready when it accepts connections.'),
        ready_url: str('URL polled until it answers with a status below 500.'),
        timeout_ms: num('Give up waiting for startup after this long. Default 30000.'),
        keep_alive: bool('Keep the app running after startup is measured (default true) so you can mark interactions and observe.'),
        stacks: bool('Capture startup call stacks with a warm-up launch (macOS). Default true.'),
      },
      required: ['command'],
      additionalProperties: false,
    },
    run: async (i) => {
      const session = launchNative({
        command: i.command,
        cwd: i.cwd ? resolve(i.cwd) : process.cwd(),
        readyLog: i.ready_log,
        readyPort: i.ready_port,
        readyUrl: i.ready_url,
        timeoutMs: i.timeout_ms,
        keepAlive: i.keep_alive !== false,
        stacks: i.stacks,
      });
      await session.done;
      if (i.keep_alive === false) session.stop();
      return digest(session);
    },
  },
  {
    name: 'sherlock_attach',
    description: 'Attach to a process that is already running (by pid or by name) and sample CPU, memory, threads, network, GPU and memory bandwidth live. Observes for `seconds` and returns a digest; the session keeps sampling until sherlock_stop.',
    input_schema: {
      type: 'object',
      properties: { pid: num('Process id.'), name: str('Process name or part of it, used when pid is not given.'), seconds: num('How long to observe before returning. Default 10.') },
      additionalProperties: false,
    },
    run: async (i) => {
      const session = await attachNative({ pid: i.pid, name: i.name });
      await sleep((i.seconds ?? 10) * 1000);
      session.refreshFindings();
      return digest(session);
    },
  },
  {
    name: 'sherlock_web',
    description: 'Load a URL in headless Chrome and measure page startup: TTFB, first and largest contentful paint, layout shift, long main-thread tasks, script/layout/style time, JS heap, request weight, slowest requests and .wasm downloads, plus browser CPU and memory. For a dev server, start it first with sherlock_launch and ready_port.',
    input_schema: {
      type: 'object',
      properties: {
        url: str('http(s) URL to load.'),
        cpu_throttle: num('Slow the CPU down by this factor (4 approximates a mid-range phone).'),
        headless: bool('Run Chrome headless. Default true.'),
        keep_open: bool('Keep the page open after load so sherlock_interact can click and type on it. Default false.'),
      },
      required: ['url'],
      additionalProperties: false,
    },
    run: async (i) => digest(await profileWeb({ url: i.url, cpuThrottle: i.cpu_throttle, headless: i.headless, keepOpen: !!i.keep_open })),
  },
  {
    name: 'sherlock_interact',
    description:
      'Perform one interaction on an open web page (a click on a selector or at x/y, or a key press) and break its latency down end to end from a DevTools trace: input delay, event handlers, script, network, style/layout/paint and presentation of the frame that shows the result. Reports the slowest segment, the Event Timing (INP) numbers, the requests, the longest scripts and the layout cost, and draws the breakdown on the dashboard. Uses the page from sherlock_web with keep_open, or opens url. For native apps use sherlock_mark with stacks_seconds instead.',
    input_schema: {
      type: 'object',
      properties: {
        label: str('Short name of the interaction, e.g. "open menu". Repeat the same label to compare runs.'),
        selector: str('CSS selector of the element to click (or to focus before pressing key).'),
        x: num('Viewport x to click, when there is no selector.'),
        y: num('Viewport y to click, when there is no selector.'),
        key: str('Press this key instead of clicking: a single character or Enter, Tab, Escape, Backspace, Space, ArrowDown and so on.'),
        done_selector: str('CSS selector that appears only when the interaction has finished (e.g. "#results li"). The breakdown then ends at the first frame after it appears. Without it, Sherlock waits for the network and main thread to go quiet.'),
        url: str('Open this page first (headless Chrome) when no web page session is open.'),
        timeout_ms: num('Give up waiting after this long. Default 10000.'),
        quiet_ms: num('Network quiet time that ends the interaction when there is no done_selector. Default 500.'),
        repeat: num('Run the interaction this many times (1–10). Default 1.'),
        stacks: bool('Also sample JavaScript call stacks with the V8 profiler (adds some overhead). Default false.'),
        session: str('Session id. Defaults to the latest.'),
      },
      required: ['label'],
      additionalProperties: false,
    },
    run: async (i) => {
      let s = getSession(i.session);
      if (i.url && !(s?.kind === 'web' && s.cdp && !s.stopped)) s = await profileWeb({ url: i.url, keepOpen: true });
      s = need(s, i.session);
      if (s.kind !== 'web') throw new Error(`sherlock_interact drives web pages; session ${s.id} is ${s.kind}. For a native app, call sherlock_mark with stacks_seconds and perform the interaction.`);
      const runs = [];
      for (let n = 0; n < Math.min(10, Math.max(1, Math.round(i.repeat ?? 1))); n++) {
        runs.push(
          await interactWeb(s, { label: i.label, selector: i.selector, x: i.x, y: i.y, key: i.key, doneSelector: i.done_selector, timeoutMs: i.timeout_ms, quietMs: i.quiet_ms, stacks: i.stacks }),
        );
        if (n + 1 < (i.repeat ?? 1)) await sleep(300);
      }
      const finding = s.findings.find((f) => f.id === 'interaction-slowest-segment' && f.label === runs[0].label);
      return { session: s.id, dashboard: dashboards.get(s.id)?.url, finding: finding ? { severity: finding.severity, title: finding.title, evidence: finding.evidence, suggestion: finding.suggestion } : undefined, runs: runs.map(describeInteraction) };
    },
  },
  {
    name: 'sherlock_ios',
    description: 'Cold-launch an installed app in the booted iOS Simulator (macOS only), time the launch until its main thread goes quiet, sample its CPU and memory, and capture startup call stacks.',
    input_schema: {
      type: 'object',
      properties: { bundle_id: str('App bundle identifier, e.g. com.example.app.'), device: str('Simulator UDID or "booted". Default booted.'), keep_alive: bool('Keep sampling after launch. Default false.') },
      required: ['bundle_id'],
      additionalProperties: false,
    },
    run: async (i) => digest(await profileIos({ bundleId: i.bundle_id, device: i.device, keepAlive: i.keep_alive })),
  },
  {
    name: 'sherlock_android',
    description: 'Cold-start an Android app on a connected device or emulator with `am start -W` (time to first frame), then sample its CPU, memory (RSS and PSS) and network over adb.',
    input_schema: {
      type: 'object',
      properties: { target: str('Package name (launcher activity is resolved) or package/activity.'), serial: str('adb device serial when several are connected.'), keep_alive: bool('Keep sampling after launch. Default false.') },
      required: ['target'],
      additionalProperties: false,
    },
    run: async (i) => digest(await profileAndroid({ target: i.target, serial: i.serial, keepAlive: i.keep_alive })),
  },
  {
    name: 'sherlock_mark',
    description:
      'Put an interaction marker on the live timeline (for example "open document") just before the user or a script performs it. Sherlock summarizes CPU busy time and memory after every mark, and repeating the same label lets it spot memory each interaction keeps. With stacks_seconds (macOS) it also samples call stacks for that long in the background, so you can see which functions the interaction burns; the result appears in the next sherlock_observe digest.',
    input_schema: {
      type: 'object',
      properties: {
        label: str('Short name of the interaction.'),
        stacks_seconds: num('Sample call stacks for this many seconds right after the mark (macOS `sample`). Perform the interaction during that window.'),
        session: str('Session id. Defaults to the latest.'),
      },
      required: ['label'],
      additionalProperties: false,
    },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      const m = s.mark(i.label, { source: 'agent' });
      if (!i.stacks_seconds) return m;
      if (!canSampleStacks()) return { ...m, stacks: `not captured: ${process.platform === 'linux' ? 'call stacks on Linux need `perf record`; not wired up in this release' : 'call stacks need macOS `sample`'}` };
      const seconds = Math.min(30, Math.max(1, Number(i.stacks_seconds)));
      captureMarkStacks(s, m, seconds);
      return { ...m, stacks: `sampling call stacks for ${seconds} s in the background; perform the interaction now, then call sherlock_observe` };
    },
  },
  {
    name: 'sherlock_observe',
    description: 'Wait while the app runs (for example while the user performs the interaction you just marked), then return an updated digest.',
    input_schema: { type: 'object', properties: { seconds: num('Seconds to watch. Default 5.'), session: str('Session id. Defaults to the latest.') }, additionalProperties: false },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      await sleep((i.seconds ?? 5) * 1000);
      s.refreshFindings();
      return digest(s);
    },
  },
  {
    name: 'sherlock_stacks',
    description: 'Sample call stacks of the running app for a few seconds (macOS `sample`) to see which functions are burning CPU right now. Use it during a slow interaction.',
    input_schema: { type: 'object', properties: { seconds: num('Seconds to sample. Default 2.'), session: str('Session id. Defaults to the latest.') }, additionalProperties: false },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      const st = await captureStacks(s, i.seconds ?? 2);
      return st.available ? { window: st.window, hot: st.hot.slice(0, 15).map((h) => `${(h.pctOfActive * 100).toFixed(1)}% ${h.symbol} [${h.module}] on ${h.thread}`) } : st;
    },
  },
  {
    name: 'sherlock_dashboard',
    description: 'Open the live Sherlock dashboard for a session in the browser: startup phases, interaction markers and CPU, memory, bandwidth, GPU and network lanes on one timeline, updating as the app runs. Returns the local URL.',
    input_schema: { type: 'object', properties: { session: str('Session id. Defaults to the latest.'), open: bool('Open the browser. Default true.') }, additionalProperties: false },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      const d = await ensureDashboard(s, { open: i.open !== false });
      return { url: d.url };
    },
  },
  {
    name: 'sherlock_note',
    description: "Write your diagnosis into the dashboard's \"Sherlock's read\" rail so the user sees it next to the timeline. Title is one sentence; body is the evidence and the fix.",
    input_schema: { type: 'object', properties: { title: str('One-sentence headline.'), body: str('Evidence and suggested fix.'), session: str('Session id. Defaults to the latest.') }, required: ['title'], additionalProperties: false },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      s.note(i.title, i.body ?? '');
      return { ok: true, dashboard: dashboards.get(s.id)?.url ?? null };
    },
  },
  {
    name: 'sherlock_stop',
    description: 'Stop a session (and the app Sherlock launched), compute final findings, and save a JSON report plus a standalone HTML report under .sherlock/ in the project.',
    input_schema: { type: 'object', properties: { session: str('Session id. Defaults to the latest.'), out_dir: str('Where to save reports. Default ./.sherlock') }, additionalProperties: false },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      s.stop();
      const paths = await writeReport(s, resolve(i.out_dir ?? join(process.cwd(), '.sherlock')));
      return { ...digest(s), report: paths };
    },
  },
  {
    name: 'sherlock_sessions',
    description: 'List profiling sessions in this process.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => listSessions(),
  },
];

export const AGENT_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a text file inside the project (to connect a hot function or slow phase to the source that causes it).',
    input_schema: {
      type: 'object',
      properties: { path: str('Path relative to the project root.'), start_line: num('First line, 1-based.'), end_line: num('Last line.') },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (i, ctx) => {
      const target = confine(ctx.root, i.path);
      const lines = (await readFile(target, 'utf8')).split('\n');
      const a = Math.max(1, i.start_line ?? 1);
      const b = Math.min(lines.length, i.end_line ?? a + 199);
      return lines
        .slice(a - 1, b)
        .map((l, k) => `${a + k}\t${l}`)
        .join('\n');
    },
  },
  {
    name: 'search_code',
    description: 'Search the project for a regex (for example a hot function name from the call stacks) and return matching lines with file:line.',
    input_schema: { type: 'object', properties: { pattern: str('Regular expression.'), glob: str('Optional file glob, e.g. "*.rs".') }, required: ['pattern'], additionalProperties: false },
    run: async (i, ctx) => {
      const args = which('rg')
        ? ['-n', '--max-count', '5', '--max-columns', '200', ...(i.glob ? ['-g', i.glob] : []), '--', i.pattern, '.']
        : ['-rnE', '--exclude-dir=node_modules', '--exclude-dir=target', '--exclude-dir=.git', ...(i.glob ? [`--include=${i.glob}`] : []), '--', i.pattern, '.'];
      const r = await run(which('rg') ? 'rg' : 'grep', args, { cwd: ctx.root, timeout: 15000 });
      return r.stdout.split('\n').slice(0, 60).join('\n') || 'no matches';
    },
  },
  {
    name: 'run_command',
    description: 'Run a build or setup command in the project, such as `cargo build --release` or `npm run build`, so the app can be profiled. The user approves each command.',
    input_schema: { type: 'object', properties: { command: str('Shell command.'), timeout_s: num('Timeout in seconds. Default 600.') }, required: ['command'], additionalProperties: false },
    run: async (i, ctx) => {
      const r = await run(process.env.SHELL || '/bin/sh', ['-c', i.command], { cwd: ctx.root, timeout: (i.timeout_s ?? 600) * 1000 });
      const tail = (t) => t.split('\n').slice(-40).join('\n');
      return { exitCode: r.code, stdout: tail(r.stdout), stderr: tail(r.stderr) };
    },
  },
];

function confine(root, p) {
  const target = resolve(root, p);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path is outside the project.');
  return target;
}

export async function callTool(name, input, ctx = { root: process.cwd() }) {
  const tool = [...TOOLS, ...AGENT_TOOLS].find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  for (const key of tool.input_schema.required ?? []) {
    if (input?.[key] == null || input[key] === '') throw new Error(`Missing required field "${key}".`);
  }
  return tool.run(input ?? {}, ctx);
}
