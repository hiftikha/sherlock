import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { analyze } from './findings.mjs';

export class Session extends EventEmitter {
  constructor({ kind, target, platform, meta = {} }) {
    super();
    this.setMaxListeners(50);
    this.id = randomUUID().slice(0, 8);
    this.kind = kind;
    this.target = target;
    this.platform = platform;
    this.meta = { host: hostname(), node: process.version, ...meta };
    this.createdAt = new Date().toISOString();
    this.t0 = performance.now();
    this.samples = [];
    this.marks = [];
    this.phases = [];
    this.events = [];
    this.startup = null;
    this.stacks = null;
    this.web = null;
    this.mobile = null;
    this.capabilities = {};
    this.status = 'starting';
    this.output = [];
    this.error = null;
    this.findings = [];
    this.notes = [];
    this.sampler = null;
    this.timer = null;
    this.stopped = false;
  }

  elapsed(t = performance.now()) {
    return Math.round(t - this.t0);
  }

  addSample(sample) {
    const s = { ...sample, t: this.elapsed(sample.t) };
    this.samples.push(s);
    if (this.samples.length > 20000) this.samples.splice(0, this.samples.length - 20000);
    this.emit('sample', s);
    return s;
  }

  mark(label, { source = 'user', at } = {}) {
    const m = { label: String(label).slice(0, 80), t: at ?? this.elapsed(), source };
    this.marks.push(m);
    this.emit('mark', m);
    return m;
  }

  phase(name, start, end, detail) {
    const p = { name, start, end, detail };
    this.phases.push(p);
    this.emit('phase', p);
    return p;
  }

  note(title, body = '') {
    const n = { t: this.elapsed(), title: String(title).slice(0, 200), body: String(body).slice(0, 4000) };
    this.notes.push(n);
    this.emit('note', n);
    return n;
  }

  event(type, data = {}) {
    const e = { type, t: this.elapsed(), ...data };
    this.events.push(e);
    this.emit('event', e);
    return e;
  }

  log(stream, text) {
    const line = { stream, t: this.elapsed(), text: text.slice(0, 500) };
    this.output.push(line);
    if (this.output.length > 400) this.output.shift();
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  startSampling(sampler, intervalMs = 250) {
    this.sampler = sampler;
    this.capabilities = sampler.capabilities ?? {};
    const loop = async () => {
      if (this.stopped) return;
      const begin = performance.now();
      try {
        const s = await sampler.sample(begin);
        if (this.stopped) return;
        this.addSample(s);
        if (this.samples.length % Math.max(4, Math.round(2000 / intervalMs)) === 0) this.refreshFindings();
        if (s.alive === false && this.status !== 'exited') {
          this.setStatus('exited');
          this.event('exit');
          this.stop();
          return;
        }
      } catch (err) {
        this.event('sampler-error', { message: err.message });
      }
      const spent = performance.now() - begin;
      this.timer = setTimeout(loop, Math.max(10, intervalMs - spent));
    };
    loop();
  }

  refreshFindings() {
    this.findings = analyze(this.toJSON({ findings: false }));
    this.emit('findings', this.findings);
    return this.findings;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.sampler?.stop?.();
    if (!['exited', 'failed'].includes(this.status)) this.setStatus('stopped');
    this.refreshFindings();
    this.emit('stopped');
  }

  summary() {
    const live = this.samples.filter((s) => s.cpuPct != null);
    const peak = (k) => this.samples.reduce((m, s) => (s[k] != null && (m == null || s[k] > m) ? s[k] : m), null);
    const last = this.samples[this.samples.length - 1] ?? null;
    return {
      durationMs: this.elapsed(),
      samples: this.samples.length,
      startupMs: this.startup?.readyMs ?? this.startup?.settledMs ?? null,
      peakCpuPct: peak('cpuPct'),
      avgCpuPct: live.length ? live.reduce((a, s) => a + s.cpuPct, 0) / live.length : null,
      peakRssBytes: peak('rssBytes'),
      currentRssBytes: last?.rssBytes ?? null,
      peakGpuPct: peak('gpuPct'),
      peakMemBandwidthBps: peak('memBandwidthBps'),
      peakNetInBps: peak('netInBps'),
      peakNetOutBps: peak('netOutBps'),
      threads: last?.threads ?? null,
      processes: last?.processes?.length ?? null,
    };
  }

  toJSON({ findings = true } = {}) {
    return {
      id: this.id,
      kind: this.kind,
      target: this.target,
      platform: this.platform,
      status: this.status,
      createdAt: this.createdAt,
      meta: this.meta,
      capabilities: this.capabilities,
      startup: this.startup,
      phases: this.phases,
      marks: this.marks,
      events: this.events,
      stacks: this.stacks,
      web: this.web,
      mobile: this.mobile,
      error: this.error,
      summary: this.summary(),
      samples: this.samples,
      output: this.output.slice(-60),
      findings: findings ? this.findings : [],
      notes: this.notes,
    };
  }
}

const sessions = new Map();

export function registerSession(session) {
  sessions.set(session.id, session);
  return session;
}

export function getSession(id) {
  if (id) return sessions.get(id) ?? null;
  const all = [...sessions.values()];
  return all[all.length - 1] ?? null;
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ id: s.id, kind: s.kind, target: s.target, status: s.status, createdAt: s.createdAt }));
}
