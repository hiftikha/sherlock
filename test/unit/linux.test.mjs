import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcStat, parseProcStatus, parseProcIo, parseNetDev, parsePerfInterval, perfBandwidth } from '../../src/parse/linux.mjs';
import { createHostSampler } from '../../src/platform/host.mjs';

const stat = (pid, ppid, comm, utime, stime, threads = 4) =>
  `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 1000 0 0 0 ${utime} ${stime} 0 0 20 0 ${threads} 0 12345 100000000 2000 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0`;

const status = (name, rssKb, threads = 4) => `Name:\t${name}\nState:\tS (sleeping)\nVmHWM:\t  ${rssKb + 100} kB\nVmRSS:\t  ${rssKb} kB\nThreads:\t${threads}\n`;

const netdev = (rx, tx) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  999999     10    0    0    0     0          0         0   999999      10    0    0    0     0       0          0
  eth0: ${rx}     100    0    0    0     0          0         0 ${tx}      80    0    0    0     0       0          0
`;

test('/proc/<pid>/stat with spaces and parens in the name', () => {
  const s = parseProcStat(stat(4242, 1, 'my (weird) app', 150, 50, 9));
  assert.equal(s.pid, 4242);
  assert.equal(s.comm, 'my (weird) app');
  assert.equal(s.ppid, 1);
  assert.equal(s.utimeTicks, 150);
  assert.equal(s.stimeTicks, 50);
  assert.equal(s.numThreads, 9);
});

test('/proc/<pid>/status memory and threads', () => {
  assert.deepEqual(parseProcStatus(status('app', 2048, 7)), { name: 'app', rssBytes: 2048 * 1024, peakRssBytes: 2148 * 1024, threads: 7 });
});

test('/proc/<pid>/io bytes', () => {
  assert.deepEqual(parseProcIo('rchar: 10\nwchar: 20\nread_bytes: 4096\nwrite_bytes: 8192\n'), { readBytes: 4096, writeBytes: 8192 });
});

test('/proc/net/dev skips loopback', () => {
  assert.deepEqual(parseNetDev(netdev(5000, 7000)), { bytesIn: 5000, bytesOut: 7000 });
});

test('perf interval lines and bandwidth estimate', () => {
  const a = parsePerfInterval('     1.001234567,1000000,,LLC-load-misses,1000000,100.00,,');
  const b = parsePerfInterval('     1.001234567,500000,,LLC-store-misses,1000000,100.00,,');
  assert.deepEqual(a, { time: 1.001234567, count: 1000000, event: 'LLC-load-misses' });
  assert.equal(perfBandwidth([a, b]), 1500000 * 64);
  assert.equal(perfBandwidth([parsePerfInterval('1.0,<not supported>,,LLC-load-misses,0,0,,')]), null);
  assert.equal(parsePerfInterval('# started on'), null);
});

test('Linux sampler: process tree CPU, memory, threads and network from /proc', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sherlock-proc-'));
  const proc = async (pid, files) => {
    await mkdir(join(root, String(pid), 'net'), { recursive: true });
    for (const [f, text] of Object.entries(files)) await writeFile(join(root, String(pid), f), text);
  };
  try {
    await proc(100, { stat: stat(100, 1, 'app', 100, 0, 6), status: status('app', 10000, 6), io: 'read_bytes: 0\nwrite_bytes: 0\n', 'net/dev': netdev(0, 0) });
    await proc(101, { stat: stat(101, 100, 'helper', 50, 0), status: status('helper', 5000), io: 'read_bytes: 0\nwrite_bytes: 0\n' });
    await proc(200, { stat: stat(200, 1, 'other', 9999, 0), status: status('other', 99999) });
    const sampler = createHostSampler(100, { platform: 'linux', procRoot: root, memBandwidth: false });
    const first = await sampler.sample(1000);
    assert.equal(first.cpuPct, null);
    assert.equal(first.rssBytes, 15000 * 1024);
    assert.equal(first.threads, 6);
    assert.equal(first.processes.length, 2);

    await proc(100, { stat: stat(100, 1, 'app', 150, 0, 6), status: status('app', 12000, 6), io: 'read_bytes: 1048576\nwrite_bytes: 0\n', 'net/dev': netdev(2048, 1024) });
    const second = await sampler.sample(1500);
    assert.ok(Math.abs(second.cpuPct - 100) < 1e-6, `0.5 s of CPU in 0.5 s wall is 100%, got ${second.cpuPct}`);
    assert.equal(second.rssBytes, 17000 * 1024);
    assert.equal(second.diskReadBps, 2 * 1048576);
    assert.equal(second.netInBps, 4096);
    assert.equal(second.alive, true);
    assert.equal(sampler.capabilities.memBandwidth, null);
    assert.match(sampler.capabilities.memBandwidthReason, /perf/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
