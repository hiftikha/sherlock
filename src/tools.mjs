import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { detectProject } from './detect.mjs';
import { launchNative, attachNative, captureStacks } from './launch.mjs';
import { profileWeb } from './platform/web.mjs';
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
      },
      required: ['url'],
      additionalProperties: false,
    },
    run: async (i) => digest(await profileWeb({ url: i.url, cpuThrottle: i.cpu_throttle, headless: i.headless })),
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
    description: 'Put an interaction marker on the live timeline (for example "open document") just before the user or a script performs it. Repeating the same label lets Sherlock spot memory each interaction keeps.',
    input_schema: { type: 'object', properties: { label: str('Short name of the interaction.'), session: str('Session id. Defaults to the latest.') }, required: ['label'], additionalProperties: false },
    run: async (i) => {
      const s = need(getSession(i.session), i.session);
      return s.mark(i.label, { source: 'agent' });
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
