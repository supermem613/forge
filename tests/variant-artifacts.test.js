import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { copyTree, resolveAndFreezeTreatment, assertMarkTreatmentFrozen } from '../lib/variant-artifacts.js';

test('resolveAndFreezeTreatment freezes mark artifacts and run snapshot', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-va-'));
  try {
    const live = path.join(tmp, 'live');
    await fs.mkdir(live, { recursive: true });
    await fs.writeFile(path.join(live, 'SKILL.md'), 'name: demo\n');
    const artifactsDir = path.join(tmp, 'artifacts');
    const runDir = path.join(tmp, 'runs', 'ts1');
    await fs.mkdir(runDir, { recursive: true });
    const r = await resolveAndFreezeTreatment({
      liveDir: live,
      artifactsDir,
      runDir,
      name: 'demo',
      isControl: false,
    });
    assert.equal(r.source, 'live-frozen-to-variant');
    const skill = await fs.readFile(path.join(artifactsDir, 'demo', 'SKILL.md'), 'utf8');
    assert.match(skill, /demo/);
    const snap = await fs.readFile(path.join(runDir, 'snapshots', 'demo', 'SKILL.md'), 'utf8');
    assert.match(snap, /demo/);
    await assertMarkTreatmentFrozen({ runDir, variant: 'mark-1', snapshotName: 'demo' });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('assertMarkTreatmentFrozen fails when snapshot missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-va-miss-'));
  try {
    const runDir = path.join(tmp, 'variants', 'mark-1', 'runs', 'ts');
    await fs.mkdir(runDir, { recursive: true });
    await assert.rejects(
      () => assertMarkTreatmentFrozen({ runDir, variant: 'mark-1', snapshotName: 'demo' }),
      /INVARIANT/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
