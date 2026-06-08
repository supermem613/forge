// lib/locks.js — per-resource file locks under ~/.forge/locks/.
//
// Resources are identified by `kind:identifier` strings. Same lock prevents
// two parallel forge processes from clobbering each other on the same:
//
//   external-service:<id>           — remote shared resource contention
//   workspace:<absPath>             — local workspace mutation
//   experiment:<exp>:<variant>      — bundle dir writes
//   profile:<name>                  — per-run profile state
//
// Lock layout:
//   ~/.forge/locks/<kind>/<sha256(identifier).slice(0,16)>.json
//
// Lock JSON: { schemaVersion, kind, identifier, pid, host, acquiredAt, label? }
//
// Stale locks (pid not running) are auto-cleared on next acquire so a crashed
// process doesn't permanently wedge a resource. Set `force: true` to override
// even a live lock (use sparingly — e.g. when CI knows it's the only writer).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const LOCK_SCHEMA_VERSION = 1;

// Marker comment retained for grep — actual locks dir resolved per-call elsewhere.
// eslint-disable-next-line no-unused-vars
const LOCKS_ROOT = process.env.FORGE_LOCKS_DIR || path.join(os.homedir(), '.forge', 'locks');

export function _setLocksRoot(p) {
  /* test hook */ this; return p; 
}

function rootDir() {
  // Re-evaluate env each call so tests can override per-test.
  return process.env.FORGE_LOCKS_DIR || path.join(os.homedir(), '.forge', 'locks');
}

function shortHash(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

export function lockPathFor(kind, identifier) {
  if (!kind || !identifier) {
    throw new Error('lockPathFor: kind and identifier required');
  }
  return path.join(rootDir(), kind, `${shortHash(identifier)}.json`);
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

async function readLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8')); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null;
    } throw e; 
  }
}

export async function acquireLock({ kind, identifier, label, force = false }) {
  const lp = lockPathFor(kind, identifier);
  await fs.mkdir(path.dirname(lp), { recursive: true });

  const existing = await readLock(lp);
  if (existing && !force) {
    const alive = await pidIsRunning(existing.pid);
    if (alive) {
      const e = new Error(
        `lock held: ${kind}:${identifier} (pid ${existing.pid}${existing.label ? ` "${existing.label}"` : ''}). ` +
        `Pass force:true to override.`
      );
      e.code = 'ELOCKED';
      e.holder = existing;
      throw e;
    }
    // stale lock — fall through and overwrite
  }

  const lock = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    kind, identifier,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    label: label ?? null,
  };
  // Write atomically: write to tmp + rename. Two racers may both rename;
  // the loser's lock content overwrites — they'd both think they hold it.
  // Acceptable for our use (single-host single-user dev box); for stricter
  // mutex we'd need flock(2) which doesn't portably exist on Windows.
  const tmp = lp + `.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(lock, null, 2) + '\n');
  await fs.rename(tmp, lp);

  return new LockHandle({ kind, identifier, path: lp });
}

class LockHandle {
  constructor({ kind, identifier, path }) {
    this.kind = kind;
    this.identifier = identifier;
    this.path = path;
    this._released = false;
  }
  async release() {
    if (this._released) {
      return { ok: true, alreadyReleased: true };
    }
    await fs.rm(this.path, { force: true });
    this._released = true;
    return { ok: true };
  }
}

// withLock: convenience wrapper that releases on both success and failure.
export async function withLock(opts, fn) {
  const lock = await acquireLock(opts);
  try {
    return await fn(lock); 
  } finally {
    await lock.release(); 
  }
}

// listLocks: introspection for `forge doctor`.
export async function listLocks() {
  const root = rootDir();
  const out = [];
  let kinds;
  try {
    kinds = await fs.readdir(root, { withFileTypes: true }); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return out;
    } throw e; 
  }
  for (const k of kinds) {
    if (!k.isDirectory()) {
      continue;
    }
    const kindDir = path.join(root, k.name);
    let files;
    try {
      files = await fs.readdir(kindDir); 
    } catch {
      continue; 
    }
    for (const f of files) {
      if (!f.endsWith('.json')) {
        continue;
      }
      const fp = path.join(kindDir, f);
      const data = await readLock(fp);
      if (!data) {
        continue;
      }
      out.push({ path: fp, data, alive: await pidIsRunning(data.pid) });
    }
  }
  return out;
}

// Sweep: remove stale locks. Returns count cleared. Used by forge doctor --fix.
export async function sweepStaleLocks() {
  const all = await listLocks();
  let cleared = 0;
  for (const { path: lp, alive } of all) {
    if (!alive) {
      await fs.rm(lp, { force: true });
      cleared++;
    }
  }
  return cleared;
}
