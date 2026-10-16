import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coalesce, parseInteractionTrace, parseJsProfile, SEGMENTS } from '../../src/parse/trace.mjs';
import { keyEvent } from '../../src/platform/web.mjs';

// Real traces from headless Chrome, recorded with scripts/record-trace-fixture.mjs
// against test/fixtures/apps/interaction-page.mjs.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/web/interaction-${name}.json`, import.meta.url), 'utf8'));
const sum = (totals) => Object.values(totals).reduce((a, b) => a + b, 0);

function assertContiguous(r) {
  assert.equal(r.segments[0].start, 0);
  for (let i = 1; i < r.segments.length; i++) assert.equal(r.segments[i].start, r.segments[i - 1].end, `segment ${i} starts where the previous ends`);
  assert.ok(Math.abs(r.segments.at(-1).end - r.totalMs) <= 0.1);
  assert.ok(Math.abs(sum(r.totals) - r.totalMs) <= 0.6, `totals ${sum(r.totals)} vs ${r.totalMs}`);
  for (const s of r.segments) assert.ok(SEGMENTS[s.key], s.key);
}

test('trace: click → handler → fetch → script → render → frame', () => {
  const r = parseInteractionTrace(fixture('click'));
  assert.equal(r.available, true);
  assert.equal(r.inputSource, 'event timing');
  assert.equal(r.frameShown, true);
  assert.equal(r.frameSource, 'Display::FrameDisplayed');
  assert.equal(r.endSignal, 'first frame after the last visual update');
  assertContiguous(r);
  assert.equal(r.slowest.key, 'network');
  assert.ok(r.totals.network >= 280 && r.totals.network <= 340, `network ${r.totals.network}`);
  assert.ok(r.totals.handlers >= 115 && r.totals.handlers <= 135, `handlers ${r.totals.handlers}`);
  assert.ok(r.totals.script >= 38, `script ${r.totals.script}`);
  assert.ok(r.totals.render > 5, `render ${r.totals.render}`);
  assert.deepEqual(
    r.segments.filter((s) => s.end - s.start > 5).map((s) => s.key),
    ['handlers', 'network', 'script', 'render'],
  );
  assert.equal(r.requests.length, 1);
  assert.match(r.requests[0].url, /\/api\/items$/);
  assert.equal(r.requests[0].status, 200);
  assert.match(r.scripts[0].invoker, /BUTTON#open\.click \(event handler\)/);
  assert.match(r.scripts[1].invoker, /Response\.json \(promise resolve\)/);
  assert.equal(r.render.layouts, 1);
  assert.ok(r.render.layoutObjects > 3000);
  assert.ok(r.eventTiming.events.includes('click'));
  assert.ok(r.eventTiming.processingMs >= 115);
  assert.ok(r.eventTiming.durationMs < r.totalMs, 'Event Timing stops at the first paint; the closed loop goes on to the result');
  assert.deepEqual(r.notes, []);
});

test('trace: a done condition ends the interaction at the frame after it', () => {
  const r = parseInteractionTrace(fixture('click-done'));
  assert.equal(r.endSignal, 'first frame after the done condition');
  assert.equal(r.frameShown, true);
  assertContiguous(r);
  assert.equal(r.slowest.key, 'network');
  assert.ok(r.totalMs > 450 && r.totalMs < 560, `total ${r.totalMs}`);
});

test('trace: a key press', () => {
  const r = parseInteractionTrace(fixture('key'));
  assertContiguous(r);
  assert.equal(r.slowest.key, 'handlers');
  assert.ok(r.totals.handlers >= 58, `handlers ${r.totals.handlers}`);
  assert.ok(r.eventTiming.events.includes('keydown'));
  assert.equal(r.requests.length, 0);
  assert.match(r.scripts[0].invoker, /INPUT#q\.keydown/);
});

test('trace: never invents a frame or an input time it did not see', () => {
  const noFrames = fixture('click').filter((e) => e.name !== 'Display::FrameDisplayed' && e.name !== 'AnimationFrame::Presentation');
  const r = parseInteractionTrace(noFrames);
  assert.equal(r.frameShown, false);
  assert.equal(r.frameSource, null);
  assert.equal(r.totals.frame, undefined);
  assert.match(r.notes[0], /frame presentation is not measured/);
  assert.equal(r.endSignal, 'last main-thread work');

  const noTiming = fixture('click').filter((e) => e.name !== 'EventTiming');
  const f = parseInteractionTrace(noTiming);
  assert.equal(f.available, true);
  assert.notEqual(f.inputSource, 'event timing');
  assert.equal(f.eventTiming, null);
  assert.ok(f.notes.some((n) => /Event Timing was not in the trace/.test(n)));

  const noInput = fixture('click').filter((e) => !['EventTiming', 'EventDispatch'].includes(e.name) && !e.name.startsWith('InputLatency::'));
  assert.equal(parseInteractionTrace(noInput).available, false);

  const noMark = fixture('click').filter((e) => e.name !== 'sherlock-start');
  const m = parseInteractionTrace(noMark);
  assert.equal(m.available, false);
  assert.match(m.reason, /sherlock-start/);
});

test('trace: V8 profile gives hot JS functions inside the window', () => {
  const events = fixture('click');
  const p = parseJsProfile(events);
  assert.equal(p.available, true);
  assert.equal(p.hot[0].symbol, 'burn');
  assert.match(p.hot[0].source, /:6$/);
  assert.ok(p.hot[0].ms > 100);
  assert.equal(parseJsProfile(fixture('key')).available, false);
  assert.equal(parseJsProfile(events, { fromTs: 0, toTs: 1 }).available, false);
});

test('trace: coalesce folds sub-millisecond runs for drawing', () => {
  const runs = [
    { key: 'network', start: 0, end: 10000 },
    { key: 'other', start: 10000, end: 10200 },
    { key: 'network', start: 10200, end: 30000 },
    { key: 'script', start: 30000, end: 40000 },
  ];
  assert.deepEqual(coalesce(runs), [
    { key: 'network', start: 0, end: 30000 },
    { key: 'script', start: 30000, end: 40000 },
  ]);
});

test('web: key events for named keys and characters', () => {
  assert.deepEqual(keyEvent('Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  assert.deepEqual(keyEvent('a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
  assert.equal(keyEvent('Space').key, ' ');
  assert.equal(keyEvent('ArrowDown').text, undefined);
  assert.throws(() => keyEvent('Hyper'), /Unknown key/);
});
