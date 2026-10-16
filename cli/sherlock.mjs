#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { VERSION } from '../src/version.mjs';
import { c, SEVERITY, SEGMENT_COLORS, segmentBar } from '../src/term.mjs';
import { SEGMENTS } from '../src/parse/trace.mjs';
import { formatBytes, formatMs, which } from '../src/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'hiftikha/sherlock';

const HELP = `${c.amber('sherlock')} ${c.dim(VERSION)}, an agentic profiler

${c.bold('Usage')}
  sherlock                         set-up wizard: detect the project and start a drill pass
  sherlock agent [goal…]           run the Sherlock agent here (Claude API key needed)
  sherlock launch [opts] -- <cmd>  launch an app and measure startup, then watch it live
  sherlock attach <pid|name>       attach to a running process and watch it live
  sherlock web <url>               page startup in headless Chrome
  sherlock interact <url> [opts]   click or type on a page and break the interaction down
  sherlock ios <bundle-id>         cold launch in the booted iOS Simulator
  sherlock android <pkg[/act]>     cold start on a device or emulator over adb
  sherlock detect [dir]            what is this project and how would Sherlock run it
  sherlock report <file.json>      open a saved report in the dashboard
  sherlock install                 add Sherlock to Claude Code as a plugin
  sherlock mcp                     run the MCP server (used by the Claude Code plugin)

${c.bold('Options')}
  --ready-log <regex>   ready when a stdout/stderr line matches
  --ready-port <port>   ready when 127.0.0.1:<port> accepts connections
  --ready-url <url>     ready when the URL answers below 500
  --seconds <n>         how long attach watches before printing (default: until Ctrl-C)
  --throttle <n>        web: slow the CPU by n×
  --click <selector>    interact: element to click
  --at <x,y>            interact: viewport point to click
  --key <key>           interact: key to press (in --click's element if given)
  --label <name>        interact: name of the interaction
  --done <selector>     interact: element that appears when it has finished
  --repeat <n>          interact: run it n times
  --stacks              interact: also sample JS call stacks
  --mark-stacks <s>     launch/attach: sample call stacks for s seconds after each mark (macOS)
  --no-stacks           skip the startup call-stack pass (macOS)
  --no-ui               don't open the dashboard
  --exit                stop after startup instead of watching live
  --json                print the digest as JSON
  --yes                 agent: run commands without asking
  -h, --help            this help
  -v, --version         version

Docs: https://skills.wheresryan.sh/sherlock`;

function parseArgs(argv) {
  const out = { _: [], rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const next = argv[i + 1];
      const flag = ['json', 'exit', 'yes', 'help', 'version', 'stacks'].includes(k);
      if (v !== undefined) out[k] = v;
      else if (flag || next === undefined || next.startsWith('-')) out[k] = true;
      else {
        out[k] = next;
        i++;
      }
    } else if (a === '-h') out.help = true;
    else if (a === '-v') out.version = true;
    else out._.push(a);
  }
  return out;
}

function printDigest(d) {
  const line = (k, v) => v != null && console.log(`  ${c.dim(k.padEnd(14))}${v}`);
  console.log(`\n${c.amber('●')} ${c.bold(d.target)} ${c.dim(`${d.kind} · ${d.status} · session ${d.session}`)}`);
  if (d.error) console.log(c.red(`  ${d.error}`));
  if (d.metrics.startup) console.log(`\n  ${c.bold(d.metrics.startup.padEnd(10))}${c.dim(d.startup?.readySignal ? `to ready (${d.startup.readySignal})` : 'to idle')}`);
  if (d.phases) for (const p of d.phases) console.log(c.dim(`    ${p}`));
  console.log();
  line('peak cpu', d.metrics.peakCpu);
  line('peak memory', d.metrics.peakRss);
  line('mem bandwidth', d.metrics.peakMemBandwidth);
  line('gpu', d.metrics.peakGpu);
  line('network', d.metrics.peakNet);
  line('threads', d.metrics.threads);
  if (d.web) {
    const v = d.web.vitals;
    line('ttfb/fcp/lcp', `${formatMs(v.ttfbMs)} / ${formatMs(v.fcpMs)} / ${formatMs(v.lcpMs)}`);
    line('long tasks', `${formatMs(d.web.longTasks?.totalMs)} in ${d.web.longTasks?.count ?? 0}`);
    line('transfer', `${formatBytes(d.web.transfer?.bytes)} in ${d.web.transfer?.requests} requests`);
  }
  if (d.notMeasured) line('not measured', c.dim(d.notMeasured.join('; ')));
  if (d.perInteraction && !d.interactions) {
    console.log(`\n  ${c.bold('Interactions')}`);
    for (const p of d.perInteraction.slice(-8)) console.log(`    ${p}`);
  }
  if (d.raw?.interactions?.length) printInteractions(d.raw.interactions);
  if (Array.isArray(d.hotFunctions)) {
    console.log(`\n  ${c.bold('Hot functions')}`);
    for (const h of d.hotFunctions.slice(0, 6)) console.log(`    ${h}`);
  } else if (d.hotFunctions) console.log(c.dim(`\n  ${d.hotFunctions}`));
  if (d.findings?.length) {
    console.log(`\n  ${c.bold("Sherlock's read")}`);
    d.findings.forEach((f, i) => {
      console.log(`  ${SEVERITY[f.severity]?.(String(i + 1).padStart(2, '0')) ?? i + 1}  ${f.title}`);
      for (const e of f.evidence ?? []) console.log(c.dim(`      ${e}`));
      if (f.suggestion) console.log(`      ${f.suggestion}`);
    });
  }
  if (d.dashboard) console.log(`\n  ${c.dim('dashboard')}  ${c.amber(d.dashboard)}`);
}

function printInteractions(records) {
  console.log(`\n  ${c.bold('Interactions')}`);
  for (const r of records.slice(-8)) {
    if (r.kind === 'native') {
      const top = r.stacks?.available ? r.stacks.hot[0] : null;
      console.log(`    ${c.bold(r.label)} ${c.dim(`@ ${formatMs(r.t)}`)}  ${top ? `hottest ${top.symbol} ${(top.pctOfActive * 100).toFixed(0)}%` : c.dim(r.stacks?.reason ?? 'sampling…')}`);
      continue;
    }
    if (!r.available) {
      console.log(`    ${c.bold(r.label)}  ${c.red(r.reason)}`);
      continue;
    }
    console.log(`    ${c.bold(r.label.padEnd(16))} ${segmentBar(r.segments, r.totalMs)} ${c.bold(formatMs(r.totalMs))} ${c.dim(r.frameShown ? 'to frame shown' : 'to last work')}`);
    const parts = Object.entries(r.totals)
      .filter(([, v]) => v >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${c.rgb(...SEGMENT_COLORS[k])('■')} ${r.slowest?.key === k ? c.bold(`${segLabel(r, k)} ${formatMs(v)}`) : c.dim(`${segLabel(r, k)} ${formatMs(v)}`)}`);
    console.log(`    ${' '.repeat(16)} ${parts.join('  ')}`);
    for (const n of r.notes ?? []) console.log(c.dim(`    ${' '.repeat(16)} ${n}`));
  }
}

function segLabel(r, key) {
  return SEGMENTS[key] ?? key;
}

async function watchLive(session, args) {
  const { ensureDashboard, digest } = await import('../src/tools.mjs');
  const { writeReport } = await import('../src/server.mjs');
  const ui = args.ui !== false && !args.json ? await ensureDashboard(session, { open: true }) : null;
  return { ui, digest, writeReport };
}

async function finish(session, args, ui) {
  const { digest } = await import('../src/tools.mjs');
  const { writeReport } = await import('../src/server.mjs');
  const { closeDashboards } = await import('../src/tools.mjs');
  session.stop();
  const paths = await writeReport(session, resolve(process.cwd(), '.sherlock'));
  const d = digest(session, { dashboardUrl: ui?.url });
  if (args.json) console.log(JSON.stringify({ ...d, report: paths }, null, 2));
  else {
    printDigest({ ...d, dashboard: undefined, raw: { interactions: session.interactions } });
    console.log(`\n  ${c.dim('report')}     ${paths.htmlPath}`);
  }
  await closeDashboards();
}

async function liveLoop(session, args) {
  const { ui } = await watchLive(session, args);
  const { digest } = await import('../src/tools.mjs');
  if (!args.json && !args.exit && !session.stopped) {
    printDigest(digest(session, { dashboardUrl: ui?.url }));
    console.log(c.dim(`\n  Watching live. Type a label + enter to mark an interaction, enter alone to stop.`));
  }
  if (session.stopped || args.exit || args.json || !process.stdin.isTTY) {
    if (args.seconds) await new Promise((r) => setTimeout(r, Number(args.seconds) * 1000));
    return finish(session, args, ui);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  session.once('stopped', () => rl.close());
  const timer = args.seconds ? setTimeout(() => rl.close(), Number(args.seconds) * 1000) : null;
  rl.on('SIGINT', () => rl.close());
  for await (const line of rl) {
    const label = line.trim();
    if (!label) break;
    const m = session.mark(label, { source: 'cli' });
    console.log(c.amber(`  ▸ marked "${m.label}" at ${formatMs(m.t)}`));
    if (args['mark-stacks']) {
      const { captureMarkStacks } = await import('../src/interaction.mjs');
      const seconds = Number(args['mark-stacks']) || 2;
      console.log(c.dim(`    sampling call stacks for ${seconds} s; perform the interaction now`));
      captureMarkStacks(session, m, seconds).then((r) => {
        const top = r.stacks?.available ? r.stacks.hot.slice(0, 3).map((h) => `${(h.pctOfActive * 100).toFixed(0)}% ${h.symbol}`).join(' · ') : r.stacks?.reason;
        console.log(c.dim(`    "${m.label}" stacks: ${top}`));
      });
    }
  }
  clearTimeout(timer);
  rl.close();
  return finish(session, args, ui);
}

async function cmdLaunch(args) {
  const argv = args.rest ?? args._.slice(1);
  if (!argv.length) throw new Error('Usage: sherlock launch [--ready-log REGEX] -- <command> [args…]');
  const { launchNative } = await import('../src/launch.mjs');
  const session = launchNative({
    argv,
    readyLog: args['ready-log'],
    readyPort: args['ready-port'],
    readyUrl: args['ready-url'],
    timeoutMs: args.timeout ? Number(args.timeout) : undefined,
    stacks: args.stacks,
    keepAlive: !args.exit,
  });
  if (!args.json) console.log(c.dim(`  launching ${argv.join(' ')}${session.status === 'warming up' || args.stacks !== false ? ' (a warm-up launch captures call stacks first)' : ''}…`));
  if (args.ui !== false && !args.json) await watchLive(session, args);
  await session.done;
  return liveLoop(session, args);
}

async function cmdAttach(args) {
  const target = args._[1];
  if (!target) throw new Error('Usage: sherlock attach <pid|name>');
  const { attachNative } = await import('../src/launch.mjs');
  const session = await attachNative(/^\d+$/.test(target) ? { pid: Number(target) } : { name: target });
  await new Promise((r) => setTimeout(r, 1500));
  session.refreshFindings();
  return liveLoop(session, args);
}

async function cmdOneShot(kind, args) {
  const target = args._[1];
  const { digest } = await import('../src/tools.mjs');
  let session;
  if (kind === 'web') {
    if (!target) throw new Error('Usage: sherlock web <url>');
    const { profileWeb } = await import('../src/platform/web.mjs');
    session = await profileWeb({ url: target, cpuThrottle: args.throttle });
  } else if (kind === 'ios') {
    if (!target) throw new Error('Usage: sherlock ios <bundle-id>');
    const { profileIos } = await import('../src/platform/mobile.mjs');
    session = await profileIos({ bundleId: target, device: args.device, stacks: args.stacks });
  } else {
    if (!target) throw new Error('Usage: sherlock android <package[/activity]>');
    const { profileAndroid } = await import('../src/platform/mobile.mjs');
    session = await profileAndroid({ target, serial: args.serial });
  }
  const { writeReport, startDashboard } = await import('../src/server.mjs');
  const paths = await writeReport(session, resolve(process.cwd(), '.sherlock'));
  const d = digest(session);
  if (args.json) return console.log(JSON.stringify({ ...d, report: paths }, null, 2));
  printDigest(d);
  console.log(`\n  ${c.dim('report')}     ${paths.htmlPath}`);
  if (args.ui !== false) {
    const ui = await startDashboard(session.toJSON(), { open: true });
    console.log(`  ${c.dim('dashboard')}  ${c.amber(ui.url)}  ${c.dim('(Ctrl-C to quit)')}`);
    await new Promise(() => {});
  }
}

async function cmdInteract(args) {
  const url = args._[1];
  if (!url || (!args.click && !args.at && !args.key)) throw new Error('Usage: sherlock interact <url> --click <selector> | --at <x,y> | --key <key> [--label name] [--done <selector>] [--repeat n]');
  const { profileWeb, interactWeb } = await import('../src/platform/web.mjs');
  const { digest } = await import('../src/tools.mjs');
  const [x, y] = args.at ? String(args.at).split(',').map(Number) : [];
  const label = typeof args.label === 'string' ? args.label : (args.click ?? args.key ?? 'interaction');
  if (!args.json) console.log(c.dim(`  opening ${url}…`));
  const session = await profileWeb({ url, cpuThrottle: args.throttle, keepOpen: true });
  try {
    const n = Math.min(10, Math.max(1, Number(args.repeat) || 1));
    for (let k = 0; k < n; k++) {
      if (!args.json) console.log(c.dim(`  ${label}${n > 1 ? ` (${k + 1}/${n})` : ''}…`));
      await interactWeb(session, { label, selector: args.click, x, y, key: args.key, doneSelector: args.done, timeoutMs: args.timeout ? Number(args.timeout) : undefined, stacks: !!args.stacks });
      if (k + 1 < n) await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    session.stop();
  }
  const { writeReport, startDashboard } = await import('../src/server.mjs');
  const paths = await writeReport(session, resolve(process.cwd(), '.sherlock'));
  const d = digest(session);
  if (args.json) return console.log(JSON.stringify({ ...d, report: paths }, null, 2));
  printDigest({ ...d, raw: { interactions: session.interactions } });
  console.log(`\n  ${c.dim('report')}     ${paths.htmlPath}`);
  if (args.ui !== false) {
    const ui = await startDashboard(session.toJSON(), { open: true });
    console.log(`  ${c.dim('dashboard')}  ${c.amber(ui.url)}  ${c.dim('(Ctrl-C to quit)')}`);
    await new Promise(() => {});
  }
}

async function cmdDetect(args) {
  const { detectProject } = await import('../src/detect.mjs');
  const d = detectProject(resolve(args._[1] ?? '.'));
  if (args.json) return console.log(JSON.stringify(d, null, 2));
  console.log(`\n${c.amber('●')} ${c.bold(d.name)} ${c.dim(d.stacks.join(' · ') || 'no known stack')}`);
  for (const s of d.suggestions) {
    console.log(`\n  ${c.bold(s.platform)}  ${s.command}`);
    if (s.build) console.log(c.dim(`    build first: ${s.build}`));
    if (s.readyPort) console.log(c.dim(`    ready when :${s.readyPort} accepts connections`));
    console.log(c.dim(`    ${s.why}`));
  }
  return d;
}

async function cmdReport(args) {
  const file = args._[1];
  if (!file) throw new Error('Usage: sherlock report <sherlock-xxxx.json>');
  const data = JSON.parse(await readFile(resolve(file), 'utf8'));
  const { startDashboard } = await import('../src/server.mjs');
  const ui = await startDashboard({ ...data, live: false }, { open: args.ui !== false });
  console.log(`${c.amber('dashboard')} ${ui.url} ${c.dim('(Ctrl-C to quit)')}`);
  await new Promise(() => {});
}

function runInherit(cmd, argv) {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: 'inherit' });
    p.on('exit', (code) => res(code ?? 1));
    p.on('error', () => res(127));
  });
}

async function cmdInstall({ ask }) {
  if (!which('claude')) {
    console.log(`Claude Code isn't on your PATH. Install it from https://code.claude.com, then run:\n\n  claude plugin marketplace add ${REPO}\n  claude plugin install sherlock@sherlock\n`);
    return false;
  }
  console.log(`\nThis runs:\n  claude plugin marketplace add ${REPO}\n  claude plugin install sherlock@sherlock`);
  if (ask && !(await ask('Install the Sherlock plugin into Claude Code? [Y/n] ', true))) return false;
  if ((await runInherit('claude', ['plugin', 'marketplace', 'add', REPO])) !== 0) console.log(c.dim('  (marketplace may already be added; continuing)'));
  const code = await runInherit('claude', ['plugin', 'install', 'sherlock@sherlock']);
  if (code === 0) console.log(c.green(`\nInstalled. In any Claude Code session, run /sherlock:profile`));
  return code === 0;
}

async function wizard(args) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(c.amber(q))).trim().toLowerCase();
    if (!a) return def;
    return a === 'y' || a === 'yes';
  };
  const choose = async (title, options) => {
    console.log(`\n${c.bold(title)}`);
    options.forEach((o, i) => console.log(`  ${c.amber(String(i + 1))}  ${o.label}${o.hint ? c.dim(`  ${o.hint}`) : ''}`));
    const a = (await rl.question(c.amber(`\nchoose 1-${options.length} [1]: `))).trim();
    const n = a ? Number(a) : 1;
    return options[n - 1] ?? options[0];
  };

  console.log(`\n${c.amber('◎ sherlock')} ${c.dim(VERSION)}  ${c.dim('an agentic profiler')}`);
  const d = await cmdDetect({ _: ['detect', '.'] });
  const hasClaude = !!which('claude');
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const options = [];
  if (hasClaude) options.push({ id: 'claude', label: 'Open Claude Code with Sherlock and run a drill pass', hint: 'uses your Claude Code login' });
  if (hasKey) options.push({ id: 'agent', label: 'Run the Sherlock agent right here', hint: 'uses ANTHROPIC_API_KEY' });
  for (const s of d.suggestions.filter((s) => s.tool !== 'sherlock_launch' || !s.command.includes('<'))) {
    options.push({ id: 'manual', s, label: `Profile without an agent: ${s.platform} · ${s.command}` });
  }
  if (hasClaude) options.push({ id: 'install', label: 'Install Sherlock into Claude Code for every project', hint: `claude plugin install sherlock@sherlock` });
  options.push({ id: 'quit', label: 'Quit' });

  const pick = await choose('How do you want to run it?', options);
  if (pick.id === 'quit') return rl.close();
  if (pick.id === 'install') {
    await cmdInstall({ ask });
    return rl.close();
  }
  if (pick.id === 'claude') {
    rl.close();
    const goal = args._.slice(1).join(' ');
    console.log(c.dim(`\n  claude --plugin-dir ${ROOT} "/sherlock:profile${goal ? ` ${goal}` : ''}"\n`));
    const code = await runInherit('claude', ['--plugin-dir', ROOT, `/sherlock:profile${goal ? ` ${goal}` : ''}`]);
    process.exit(code);
  }
  if (pick.id === 'agent') {
    rl.close();
    const { runAgent } = await import('../src/agent.mjs');
    return runAgent({ goal: args._.slice(1).join(' ') || undefined, yes: args.yes });
  }
  rl.close();
  const s = pick.s;
  if (s.build) console.log(c.dim(`\n  Build first if you haven't: ${s.build}`));
  if (s.tool === 'sherlock_web') return cmdOneShot('web', { ...args, _: ['web', s.command] });
  if (s.tool === 'sherlock_ios') return cmdOneShot('ios', { ...args, _: ['ios', s.command] });
  if (s.tool === 'sherlock_android') return cmdOneShot('android', { ...args, _: ['android', s.command] });
  const { splitCommand } = await import('../src/util.mjs');
  return cmdLaunch({ ...args, rest: splitCommand(s.command), 'ready-port': s.readyPort });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.version) return console.log(VERSION);
  if (args.help || cmd === 'help') return console.log(HELP);
  switch (cmd) {
    case undefined:
    case 'setup':
    case 'wizard':
      if (!process.stdin.isTTY) return console.log(HELP);
      return wizard(args);
    case 'mcp': {
      const { startMcpServer } = await import('../src/mcp.mjs');
      return startMcpServer();
    }
    case 'agent': {
      const { runAgent } = await import('../src/agent.mjs');
      return runAgent({ goal: args._.slice(1).join(' ') || undefined, yes: !!args.yes });
    }
    case 'launch':
      return cmdLaunch(args);
    case 'attach':
      return cmdAttach(args);
    case 'web':
    case 'ios':
    case 'android':
      return cmdOneShot(cmd, args);
    case 'interact':
      return cmdInteract(args);
    case 'detect':
      return cmdDetect(args);
    case 'report':
      return cmdReport(args);
    case 'install':
      return cmdInstall({});
    default:
      if (args.rest) return cmdLaunch({ ...args, _: ['launch'] });
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(c.red(`sherlock: ${err.message}`));
  process.exit(1);
});
