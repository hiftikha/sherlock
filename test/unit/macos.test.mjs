import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCpuTime, parsePsTable, descendants, parsePsThreads, parseNettop, parseIoregGpu, parseSample } from '../../src/parse/macos.mjs';

const fx = (f) => readFileSync(new URL(`../fixtures/macos/${f}`, import.meta.url), 'utf8');

test('cpu time formats from ps', () => {
  assert.equal(parseCpuTime('0:00.31'), 0.31);
  assert.equal(parseCpuTime('118:50.87'), 118 * 60 + 50.87);
  assert.equal(parseCpuTime('1:02:03.50'), 3723.5);
  assert.equal(parseCpuTime('2-01:00:00'), 2 * 86400 + 3600);
});

test('ps table parses pids, cpu seconds and rss bytes', () => {
  const rows = parsePsTable(fx('ps-table.txt'));
  assert.ok(rows.length >= 10);
  const launchd = rows.find((r) => r.pid === 1);
  assert.equal(launchd.ppid, 0);
  assert.equal(launchd.rssBytes, 18224 * 1024);
  assert.ok(launchd.cpuSeconds > 7000);
  assert.match(launchd.command, /launchd/);
});

test('descendants walks the process tree', () => {
  const rows = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 1 },
  ];
  assert.deepEqual([...descendants(rows, 10)].sort(), [10, 11, 12]);
});

test('ps -M thread rows', () => {
  const threads = parsePsThreads(fx('ps-threads.txt'));
  assert.equal(threads.length, 4);
  assert.equal(threads[0].cpuPct, 12.5);
  assert.ok(Math.abs(threads[2].cpuSeconds - 1.6) < 1e-9);
});

test('nettop sums bytes per pid', () => {
  const m = parseNettop(fx('nettop.txt'));
  assert.deepEqual(m.get(4242), { bytesIn: 1024, bytesOut: 2076 });
  assert.deepEqual(m.get(4243), { bytesIn: 500, bytesOut: 0 });
  assert.equal(m.has(NaN), false);
});

test('ioreg GPU utilization', () => {
  const g = parseIoregGpu(`"PerformanceStatistics" = {"Tiler Utilization %"=10,"Device Utilization %"=73,"In use system memory"=1945272320}`);
  assert.deepEqual(g, { utilizationPct: 73, inUseBytes: 1945272320 });
  assert.equal(parseIoregGpu('nothing here'), null);
  const real = fx('ioreg-gpu.txt');
  if (real.includes('Device Utilization')) assert.equal(typeof parseIoregGpu(real).utilizationPct, 'number');
});

test('sample call graph: threads, idle filtering and hot self time', () => {
  const r = parseSample(fx('sample-node.txt'));
  assert.equal(r.threads.length, 7);
  assert.equal(r.threads[0].name, 'com.apple.main-thread');
  assert.ok(r.totalSamples > 5000);
  assert.ok(r.activeSamples > 0 && r.activeSamples < 100, 'idle waits are not counted as busy');
  assert.ok(r.hot.every((h) => !['kevent', '__psynch_cvwait', 'semaphore_wait_trap'].includes(h.symbol)));
  const names = r.hot.map((h) => h.symbol);
  assert.ok(names.some((n) => n.includes('NewFixedArray')));
  const total = r.hot.reduce((a, h) => a + h.pctOfActive, 0);
  assert.ok(Math.abs(total - 1) < 0.01);
});

test('sample text without a call graph', () => {
  assert.deepEqual(parseSample('Sampling process 1 for 1 second'), { totalSamples: 0, threads: [], hot: [] });
});

test('footprint bytes per pid', async () => {
  const { parseFootprint } = await import('../../src/parse/macos.mjs');
  const m = parseFootprint(fx('footprint.txt'));
  assert.equal(m.size, 2);
  const [first] = m.values();
  assert.ok(first > 1024 * 1024);
  assert.deepEqual([...parseFootprint('app [42]: 64-bit    Footprint: 97 MB (16384 bytes per page)').entries()], [[42, 97 * 1024 * 1024]]);
});
