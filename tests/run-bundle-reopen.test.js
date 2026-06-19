// tests/run-bundle-reopen.test.js — reopenBundle() reuse mode for `forge resample`.
//
// Contract:
//   * reopenBundle resolves the NEWEST <ts> dir under runsDir (via latest()).
//   * It carries the existing manifest forward: startedAt is preserved, the dir
//     and timestamp are unchanged. No new timestamped dir is minted.
//   * The returned writer overwrites a targeted turn file in place and de-dupes
//     its transcript entry, while leaving every other turn file untouched.
//   * Throws when runsDir has no existing bundle to reuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBundle, reopenBundle } from '../lib/run-bundle.js';

async function freshRunsDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'forge-reopen-'));
}

test('reopenBundle reuses the latest dir and preserves startedAt', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const older = await openBundle({ experiment: 'e', variant: 'mark-1', runsDir, ts: '2026-04-30T00-00-00' });
  const newer = await openBundle({ experiment: 'e', variant: 'mark-1', runsDir, ts: '2026-04-30T00-00-01' });
  const newerStartedAt = JSON.parse(await fs.readFile(path.join(newer.dir, 'manifest.json'), 'utf8')).startedAt;

  const reopened = await reopenBundle({ runsDir });
  assert.equal(reopened.dir, newer.dir, 'reopen resolves the newest <ts> dir');
  assert.notEqual(reopened.dir, older.dir);
  assert.equal(reopened.ts, '2026-04-30T00-00-01');

  await reopened.finalize({ summary: { repaired: true } });
  const m = JSON.parse(await fs.readFile(path.join(newer.dir, 'manifest.json'), 'utf8'));
  assert.equal(m.startedAt, newerStartedAt, 'startedAt is preserved across reuse');
  assert.equal(m.summary.repaired, true);
  assert.ok(m.finalizedAt, 'finalizedAt is set on reuse');
});

test('reopenBundle overwrites the targeted turn in place and leaves siblings intact', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const b = await openBundle({ experiment: 'e', variant: 'mark-1', runsDir, ts: '2026-05-01T00-00-00' });
  await b.writeTurn('eval-a', 1, 1, { prompt: 'p', ms: 10, response: { text: 'keep' } });
  await b.writeTurn('eval-a', 2, 1, { prompt: 'p', ms: 20, response: { text: 'flaked' } });

  const reopened = await reopenBundle({ runsDir });
  await reopened.writeTurn('eval-a', 2, 1, { prompt: 'p', ms: 99, response: { text: 'repaired' } });

  const turnDir = path.join(b.dir, 'turn1');
  const s1 = JSON.parse(await fs.readFile(path.join(turnDir, 'eval-a-sample1.json'), 'utf8'));
  const s2 = JSON.parse(await fs.readFile(path.join(turnDir, 'eval-a-sample2.json'), 'utf8'));
  assert.equal(s1.response.text, 'keep', 'untouched sample survives');
  assert.equal(s2.response.text, 'repaired', 'targeted sample is overwritten');
  assert.equal(s2.ms, 99);

  // Transcript carries exactly one entry per (eval, sample, turn) — the repaired
  // one replaces the prior entry rather than duplicating it.
  const transcript = JSON.parse(await fs.readFile(path.join(b.dir, 'transcript.json'), 'utf8'));
  const s2Entries = transcript.entries.filter(e => e.evalId === 'eval-a' && e.sample === 2);
  assert.equal(s2Entries.length, 1, 'no duplicate transcript entry for the resampled sample');
  assert.equal(transcript.entries.filter(e => e.evalId === 'eval-a' && e.sample === 1).length, 1);
});

test('reopenBundle throws when no bundle exists to reuse', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));
  await assert.rejects(() => reopenBundle({ runsDir }), /no existing run bundle/);
});

test('reopenBundle requires runsDir', async () => {
  await assert.rejects(() => reopenBundle({}), /runsDir is required/);
});
