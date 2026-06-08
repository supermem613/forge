// tests/run-pair.test.js — resolve run pairs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePair, listMarks } from '../lib/run-pair.js';

async function scaffold(t, structure) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-pair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const p of structure) {
    await fs.mkdir(path.join(root, p), { recursive: true });
  }
  return root;
}

test('listMarks: empty experiment returns []', async (t) => {
  const root = await scaffold(t, []);
  assert.deepEqual(await listMarks(root), []);
});

test('listMarks: returns sorted marks', async (t) => {
  const root = await scaffold(t, [
    'variants/control', 'variants/mark-2', 'variants/mark-10', 'variants/mark-1',
  ]);
  const ms = await listMarks(root);
  assert.deepEqual(ms.map(m => m.n), [1, 2, 10]);
});

test('resolvePair: latest with no controls throws', async (t) => {
  const root = await scaffold(t, ['variants/control/runs']);
  await assert.rejects(() => resolvePair(root, 'latest'), /no control runs/);
});

test('resolvePair: latest with no marks returns control-only', async (t) => {
  const root = await scaffold(t, ['variants/control/runs/2026-01-01']);
  const r = await resolvePair(root, 'latest');
  assert.equal(r.variantRun, null);
  assert.equal(r.variantName, null);
  assert.match(r.controlRun, /2026-01-01$/);
});

test('resolvePair: latest picks highest mark', async (t) => {
  const root = await scaffold(t, [
    'variants/control/runs/2026-01-01',
    'variants/mark-1/runs/2026-02-01',
    'variants/mark-3/runs/2026-03-01',
    'variants/mark-2/runs/2026-02-15',
  ]);
  const r = await resolvePair(root, 'latest');
  assert.equal(r.variantName, 'mark-3');
  assert.match(r.variantRun, /2026-03-01$/);
});

test('resolvePair: explicit spec parses correctly', async (t) => {
  const root = await scaffold(t, []);
  const r = await resolvePair(root, '2026-04-23T18-15+mark-2:2026-04-23T18-36');
  assert.equal(r.variantName, 'mark-2');
  assert.match(r.controlRun, /2026-04-23T18-15$/);
  assert.match(r.variantRun, /2026-04-23T18-36$/);
});

test('resolvePair: malformed explicit spec throws', async () => {
  await assert.rejects(() => resolvePair('/x', 'garbage'), /must be 'latest'/);
});
