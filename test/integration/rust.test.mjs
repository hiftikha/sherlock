import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { launchNative } from '../../src/launch.mjs';
import { canSampleStacks } from '../../src/stacks.mjs';
import { run, which } from '../../src/util.mjs';

const DIR = fileURLToPath(new URL('../fixtures/rust-app/', import.meta.url));
const BIN = join(DIR, 'target/release/sherlock-fixture');
const host = process.platform === 'darwin' || process.platform === 'linux';

test('Rust: release binary startup, memory and hot functions', { skip: (!which('cargo') && 'needs cargo') || (!host && 'macOS and Linux only'), timeout: 300000 }, async () => {
  const build = await run('cargo', ['build', '--release', '--quiet'], { cwd: DIR, timeout: 280000 });
  assert.equal(build.code, 0, build.stderr);

  const session = launchNative({ argv: [BIN], readyLog: '^READY', env: { WAIT_MS: '200', BURN_MS: '400', CACHE_MB: '64', LIFE_MS: '3000' } });
  await session.done;
  session.stop();
  const j = session.toJSON();
  assert.ok(j.startup.readyMs >= 550 && j.startup.readyMs < 2500, `ready at ${j.startup.readyMs}`);
  assert.ok(j.summary.peakRssBytes >= 60 * 1024 * 1024, `peak rss ${j.summary.peakRssBytes}`);
  assert.ok(j.summary.peakCpuPct > 60);

  if (canSampleStacks()) {
    assert.ok(j.stacks.available, j.stacks.reason);
    assert.equal(j.stacks.fromFirstInstruction, true);
    const top = j.stacks.hot[0];
    assert.equal(top.symbol, 'sherlock_fixture::parse_config', `demangled hot function, got ${top.symbol}`);
    assert.ok(top.pctOfActive > 0.5);
    assert.ok(j.findings.some((f) => f.id === 'hot-function' && f.title.includes('parse_config')));
  }
});
