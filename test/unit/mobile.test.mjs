import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmStart, parseDumpsysMeminfo, parseResolveActivity, parsePidof, parseSimctlLaunch, parseBootedDevices } from '../../src/parse/mobile.mjs';

test('android: am start -W cold start', () => {
  const r = parseAmStart(`Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] cmp=com.example.app/.MainActivity }
Status: ok
LaunchState: COLD
Activity: com.example.app/.MainActivity
TotalTime: 1234
WaitTime: 1250
Complete
`);
  assert.equal(r.status, 'ok');
  assert.equal(r.launchState, 'COLD');
  assert.equal(r.totalTimeMs, 1234);
  assert.equal(r.waitTimeMs, 1250);
  assert.equal(r.error, null);
});

test('android: am start error', () => {
  const r = parseAmStart('Starting: Intent { cmp=com.nope/.Main }\nError type 3\nError: Activity class {com.nope/com.nope.Main} does not exist.\n');
  assert.match(r.error, /does not exist/);
});

test('android: dumpsys meminfo app summary', () => {
  const m = parseDumpsysMeminfo(`Applications Memory Usage (in Kilobytes):
 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:     8000                          20000
         Native Heap:    12000                          13000
                Code:     4000                          30000
            Graphics:     6000                           6000
               TOTAL PSS:    41000            TOTAL RSS:    90000       TOTAL SWAP PSS:       10
`);
  assert.equal(m.totalPssBytes, 41000 * 1024);
  assert.equal(m.totalRssBytes, 90000 * 1024);
  assert.equal(m.javaHeapBytes, 8000 * 1024);
  assert.equal(m.nativeHeapBytes, 12000 * 1024);
  assert.equal(m.graphicsBytes, 6000 * 1024);
});

test('android: resolve-activity and pidof', () => {
  assert.equal(parseResolveActivity('priority=0 preferredOrder=0\ncom.example.app/.MainActivity\n'), 'com.example.app/.MainActivity');
  assert.equal(parseResolveActivity('No activity found\n'), null);
  assert.equal(parsePidof('4321\n'), 4321);
  assert.equal(parsePidof(''), null);
});

test('ios: simctl launch output and booted devices', () => {
  assert.deepEqual(parseSimctlLaunch('com.apple.Preferences: 20898\n'), { bundleId: 'com.apple.Preferences', pid: 20898 });
  assert.equal(parseSimctlLaunch('An error was encountered'), null);
  const booted = parseBootedDevices({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{ udid: 'A', name: 'iPhone 17 Pro', state: 'Booted' }, { udid: 'B', name: 'iPhone SE', state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-26-4': [],
    },
  });
  assert.deepEqual(booted, [{ udid: 'A', name: 'iPhone 17 Pro', runtime: 'iOS-26-4' }]);
});
