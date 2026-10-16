// Records the DevTools traces behind test/fixtures/web/*.json from a real
// headless Chrome, trimmed to the events Sherlock's trace parser reads.
//   node scripts/record-trace-fixture.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { profileWeb, interactWeb } from '../src/platform/web.mjs';
import { startInteractionServer } from '../test/fixtures/apps/interaction-page.mjs';

const OUT = fileURLToPath(new URL('../test/fixtures/web/', import.meta.url));

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
      if (e.name === 'RunTask') return e.pid === renderer && e.tid === mainTid && e.dur >= 50;
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

const server = await startInteractionServer();
const session = await profileWeb({ url: server.url, keepOpen: true, settleMs: 300 });
try {
  const record = async (file, opts) => {
    let raw;
    const r = await interactWeb(session, { ...opts, onTrace: (e) => (raw = e) });
    const events = trim(raw);
    await writeFile(`${OUT}${file}`, `${JSON.stringify(events)}\n`);
    console.log(file, events.length, 'events', `total ${r.totalMs} ms`, `slowest ${r.slowest?.label} ${r.slowest?.ms} ms`);
  };
  await record('interaction-click.json', { selector: '#open', label: 'open list', stacks: true });
  await session.cdp.send('Runtime.evaluate', { expression: `document.getElementById('done').remove(); document.getElementById('list').innerHTML = ''` });
  await new Promise((r) => setTimeout(r, 300));
  await record('interaction-click-done.json', { selector: '#open', label: 'open list', doneSelector: '#done' });
  await record('interaction-key.json', { selector: '#q', key: 'a', label: 'type a' });
} finally {
  session.stop();
  server.close();
}
