// tests/symmetric-n.test.js — symmetric-n enforcement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSampleN, latestControlSamples } from '../lib/symmetric-n.js';

async function makeExp(t, { ctlSamples, ctlTs = '2026-01-01' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-symn-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const expDir = path.join(root, 'experiments', 'demo');
  if (ctlSamples != null) {
    const ctlRun = path.join(expDir, 'variants', 'control', 'runs', ctlTs);
    await fs.mkdir(ctlRun, { recursive: true });
    await fs.writeFile(path.join(ctlRun, 'results.json'),
      JSON.stringify({ samples: ctlSamples, results: [] }));
  }
  return { expDir };
}

test('resolveSampleN: control variant always returns requested', async (t) => {
  const { expDir } = await makeExp(t, { ctlSamples: 5 });
  const r = await resolveSampleN({ expDir, variant: 'control', requestedSamples: 3 });
  assert.equal(r, 3);
});

test('resolveSampleN: variant with no control run returns requested as-is', async (t) => {
  const { expDir } = await makeExp(t, {});
  const r = await resolveSampleN({ expDir, variant: 'mark-1', requestedSamples: 7 });
  assert.equal(r, 7);
});

test('resolveSampleN: variant with no requested samples auto-pins to control N', async (t) => {
  const { expDir } = await makeExp(t, { ctlSamples: 4 });
  const logs = [];
  const r = await resolveSampleN({ expDir, variant: 'mark-1', requestedSamples: null, log: (m) => logs.push(m) });
  assert.equal(r, 4);
  assert.ok(logs.some(l => l.includes('pinning')));
});

test('resolveSampleN: variant matching control N is allowed', async (t) => {
  const { expDir } = await makeExp(t, { ctlSamples: 4 });
  const r = await resolveSampleN({ expDir, variant: 'mark-2', requestedSamples: 4 });
  assert.equal(r, 4);
});

test('resolveSampleN: variant mismatching control N throws by default', async (t) => {
  const { expDir } = await makeExp(t, { ctlSamples: 4 });
  await assert.rejects(
    () => resolveSampleN({ expDir, variant: 'mark-1', requestedSamples: 7 }),
    /mismatches latest control run \(4\)/,
  );
});

test('resolveSampleN: --asymmetric overrides mismatch with warning', async (t) => {
  const { expDir } = await makeExp(t, { ctlSamples: 4 });
  const logs = [];
  const r = await resolveSampleN({ expDir, variant: 'mark-1', requestedSamples: 7, allowAsymmetric: true, log: (m) => logs.push(m) });
  assert.equal(r, 7);
  assert.ok(logs.some(l => l.includes('WARNING')));
});

test('latestControlSamples: returns null when no control run', async (t) => {
  const { expDir } = await makeExp(t, {});
  assert.equal(await latestControlSamples({ expDir }), null);
});

test('latestControlSamples: picks latest by timestamp', async (t) => {
  const { expDir } = await makeExp(t, { ctlSamples: 3, ctlTs: '2026-01-01' });
  // Add a newer control run with different N.
  const newer = path.join(expDir, 'variants', 'control', 'runs', '2026-02-01');
  await fs.mkdir(newer, { recursive: true });
  await fs.writeFile(path.join(newer, 'results.json'), JSON.stringify({ samples: 8, results: [] }));
  assert.equal(await latestControlSamples({ expDir }), 8);
});
