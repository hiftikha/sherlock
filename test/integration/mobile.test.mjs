import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { profileIos, profileAndroid, bootedSimulators, androidDevices } from '../../src/platform/mobile.mjs';
import { run, which } from '../../src/util.mjs';

const BIN = fileURLToPath(new URL('../fixtures/bin/', import.meta.url));
const host = process.platform === 'darwin' || process.platform === 'linux';

async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('iOS: launch flow against a simulated simctl', { skip: !host && 'macOS and Linux only', timeout: 60000 }, () =>
  withEnv({ SHERLOCK_XCRUN: `${BIN}xcrun` }, async () => {
    const session = await profileIos({ bundleId: 'com.fake.app', settleMs: 400 });
    const j = session.toJSON();
    try {
      process.kill(j.mobile.pid);
    } catch {}
    assert.equal(j.kind, 'ios');
    assert.equal(j.meta.device, 'iPhone Fake');
    assert.ok(j.mobile.pid > 0);
    assert.ok(j.mobile.launchMs >= j.mobile.launchCommandMs);
    assert.ok(j.samples.length > 0);
    assert.ok(j.summary.peakRssBytes > 30 * 1024 * 1024, `rss ${j.summary.peakRssBytes}`);
    assert.ok(j.findings.some((f) => f.id === 'ios-start'));
  }),
);

test('iOS: real booted Simulator', { skip: process.platform !== 'darwin' && 'macOS only', timeout: 90000 }, async (t) => {
  if (!which('xcrun') || !(await bootedSimulators()).length) return t.skip('no booted iOS Simulator');
  const session = await profileIos({ bundleId: 'com.apple.Preferences' });
  const j = session.toJSON();
  await run('xcrun', ['simctl', 'terminate', 'booted', 'com.apple.Preferences']);
  assert.ok(j.mobile.pid > 0);
  assert.ok(j.mobile.launchMs > 0);
  assert.ok(j.summary.peakRssBytes > 0);
});

test('Android: cold start and live sampling against a simulated adb', { timeout: 60000 }, () =>
  withEnv({ SHERLOCK_ADB: `${BIN}adb` }, async () => {
    const session = await profileAndroid({ target: 'com.fake.app', observeMs: 2200, intervalMs: 300 });
    const j = session.toJSON();
    assert.equal(j.kind, 'android');
    assert.equal(j.target, 'com.fake.app/.MainActivity');
    assert.equal(j.mobile.totalTimeMs, 842);
    assert.equal(j.mobile.launchState, 'COLD');
    assert.equal(j.mobile.pid, 31337);
    assert.equal(j.startup.readyMs, 842);
    assert.ok(j.samples.length >= 3);
    const last = j.samples.at(-1);
    assert.ok(last.rssBytes > 100 * 1024 * 1024);
    assert.equal(last.pssBytes, 41000 * 1024);
    assert.equal(last.threads, 23);
    assert.ok(j.samples.some((s) => s.cpuPct != null));
    assert.equal(j.findings.find((f) => f.id === 'android-start').severity, 'ok');
  }),
);

test('Android: real device or emulator', { timeout: 90000 }, async (t) => {
  if (!which('adb') || !(await androidDevices()).length) return t.skip('no adb device');
  const session = await profileAndroid({ target: 'com.android.settings', observeMs: 2000 });
  assert.ok(session.mobile.totalTimeMs > 0);
});
