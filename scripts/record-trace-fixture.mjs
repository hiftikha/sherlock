// Records the DevTools traces behind test/fixtures/web/*.json from a real
// headless Chrome, trimmed to the events Sherlock's trace parser reads.
//   node scripts/record-trace-fixture.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { profileWeb, interactWeb } from '../src/platform/web.mjs';
import { startInteractionServer } from '../test/fixtures/apps/interaction-page.mjs';
import { trim } from './trim-trace.mjs';

const OUT = fileURLToPath(new URL('../test/fixtures/web/', import.meta.url));

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
