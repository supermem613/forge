// tests/locks.test.js — per-resource lock acquire/release/sweep.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  withLock,
  listLocks,
  sweepStaleLocks,
  lockPathFor,
  LOCK_SCHEMA_VERSION,
} from '../lib/locks.js';

let LOCKS_DIR;

before(async () => {
  LOCKS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-locks-test-'));
  process.env.FORGE_LOCKS_DIR = LOCKS_DIR;
});

after(async () => {
  await fs.rm(LOCKS_DIR, { recursive: true, force: true });
  delete process.env.FORGE_LOCKS_DIR;
});

test('acquireLock: writes lock with pid + schemaVersion', async () => {
  const lh = await acquireLock({ kind: 'external-service', identifier: 'https://example.com/resource/x' });
  const raw = JSON.parse(await fs.readFile(lh.path, 'utf8'));
  assert.equal(raw.schemaVersion, LOCK_SCHEMA_VERSION);
  assert.equal(raw.pid, process.pid);
  assert.equal(raw.kind, 'external-service');
  assert.equal(raw.identifier, 'https://example.com/resource/x');
  await lh.release();
});

test('acquireLock: live lock with same identifier blocks (ELOCKED)', async () => {
  const a = await acquireLock({ kind: 'experiment', identifier: 'exp-1:control' });
  await assert.rejects(
    () => acquireLock({ kind: 'experiment', identifier: 'exp-1:control' }),
    err => err.code === 'ELOCKED' && err.holder.pid === process.pid,
  );
  await a.release();
});

test('acquireLock: different identifiers do not interfere', async () => {
  const a = await acquireLock({ kind: 'experiment', identifier: 'exp-A:control' });
  const b = await acquireLock({ kind: 'experiment', identifier: 'exp-B:mark-1' });
  await a.release();
  await b.release();
});

test('acquireLock: force overrides live lock', async () => {
  const a = await acquireLock({ kind: 'profile', identifier: 'forge' });
  const b = await acquireLock({ kind: 'profile', identifier: 'forge', force: true });
  // After force, b's lock content wins
  const raw = JSON.parse(await fs.readFile(b.path, 'utf8'));
  assert.equal(raw.pid, process.pid);
  await b.release();
  // a's release() should still be safe (rm with force:true)
  await a.release();
});

test('acquireLock: stale lock (dead pid) is auto-overwritten', async () => {
  const lp = lockPathFor('workspace', '/fake/path/stale');
  await fs.mkdir(path.dirname(lp), { recursive: true });
  await fs.writeFile(lp, JSON.stringify({
    schemaVersion: LOCK_SCHEMA_VERSION,
    kind: 'workspace', identifier: '/fake/path/stale',
    pid: 999999, host: 'gone', acquiredAt: new Date(0).toISOString(),
  }));
  const lh = await acquireLock({ kind: 'workspace', identifier: '/fake/path/stale' });
  const raw = JSON.parse(await fs.readFile(lh.path, 'utf8'));
  assert.equal(raw.pid, process.pid, 'live process replaces stale lock without force');
  await lh.release();
});

test('release: removes lock file', async () => {
  const lh = await acquireLock({ kind: 'site', identifier: 'release-me' });
  await fs.access(lh.path);
  await lh.release();
  await assert.rejects(() => fs.access(lh.path));
});

test('release: idempotent', async () => {
  const lh = await acquireLock({ kind: 'site', identifier: 'release-twice' });
  const r1 = await lh.release();
  const r2 = await lh.release();
  assert.equal(r1.ok, true);
  assert.equal(r2.alreadyReleased, true);
});

test('withLock: releases on success', async () => {
  const result = await withLock({ kind: 'site', identifier: 'with-success' }, async (lock) => {
    await fs.access(lock.path);
    return 42;
  });
  assert.equal(result, 42);
  // Lock should be gone after the closure returns
  const after = await listLocks();
  assert.equal(after.find(l => l.data.identifier === 'with-success'), undefined);
});

test('withLock: releases on throw', async () => {
  await assert.rejects(
    () => withLock({ kind: 'site', identifier: 'with-throw' }, async () => {
      throw new Error('boom'); 
    }),
    /boom/,
  );
  const after = await listLocks();
  assert.equal(after.find(l => l.data.identifier === 'with-throw'), undefined);
});

test('listLocks: enumerates all lock files', async () => {
  const a = await acquireLock({ kind: 'site', identifier: 'list-a' });
  const b = await acquireLock({ kind: 'experiment', identifier: 'list-b' });
  const all = await listLocks();
  const ids = all.map(l => l.data.identifier);
  assert.ok(ids.includes('list-a'));
  assert.ok(ids.includes('list-b'));
  for (const l of all) {
    assert.equal(typeof l.alive, 'boolean');
  }
  await a.release();
  await b.release();
});

test('sweepStaleLocks: removes only stale locks', async () => {
  // One stale, one live
  const stalePath = lockPathFor('site', 'sweep-stale');
  await fs.mkdir(path.dirname(stalePath), { recursive: true });
  await fs.writeFile(stalePath, JSON.stringify({
    schemaVersion: LOCK_SCHEMA_VERSION, kind: 'site', identifier: 'sweep-stale',
    pid: 999998, host: 'x', acquiredAt: new Date(0).toISOString(),
  }));
  const live = await acquireLock({ kind: 'site', identifier: 'sweep-live' });

  const cleared = await sweepStaleLocks();
  assert.ok(cleared >= 1);
  await assert.rejects(() => fs.access(stalePath));
  // live still present
  await fs.access(live.path);
  await live.release();
});

test('lockPathFor: same identifier maps to same file', () => {
  const a = lockPathFor('site', 'https://example.com');
  const b = lockPathFor('site', 'https://example.com');
  assert.equal(a, b);
});

test('lockPathFor: different identifiers map to different files', () => {
  const a = lockPathFor('site', 'https://a.com');
  const b = lockPathFor('site', 'https://b.com');
  assert.notEqual(a, b);
});

test('lockPathFor: validates inputs', () => {
  assert.throws(() => lockPathFor(null, 'x'), /kind and identifier/);
  assert.throws(() => lockPathFor('site', null), /kind and identifier/);
});
