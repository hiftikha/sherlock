import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runAgent, DEFAULT_MODEL } from '../../src/agent.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const host = process.platform === 'darwin' || process.platform === 'linux';

function fakeClient(script) {
  const requests = [];
  let i = 0;
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params));
          return script[i++](params);
        },
      },
    },
  };
}

const toolUse = (id, name, input) => ({ id: `msg_${id}`, stop_reason: 'tool_use', content: [{ type: 'text', text: `Calling ${name}.` }, { type: 'tool_use', id, name, input }] });

test('agent loop: detect → launch → diagnosis, with tool results fed back', { skip: !host && 'macOS and Linux only', timeout: 60000 }, async () => {
  const app = join(ROOT, 'test/fixtures/apps/slow-start.mjs');
  const client = fakeClient([
    () => toolUse('t1', 'sherlock_detect', { dir: join(ROOT, 'test/fixtures/rust-app') }),
    () => toolUse('t2', 'sherlock_launch', { command: `${process.execPath} ${app}`, ready_log: '^READY', stacks: false, keep_alive: false }),
    () => toolUse('t3', 'read_file', { path: '../../../etc/passwd' }),
    () => ({ id: 'msg_end', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Startup is dominated by a busy loop.' }] }),
  ]);
  let out = '';
  const { transcript } = await runAgent({ client, goal: 'profile the fixture', root: ROOT, interactive: false, yes: true, log: (s) => (out += s) });

  assert.deepEqual(transcript, ['sherlock_detect', 'sherlock_launch', 'read_file']);
  const first = client.requests[0];
  assert.equal(first.model, DEFAULT_MODEL);
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(first.tools.some((t) => t.name === 'sherlock_launch'));
  assert.match(first.system, /drill pass/);

  const afterDetect = client.requests[1].messages.at(-1).content[0];
  assert.equal(afterDetect.type, 'tool_result');
  assert.equal(afterDetect.tool_use_id, 't1');
  assert.match(afterDetect.content, /"rust"/);

  const afterLaunch = client.requests[2].messages.at(-1).content[0];
  assert.match(afterLaunch.content, /READY/);
  assert.ok(JSON.parse(afterLaunch.content).metrics.startup);

  const escaped = client.requests[3].messages.at(-1).content[0];
  assert.equal(escaped.is_error, true);
  assert.match(escaped.content, /outside the project/);
  assert.match(out, /busy loop/);
});

test('agent loop: commands need approval when not interactive', async () => {
  const client = fakeClient([
    () => toolUse('t1', 'run_command', { command: 'echo hi' }),
    () => ({ id: 'msg_end', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
  ]);
  await runAgent({ client, goal: 'x', root: ROOT, interactive: false, yes: false, log: () => {} });
  const result = client.requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /approval/);
});

test('agent loop: stops on refusal', async () => {
  const client = fakeClient([() => ({ id: 'm', stop_reason: 'refusal', content: [] })]);
  let out = '';
  await runAgent({ client, goal: 'x', root: ROOT, interactive: false, log: (s) => (out += s) });
  assert.equal(client.requests.length, 1);
  assert.match(out, /declined/);
});
