import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { TOOLS, AGENT_TOOLS, callTool, closeDashboards } from './tools.mjs';
import { getSession, listSessions } from './session.mjs';
import { c } from './term.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MODEL = 'claude-opus-5-5';
const APPROVE = new Set(['run_command', 'sherlock_launch']);

async function playbook() {
  const text = await readFile(join(ROOT, 'skills/profile/SKILL.md'), 'utf8');
  return text.replace(/^---[\s\S]*?---\n/, '').replace('$ARGUMENTS', 'see the first user message');
}

export async function runAgent({ goal, root = process.cwd(), model = process.env.SHERLOCK_MODEL || DEFAULT_MODEL, interactive = process.stdin.isTTY, yes = false, client: injected, log = (s) => process.stdout.write(s) } = {}) {
  let Anthropic = null;
  if (!injected) {
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new Error('Agent mode needs the @anthropic-ai/sdk package. Run it through `npx sherlock-profiler agent`, or `npm install @anthropic-ai/sdk` next to Sherlock.');
    }
  }
  const client = injected ?? new Anthropic();
  const transcript = [];
  const system = `${await playbook()}

## Where you are

You are running inside the Sherlock CLI, not inside Claude Code. The project root is ${root} on ${process.platform}. Besides the sherlock_* tools you have read_file, search_code and run_command (the user approves each command and each launch). Keep messages short: the user reads them in a terminal while the dashboard shows the numbers.`;

  const tools = [...TOOLS, ...AGENT_TOOLS].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const messages = [{ role: 'user', content: goal || 'Run one complete drill pass on this project: detect it, measure its startup, open the dashboard, and tell me the most important thing to fix.' }];
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    for (let turn = 0; turn < 80; turn++) {
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'high' },
          system,
          tools,
          messages,
        });
      } catch (err) {
        if (Anthropic && err instanceof Anthropic.AuthenticationError) {
          throw new Error('The Claude API rejected the credentials. Set ANTHROPIC_API_KEY, or run `ant auth login`, or use `sherlock` inside Claude Code instead.');
        }
        if (Anthropic && err instanceof Anthropic.RateLimitError) {
          throw new Error('The Claude API is rate limiting this key. Wait a minute and run again.');
        }
        throw err;
      }

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) log(`\n${block.text.trim()}\n`);
      }

      if (response.stop_reason === 'refusal') {
        log(c.red('\nClaude declined to continue this request.\n'));
        break;
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason === 'max_tokens' && uses.length) {
        throw new Error('A tool call was cut off by the output limit. Run again with a narrower goal.');
      }
      messages.push({ role: 'assistant', content: response.content });

      if (!uses.length) {
        if (!rl) break;
        const next = (await rl.question(c.dim('\n› follow up (enter to finish): '))).trim();
        if (!next) break;
        messages.push({ role: 'user', content: next });
        continue;
      }

      const results = [];
      for (const u of uses) {
        results.push(
          await (async () => {
          const label = u.name === 'run_command' ? u.input.command : u.name === 'sherlock_launch' ? u.input.command : JSON.stringify(u.input);
          log(c.dim(`\n· ${u.name} ${label.length > 120 ? `${label.slice(0, 117)}…` : label}\n`));
          transcript.push(u.name);
          if (APPROVE.has(u.name) && !yes) {
            if (!rl) return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run: commands need approval and this run is not interactive (pass --yes to allow).' };
            const ok = (await rl.question(c.amber(`  run "${label}"? [y/N] `))).trim().toLowerCase();
            if (ok !== 'y' && ok !== 'yes') return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'The user declined this command.' };
          }
          try {
            const out = await callTool(u.name, u.input, { root });
            if (u.name === 'sherlock_dashboard' && out?.url) log(c.amber(`  dashboard: ${out.url}\n`));
            return { type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: err.message };
          }
          })(),
        );
      }
      messages.push({ role: 'user', content: results });
    }
    return { transcript, messages };
  } finally {
    rl?.close();
    for (const s of listSessions()) getSession(s.id)?.stop();
    await closeDashboards();
  }
}
