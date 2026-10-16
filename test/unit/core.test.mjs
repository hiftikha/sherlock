import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demangle } from '../../src/demangle.mjs';
import { detectProject } from '../../src/detect.mjs';
import { analyze, interactionLeak } from '../../src/findings.mjs';
import { splitCommand, formatBytes, formatMs, linearSlope, median } from '../../src/util.mjs';

const MB = 1024 * 1024;

test('demangles Rust v0, legacy Rust and C++ symbols', () => {
  assert.equal(demangle('_RNvCs56pTm1Ul87J_16sherlock_fixture12parse_config'), 'sherlock_fixture::parse_config');
  assert.equal(demangle('_RNvMs_NtCs1234_5tokio7runtimeNtB4_7Runtime8block_on'), 'tokio::runtime::Runtime::block_on');
  assert.equal(demangle('_ZN4core3ptr13drop_in_place17h0123456789abcdefE'), 'core::ptr::drop_in_place');
  assert.equal(demangle('_ZN3app6config4load17h1111111111111111E'), 'app::config::load');
  assert.equal(demangle('malloc'), 'malloc');
  assert.equal(demangle('v8::internal::Heap::CollectGarbage'), 'v8::internal::Heap::CollectGarbage');
});

test('util helpers', () => {
  assert.deepEqual(splitCommand(`./app --name "two words" 'single' a\\ b`), ['./app', '--name', 'two words', 'single', 'a b']);
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(406 * MB), '406 MB');
  assert.equal(formatMs(1840), '1.84 s');
  assert.equal(formatMs(612.4), '612 ms');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(linearSlope([[0, 0], [1, 2], [2, 4]]), 2);
});

async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), 'sherlock-detect-'));
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return dir;
}

test('detects a Rust binary', async () => {
  const dir = await project({ 'Cargo.toml': '[package]\nname = "fastcli"\nversion = "0.1.0"\n' });
  const d = detectProject(dir);
  assert.deepEqual(d.stacks, ['rust']);
  assert.equal(d.suggestions[0].command, './target/release/fastcli');
  assert.equal(d.suggestions[0].build, 'cargo build --release');
  await rm(dir, { recursive: true });
});

test('detects Tauri, Electron, Vite, Rust→WASM, iOS and Android projects', async () => {
  const tauri = await project({ 'package.json': JSON.stringify({ dependencies: { '@tauri-apps/api': '2' } }), 'src-tauri/Cargo.toml': '[package]\nname = "desk"\n' });
  assert.ok(detectProject(tauri).stacks.includes('tauri'));
  assert.equal(detectProject(tauri).suggestions[0].command, './src-tauri/target/release/desk');

  const electron = await project({ 'package.json': JSON.stringify({ scripts: { start: 'electron .' }, devDependencies: { electron: '33' } }) });
  assert.deepEqual(detectProject(electron).stacks, ['electron']);
  assert.equal(detectProject(electron).suggestions[0].command, 'npm run start');

  const vite = await project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }), 'pnpm-lock.yaml': '' });
  const v = detectProject(vite);
  assert.deepEqual(v.stacks, ['vite']);
  assert.equal(v.suggestions[0].command, 'pnpm dev');
  assert.equal(v.suggestions[0].readyPort, 5173);
  assert.equal(v.suggestions[1].tool, 'sherlock_web');

  const wasm = await project({ 'Cargo.toml': '[package]\nname = "w"\n[lib]\ncrate-type = ["cdylib"]\n[dependencies]\nwasm-bindgen = "0.2"\n' });
  assert.deepEqual(detectProject(wasm).stacks, ['rust-wasm']);

  const ios = await project({ 'App.xcodeproj/project.pbxproj': 'PRODUCT_BUNDLE_IDENTIFIER = com.acme.app;\nPRODUCT_BUNDLE_IDENTIFIER = com.acme.appTests;\n' });
  assert.equal(detectProject(ios).suggestions.find((s) => s.platform === 'ios').command, 'com.acme.app');

  const android = await project({ 'app/build.gradle.kts': 'android { defaultConfig { applicationId = "com.acme.droid" } }' });
  assert.equal(detectProject(android).suggestions.find((s) => s.platform === 'android').command, 'com.acme.droid');

  for (const d of [tauri, electron, vite, wasm, ios, android]) await rm(d, { recursive: true });
});

function session(samples, extra = {}) {
  return { samples, marks: [], phases: [], ...extra };
}

test('findings: waiting startup vs CPU-bound startup', () => {
  const waiting = analyze(
    session(
      Array.from({ length: 12 }, (_, i) => ({ t: i * 100, cpuPct: 5, rssBytes: 50 * MB })),
      { startup: { readyMs: 1100, readySignal: 'log: READY' }, phases: [{ name: 'init → ready', start: 0, end: 1100 }] },
    ),
  );
  assert.ok(waiting.find((f) => f.id === 'startup-waiting'));
  assert.equal(waiting.find((f) => f.id === 'startup-total').severity, 'medium');

  const busy = analyze(session(Array.from({ length: 12 }, (_, i) => ({ t: i * 100, cpuPct: 99, rssBytes: 50 * MB })), { startup: { readyMs: 1100 } }));
  assert.ok(busy.find((f) => f.id === 'startup-cpu-bound'));
});

test('findings: hot function and main-thread bound from stacks', () => {
  const f = analyze(
    session([], {
      stacks: {
        available: true,
        activeSamples: 100,
        threads: [{ name: 'com.apple.main-thread', samples: 100, activeSamples: 95 }],
        hot: [{ symbol: 'app::config::load', module: 'app', thread: 'com.apple.main-thread', self: 60, pctOfActive: 0.6 }],
      },
    }),
  );
  assert.equal(f[0].id, 'hot-function');
  assert.equal(f[0].severity, 'high');
  assert.ok(f.find((x) => x.id === 'main-thread-bound'));
});

test('findings: memory each repeated interaction keeps', () => {
  const samples = [];
  let rss = 300 * MB;
  const marks = [];
  for (let i = 0; i < 40; i++) {
    const t = i * 250;
    if (i % 10 === 2) marks.push({ label: 'open doc', t });
    if (i % 10 === 4) rss += 8 * MB;
    samples.push({ t, cpuPct: 1, rssBytes: rss });
  }
  const leak = interactionLeak({ samples, marks });
  assert.ok(leak);
  assert.equal(leak.severity, 'high');
  assert.match(leak.title, /open doc/);
  assert.ok(Math.abs(leak.metric - 8 * MB) < 0.01 * MB);

  const flat = interactionLeak({ samples: samples.map((s) => ({ ...s, rssBytes: 300 * MB })), marks });
  assert.equal(flat, null);
});

test('findings: idle is clean vs busy idle', () => {
  const quiet = Array.from({ length: 30 }, (_, i) => ({ t: i * 250, cpuPct: i < 4 ? 90 : 0.3, rssBytes: 40 * MB }));
  assert.ok(analyze(session(quiet, { startup: { readyMs: 500 } })).find((f) => f.id === 'idle-clean'));
  const spinning = quiet.map((s) => ({ ...s, cpuPct: 25 }));
  assert.equal(analyze(session(spinning, { startup: { readyMs: 500 } })).find((f) => f.id === 'idle-busy').severity, 'high');
});

test('findings: web vitals and android start', () => {
  const f = analyze(session([], { web: { vitals: { lcpMs: 4200, ttfbMs: 900, fcpMs: 1200, loadMs: 3000 }, longTasks: { count: 4, totalMs: 700 }, transfer: { bytes: 3 * MB, requests: 40 } } }));
  assert.equal(f.find((x) => x.id === 'web-lcp').severity, 'high');
  assert.ok(f.find((x) => x.id === 'web-ttfb'));
  assert.ok(f.find((x) => x.id === 'web-long-tasks'));
  assert.ok(f.find((x) => x.id === 'web-weight'));
  const a = analyze(session([], { mobile: { os: 'android', totalTimeMs: 6000, launchState: 'COLD' } }));
  assert.equal(a.find((x) => x.id === 'android-start').severity, 'high');
});
