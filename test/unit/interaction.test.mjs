import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markSummaries } from '../../src/interaction.mjs';
import { analyze, interactionFindings } from '../../src/findings.mjs';
import { parseInteractionTrace } from '../../src/parse/trace.mjs';

const MB = 1024 * 1024;
const click = JSON.parse(readFileSync(new URL('../fixtures/web/interaction-click.json', import.meta.url), 'utf8'));

function samplesWithBurst({ markAt, busyFor, step = 100, rssAfter = 0 }) {
  const out = [];
  for (let t = 0; t <= 6000; t += step) {
    const busy = t > markAt && t <= markAt + busyFor;
    out.push({ t, cpuPct: busy ? 95 : 1, rssBytes: 100 * MB + (t > markAt + 200 ? rssAfter : 0) });
  }
  return out;
}

test('markSummaries: busy time, CPU and memory after each mark', () => {
  const samples = samplesWithBurst({ markAt: 1000, busyFor: 800, rssAfter: 12 * MB });
  const [m] = markSummaries([{ label: 'open doc', t: 1000, source: 'user' }], samples);
  assert.equal(m.label, 'open doc');
  assert.equal(m.busyMs, 800);
  assert.equal(m.settled, true);
  assert.equal(m.cpuPeakPct, 95);
  assert.equal(m.cpuAvgPct, 95);
  assert.equal(m.rssBeforeBytes, 100 * MB);
  assert.equal(m.rssDeltaBytes, 12 * MB);
  assert.equal(m.resolutionMs, 100);

  const two = markSummaries(
    [
      { label: 'a', t: 1000 },
      { label: 'b', t: 1300 },
    ],
    samples,
  );
  assert.equal(two[0].windowMs, 300, 'a window ends at the next mark');
  assert.equal(two[0].settled, false);

  const idle = markSummaries([{ label: 'noop', t: 1000 }], samplesWithBurst({ markAt: 1000, busyFor: 0 }));
  assert.equal(idle[0].busyMs, 0);
  assert.deepEqual(markSummaries([{ label: 'late', t: 5990 }], samples), [], 'no summary without samples after the mark');
});

test('findings: "slowest segment of <label> is X ms" from a web breakdown', () => {
  const r = { kind: 'web', label: 'open list', t: 2000, input: 'click #open', ...parseInteractionTrace(click) };
  const f = interactionFindings({ interactions: [r, { ...r, t: 4000, totalMs: r.totalMs - 20 }], marks: [], samples: [] });
  const seg = f.find((x) => x.id === 'interaction-slowest-segment');
  assert.ok(seg);
  assert.match(seg.title, /^Slowest segment of "open list" is network: \d+ ms$/);
  assert.equal(seg.segment, 'network');
  assert.equal(seg.severity, r.totalMs > 500 ? 'high' : 'medium');
  assert.match(seg.evidence[0], /input → frame shown \d+ ms \(slowest of 2 runs; median \d+ ms\)/);
  assert.ok(seg.evidence.some((e) => /slowest request GET .*\/api\/items/.test(e)));
  assert.ok(seg.evidence.some((e) => /^Event Timing/.test(e)));
  assert.match(seg.suggestion, /network/);

  const failed = interactionFindings({ interactions: [{ kind: 'web', label: 'miss', available: false, reason: 'no input event' }] });
  assert.equal(failed[0].id, 'interaction-unmeasured');
  assert.equal(failed[0].evidence[0], 'no input event');

  const viaAnalyze = analyze({ samples: [], marks: [], phases: [], interactions: [r] });
  assert.ok(viaAnalyze.some((x) => x.id === 'interaction-slowest-segment'));
});

test('findings: native interactions report busy time and the hottest function', () => {
  const samples = samplesWithBurst({ markAt: 1000, busyFor: 1500 });
  const marks = [
    { label: 'export', t: 1000, source: 'agent' },
    { label: 'navigate', t: 100, source: 'sherlock' },
  ];
  const stacks = {
    available: true,
    tool: 'macOS sample',
    window: '1.0s–3.0s',
    hot: [{ symbol: 'app::export::encode', module: 'app', thread: 'main', pctOfActive: 0.72 }],
  };
  const f = interactionFindings({ samples, marks, interactions: [{ kind: 'native', label: 'export', t: 1000, stacks }] });
  const busy = f.find((x) => x.id === 'interaction-busy');
  assert.equal(busy.title, '"export" keeps the CPU busy for 1.50 s');
  assert.equal(busy.severity, 'high');
  assert.ok(!f.some((x) => x.id === 'interaction-busy' && x.label === 'navigate'), "Sherlock's own marks are not interactions");
  const hot = f.find((x) => x.id === 'interaction-hot-function');
  assert.equal(hot.title, 'app::export::encode is the hottest function during "export"');
  assert.match(hot.evidence.at(-1), /1\.0s–3\.0s with macOS sample/);
});
