// Trims a raw DevTools trace from an interaction down to the events
// src/parse/trace.mjs reads, so it can be committed as a test fixture.
//   node scripts/trim-trace.mjs raw.json test/fixtures/web/interaction-<name>.json
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const KEEP = new Set([
  'thread_name', 'process_name', 'EventTiming', 'EventDispatch', 'FunctionCall', 'RunTask', 'AnimationFrame::Script::Execute',
  'ResourceSendRequest', 'ResourceReceiveResponse', 'ResourceFinish', 'Display::FrameDisplayed', 'AnimationFrame::Presentation',
  'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'TimerFire', 'FireAnimationFrame', 'FireIdleCallback',
  'EvaluateScript', 'MinorGC', 'MajorGC', 'ParseHTML', 'Profile', 'ProfileChunk',
  'InputLatency::MouseDown', 'InputLatency::MouseUp', 'InputLatency::KeyPress', 'InputLatency::RawKeyDown', 'InputLatency::Char', 'InputLatency::KeyUp',
]);

export function trim(events) {
  const start = events.find((e) => e.name === 'sherlock-start');
  const renderer = start.pid;
  const mainTid = start.tid;
  const window = [start.ts - 20000, Math.max(...events.filter((e) => e.name === 'sherlock-cutoff').map((e) => e.ts)) + 300000];
  return events
    .filter((e) => {
      if (e.ph === 'M') return KEEP.has(e.name);
      if (e.ts < window[0] || e.ts > window[1]) return false;
      if (String(e.cat).includes('user_timing')) return e.name.startsWith('sherlock-');
      if (!KEEP.has(e.name)) return false;
      if (e.name === 'RunTask') return e.pid === renderer && (e.tid === mainTid ? e.dur >= 50 : e.dur >= 1000);
      if (e.name === 'Display::FrameDisplayed' || e.name.startsWith('InputLatency::')) return true;
      return e.pid === renderer;
    })
    .map((e) => {
      const copy = { ...e };
      delete copy.tts;
      delete copy.tdur;
      if (copy.args?.data?.headers) copy.args = { ...copy.args, data: { ...copy.args.data, headers: undefined } };
      return copy;
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/trim-trace.mjs <raw.json> <out.json>');
    process.exit(1);
  }
  const events = trim(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, `${JSON.stringify(events)}\n`);
  console.log(output, events.length, 'events');
}
