// lib/doctor.js — environment health checks for forge.
//
// Each check returns { id, status, message, detail? } where status is one of:
//   'ok'   — passes; no action needed
//   'warn' — non-fatal; surface to user but don't fail
//   'fail' — fatal; runbook will not work until fixed
//   'skip' — check inapplicable to this environment (e.g. runbook absent)
//
// runDoctor() returns { ok, checks } where ok = no 'fail' rows. The CLI
// command translates this to exit code 0 / 1 and pretty- or JSON-prints.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLocks } from './locks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks');

async function loadRunbookManifests() {
  let entries;
  try {
    entries = await fs.readdir(RUNBOOKS_DIR, { withFileTypes: true }); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return [];
    } throw e; 
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const mp = path.join(RUNBOOKS_DIR, e.name, 'manifest.json');
    try {
      const m = JSON.parse(await fs.readFile(mp, 'utf8'));
      out.push({ id: e.name, manifest: m });
    } catch {/* ignore unreadable manifests; surfaced by `forge validate` */}
  }
  return out;
}

async function pidIsRunning(pid) {
  if (!pid || typeof pid !== 'number') {
    return false;
  }
  try {
    process.kill(pid, 0); return true; 
  } catch (e) {
    return e.code === 'EPERM'; 
  }
}

async function check_resourceLocks() {
  const all = await listLocks();
  const stale = all.filter(l => !l.alive);
  if (stale.length === 0) {
    return [{ id: 'resource-locks', status: 'ok', message: `no stale locks (${all.length} total)` }];
  }
  return [{
    id: 'resource-locks',
    status: 'warn',
    message: `${stale.length} stale resource lock(s)`,
    detail: stale.map(l => `  ${l.data.kind}:${l.data.identifier} (pid ${l.data.pid})`).join('\n'),
  }];
}

// Orchestrator. Tests inject `runbooks` + `fetchImpl` to avoid touching
// the real filesystem / network.
export async function runDoctor({ runbooks, extraChecks = [], skip = [], fix = false, fetchImpl } = {}) {
  const rbs = runbooks ?? await loadRunbookManifests();
  const skipSet = new Set(skip);

  const all = [];
  if (!skipSet.has('resource-locks'))     {
    all.push(...await check_resourceLocks());
  }
  for (const check of extraChecks) {
    all.push(...await check({ runbooks: rbs, skip: skipSet, fix, pidIsRunning, fetchImpl }));
  }

  const ok = all.every(c => c.status !== 'fail');
  return { ok, checks: all };
}

// Poll runDoctor() until OK or timeout. Used by `forge doctor --wait` and
// by automation that needs a condition-based readiness gate.
//
// `gate` is a predicate (checks → bool) for early-exit. Default: every check
// is non-fail (same as runDoctor's `ok`).
export async function waitForDoctorOk({
  timeoutMs = 240_000,
  intervalMs = 5_000,
  gate,
  log = (m) => process.stderr.write(`${m}\n`),
  ...doctorOpts
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const okGate = gate || ((checks) => checks.every(c => c.status !== 'fail'));
  let last = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    last = await runDoctor(doctorOpts);
    if (okGate(last.checks)) {
      log(`forge doctor --wait: OK after ${attempt} probe(s)`);
      return { ok: true, attempts: attempt, result: last };
    }
    const failing = last.checks.filter(c => c.status === 'fail').map(c => c.id).join(', ') || '(none)';
    log(`forge doctor --wait: probe ${attempt} not ready (failing: ${failing}); sleeping ${intervalMs}ms`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  log(`forge doctor --wait: TIMEOUT after ${attempt} probe(s) (${timeoutMs}ms)`);
  return { ok: false, attempts: attempt, result: last, timedOut: true };
}

export function formatDoctorText({ ok, checks }) {
  const icon = { ok: '✓', warn: '⚠', fail: '✗', skip: '·' };
  const lines = [];
  for (const c of checks) {
    lines.push(`  ${icon[c.status] ?? '?'} [${c.status.padEnd(4)}] ${c.id}: ${c.message}`);
    if (c.detail) {
      lines.push(`         ${c.detail.replace(/\n/g, '\n         ')}`);
    }
  }
  lines.push('');
  lines.push(ok ? 'forge doctor: OK' : 'forge doctor: FAIL (see above)');
  return lines.join('\n');
}
