import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, which } from './util.mjs';
import { parseSample } from './parse/macos.mjs';

export function canSampleStacks() {
  return process.platform === 'darwin' && !!which('sample');
}

const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'ruby', 'java', 'bash', 'sh', 'zsh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'go', 'swift', 'dotnet', 'env', 'electron', 'Electron']);

export function canWaitForName(executable) {
  const base = executable.split('/').pop();
  return canSampleStacks() && base.length >= 3 && !INTERPRETERS.has(base);
}

export function startWaitingSampler(executable, seconds = 3) {
  const base = executable.split('/').pop();
  return sampleStacks(base, seconds, 1, ['-wait']);
}

export async function sampleStacks(pid, seconds = 2, intervalMs = 1, extra = []) {
  if (!canSampleStacks()) {
    return { available: false, reason: process.platform === 'linux' ? 'Call stacks on Linux need `perf record`; not wired up in this release.' : 'Call stacks need macOS `sample`.' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'sherlock-sample-'));
  const file = join(dir, 'sample.txt');
  try {
    const r = await run('sample', [String(pid), String(Math.max(1, Math.round(seconds))), String(intervalMs), ...extra, '-mayDie', '-file', file], {
      timeout: (seconds + 20) * 1000,
    });
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      text = r.stdout;
    }
    const parsed = parseSample(text);
    if (!parsed.totalSamples) return { available: false, reason: (r.stderr || 'sample produced no call graph').trim().split('\n')[0] };
    if (!parsed.activeSamples) return { available: false, tool: 'macOS sample', seconds, reason: 'Every captured sample was idle. The busy part finished before the sampler attached; use a compiled binary (sampled from its first instruction) or sample during an interaction.' };
    return { available: true, tool: 'macOS sample', seconds, ...parsed };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
