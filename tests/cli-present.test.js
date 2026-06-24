import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPresentation } from '../lib/cli-present.js';

async function makeExp(repoRoot, expName, { withReport = true } = {}) {
  const expDir = path.join(repoRoot, 'experiments', expName);
  const ctlRunDir = path.join(expDir, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000');
  const txRunDir  = path.join(expDir, 'variants', 'mark-1', 'runs', '2026-01-01T00-00-00-001');
  await fs.mkdir(ctlRunDir, { recursive: true });
  await fs.mkdir(txRunDir, { recursive: true });
  // Pair pointer (resolvePair reads this).
  const ctlScore = {
    overallPct: 60.0,
    tiers: { must: { pct: 70 }, should: { pct: 50 }, could: { pct: 40 } },
    sampleMatrix: { 'eval-a': { 1: { overallPct: 60 }, 2: { overallPct: 60 } } },
    evals: [{ evalId: 'eval-a', overallPct: 60, tiers: { must: { pct: 70 }, should: { pct: 50 }, could: { pct: 40 } } }],
  };
  const txScore = {
    overallPct: 70.0,
    tiers: { must: { pct: 80 }, should: { pct: 65 }, could: { pct: 55 } },
    sampleMatrix: { 'eval-a': { 1: { overallPct: 70 }, 2: { overallPct: 70, autoFailed: true } } },
    evals: [{ evalId: 'eval-a', overallPct: 70, tiers: { must: { pct: 80 }, should: { pct: 65 }, could: { pct: 55 } } }],
  };
  await fs.writeFile(path.join(ctlRunDir, 'score.json'), JSON.stringify(ctlScore));
  await fs.writeFile(path.join(txRunDir, 'score.json'), JSON.stringify(txScore));
  if (withReport) {
    const report = {
      experiment: expName, variant: 'mark-1',
      controlRun: ctlRunDir, variantRun: txRunDir,
      headline: { overall: 10.0, tiers: { must: 10.0, should: 15.0, could: 15.0 } },
      perEval: [],
      criterionContrasts: [
        { tier: 'must',   evalId: 'eval-a', criterion: 'Loaded skill before create',  delta: 25.0 },
        { tier: 'should', evalId: 'eval-a', criterion: 'Cited turns in answer',       delta: -8.0 },
      ],
      outliers: [{ evalId: 'eval-a', delta: 12.0, z: 1.5 }],
      insights: {
        breakthroughs: ['Mark-1 unblocks cold-start activation.'],
        pitfalls: [],
        suggestions: ['Increase samples to 5 before promoting.'],
      },
    };
    await fs.writeFile(path.join(txRunDir, 'REPORT.json'), JSON.stringify(report));
  }
  return { expDir, ctlRunDir, txRunDir };
}

test('buildPresentation: emits headline + tiers from REPORT.json', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-present-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'demo');
  const out = await buildPresentation({ experiment: 'demo', repoRoot: tmp });
  assert.match(out, /demo · mark-1 vs control/);
  assert.match(out, /Overall: \+10\.0pp/);
  assert.match(out, /must.*\+10\.0pp/);
  assert.match(out, /should.*\+15\.0pp/);
});

test('buildPresentation: includes data-only learnings, contrasts, heatmap; no prescriptions', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-present-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'demo');
  const out = await buildPresentation({ experiment: 'demo', repoRoot: tmp });
  assert.match(out, /Mark-1 unblocks cold-start activation/);
  assert.match(out, /Loaded skill before create/);
  assert.match(out, /Cited turns in answer/);
  assert.match(out, /Per-sample heatmap/);
  assert.match(out, /eval-a/);
  // AF (auto-failed) should render in the heatmap for sample 2.
  assert.match(out, /AF/);
  // Prescriptive content lives in `forge recommend`, so present points there.
  assert.match(out, /## Recommendations/);
  assert.match(out, /forge recommend demo/);
});

test('buildPresentation: errors clearly when REPORT.json missing', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-present-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'demo', { withReport: false });
  await assert.rejects(
    buildPresentation({ experiment: 'demo', repoRoot: tmp }),
    /REPORT\.json missing.*forge report demo/s,
  );
});

test('buildPresentation: control-only baseline raises clear error', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-present-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  // Create only a control run (no variants).
  const expDir = path.join(tmp, 'experiments', 'baseline-only');
  const ctlRunDir = path.join(expDir, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000');
  await fs.mkdir(ctlRunDir, { recursive: true });
  await fs.writeFile(path.join(ctlRunDir, 'score.json'), JSON.stringify({ overallPct: 60 }));
  await assert.rejects(
    buildPresentation({ experiment: 'baseline-only', repoRoot: tmp }),
    /no variant run|control-only/,
  );
});

test('buildPresentation: stays data-only and points to recommend regardless of headline sign', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-present-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const { txRunDir } = await makeExp(tmp, 'regress');
  // Overwrite REPORT.json with a regression headline.
  const r = JSON.parse(await fs.readFile(path.join(txRunDir, 'REPORT.json'), 'utf8'));
  r.headline.overall = -8.0;
  await fs.writeFile(path.join(txRunDir, 'REPORT.json'), JSON.stringify(r));
  const out = await buildPresentation({ experiment: 'regress', repoRoot: tmp });
  assert.match(out, /Overall: -8\.0pp/);
  assert.match(out, /forge recommend regress/);
});
