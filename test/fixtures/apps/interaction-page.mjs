// A page with one slow interaction of each kind, used by the web interaction
// test and by scripts/record-trace-fixture.mjs:
//   click #open  → 120 ms handler, a fetch that takes ~300 ms, 40 ms of
//                  script, then 3000 list items rendered and #done added
//   key in #q    → 60 ms keydown handler
import { createServer } from 'node:http';

const PAGE = `<!doctype html><title>Sherlock interaction fixture</title>
<button id="open" style="width:200px;height:60px">Open list</button>
<input id="q" placeholder="type here">
<ul id="list"></ul>
<script>
const burn = (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} };
document.getElementById('open').addEventListener('click', async () => {
  burn(120);
  const items = await (await fetch('/api/items')).json();
  burn(40);
  document.getElementById('list').innerHTML = items.map((i) => '<li style="padding:2px">' + i + '</li>').join('');
  const done = document.createElement('div');
  done.id = 'done';
  document.body.append(done);
});
document.getElementById('q').addEventListener('keydown', () => burn(60));
</script>`;

export function startInteractionServer({ apiDelayMs = 300 } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/api/items') {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.from({ length: 3000 }, (_, i) => `item ${i}`)));
      }, apiDelayMs);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}
