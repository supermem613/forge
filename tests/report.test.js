// tests/report.test.js — lib/report.js generates REPORT.md/json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReport } from '../lib/report.js';

const NOW = '2026-04-23T12-00-00';

function mkScore({ overallPct, tiers, evals = [], reliability = null, signals = null, samples = 3, eligibleSamples = 0, totalSamplesAcrossEvals = 0 }) {
  return {
    samples,
    eligibleSamples,
    totalSamplesAcrossEvals,
    overallPct,
    tiers,
    evals,
    reliability,
    signals,
  };
}

function mkEval(evalId, overallPct, tiers, gateDiagBySample = {}) {
  return {
    evalId,
    overallPct,
    tiers,
    autoFailedSamples: 0,
    missingSamples: 0,
    sampleMatrix: [],
    gateDiagBySample,
    perCriterion: { must: [], should: [], could: [] },
  };
}

async function scaffoldExperiment(t, { ctlScore, txScore, mark = 'mark-1' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const expDir = path.join(root, 'experiments', 'demo');
  const ctlRun = path.join(expDir, 'variants', 'control', 'runs', NOW);
  const txRun = path.join(expDir, 'variants', mark, 'runs', NOW);
  await fs.mkdir(ctlRun, { recursive: true });
  await fs.mkdir(txRun, { recursive: true });
  await fs.writeFile(path.join(ctlRun, 'score.json'), JSON.stringify(ctlScore));
  await fs.writeFile(path.join(txRun, 'score.json'), JSON.stringify(txScore));
  return { root, ctlRun, txRun };
}

test('runReport: emits REPORT.md and REPORT.json into variant run', async (t) => {
  const ctl = mkScore({
    overallPct: 30,
    tiers: { must: { pct: 40 }, should: { pct: 30 }, could: { pct: 20 } },
    evals: [mkEval('e1', 30, { must: { pct: 40 }, should: { pct: 30 }, could: { pct: 20 } })],
    samples: 3,
    eligibleSamples: 3,
    totalSamplesAcrossEvals: 3,
  });
  const tx = mkScore({
    overallPct: 50,
    tiers: { must: { pct: 60 }, should: { pct: 50 }, could: { pct: 40 } },
    evals: [mkEval('e1', 50, { must: { pct: 60 }, should: { pct: 50 }, could: { pct: 40 } })],
    samples: 3,
    eligibleSamples: 3,
    totalSamplesAcrossEvals: 3,
  });
  const { root, txRun } = await scaffoldExperiment(t, { ctlScore: ctl, txScore: tx });
  const logs = [];
  const r = await runReport({
    argv: ['--experiment', 'demo'],
    repoRoot: root,
    log: (m) => logs.push(m),
  });
  assert.equal(r.variantName, 'mark-1');
  assert.equal(r.overallDelta, 20);
  const md = await fs.readFile(path.join(txRun, 'REPORT.md'), 'utf8');
  assert.match(md, /Overall \+20\.0pp/);
  const json = JSON.parse(await fs.readFile(path.join(txRun, 'REPORT.json'), 'utf8'));
  assert.equal(json.headline.overall, 20);
  assert.ok(logs.some(l => l.includes('Overall +20.0pp')));
});

test('runReport: reliability without skillBody does not crash', async (t) => {
  // Single-turn runbooks (e.g. spark-scenario-efficiency) emit a reliability
  // object but no skillBody sub-object, since they author no artifact. The byte
  // signal must skip gracefully rather than dereference a missing skillBody.
  const reliability = {
    totalSamples: 5,
    ok: 5, errored: 0,
    gateValid: 5, gateValidPct: 100,
    codeModeEngaged: 5, codeModeEngagedPct: 100,
    tokensMatched: 5, tokensMatchedPct: 100,
    meanLatencyMs: 94004,
  };
  const tiers = { must: { pct: 90 }, should: { pct: 90 }, could: { pct: 80 } };
  const ctl = mkScore({
    overallPct: 89, tiers,
    evals: [mkEval('e1', 89, tiers)],
    reliability, samples: 5, eligibleSamples: 5, totalSamplesAcrossEvals: 5,
  });
  const tx = mkScore({
    overallPct: 88, tiers,
    evals: [mkEval('e1', 88, tiers)],
    reliability, samples: 5, eligibleSamples: 5, totalSamplesAcrossEvals: 5,
  });
  const { root, txRun } = await scaffoldExperiment(t, { ctlScore: ctl, txScore: tx });
  await runReport({ argv: ['--experiment', 'demo'], repoRoot: root, log: () => {} });
  const md = await fs.readFile(path.join(txRun, 'REPORT.md'), 'utf8');
  assert.ok(md.length > 0);
});

test('runReport: throws without --experiment', async () => {
  await assert.rejects(
    () => runReport({ argv: [], repoRoot: '/x', log: () => {} }),
    /--experiment <name> required/,
  );
});

test('runReport: zero-eligible variant emits trust gate banner', async (t) => {
  const ctl = mkScore({
    overallPct: 30,
    tiers: { must: { pct: 40 }, should: { pct: 30 }, could: { pct: 20 } },
    evals: [mkEval('e1', 30, { must: { pct: 40 }, should: { pct: 30 }, could: { pct: 20 } })],
    eligibleSamples: 0,
    totalSamplesAcrossEvals: 3,
  });
  const tx = mkScore({
    overallPct: 0,
    tiers: { must: { pct: 0 }, should: { pct: 0 }, could: { pct: 0 } },
    evals: [mkEval('e1', 0, { must: { pct: 0 }, should: { pct: 0 }, could: { pct: 0 } })],
    eligibleSamples: 0,
    totalSamplesAcrossEvals: 3,
  });
  const { root, txRun } = await scaffoldExperiment(t, { ctlScore: ctl, txScore: tx });
  await runReport({ argv: ['--experiment', 'demo'], repoRoot: root, log: () => {} });
  const md = await fs.readFile(path.join(txRun, 'REPORT.md'), 'utf8');
  assert.match(md, /Variant never cleared the gate/);
});

test('runReport: emits generic reliability rows', async (t) => {
  const reliability = {
    totalSamples: 3,
    stage1: { ok: 3, okPct: 100, meanMs: 100 },
    stage2: { attempted: 3, attemptedPct: 100, ok: 3, okPct: 100, meanMs: 100 },
    variantCapabilityLoaded: 3, variantCapabilityLoadedPct: 100,
    loadSkillInvoked: 3, loadSkillInvokedPct: 100,
    createSkillInvoked: 3, createSkillInvokedPct: 100,
    gateValid: 3, gateValidPct: 100,
    skillMaterialized: 3, skillMaterializedPct: 100,
    loadButNoCreate: 0, createSkillOOB: 0,
    skillBody: { meanBytes: 1024, n: 3 },
  };
  const tiers = { must: { pct: 100 }, should: { pct: 100 }, could: { pct: 100 } };
  const ctl = mkScore({
    overallPct: 100, tiers,
    evals: [mkEval('e1', 100, tiers)],
    reliability, eligibleSamples: 3, totalSamplesAcrossEvals: 3,
  });
  const tx = mkScore({
    overallPct: 100, tiers,
    evals: [mkEval('e1', 100, tiers)],
    reliability, eligibleSamples: 3, totalSamplesAcrossEvals: 3,
  });
  const { root, txRun } = await scaffoldExperiment(t, { ctlScore: ctl, txScore: tx });
  await runReport({ argv: ['--experiment', 'demo'], repoRoot: root, log: () => {} });
  const md = await fs.readFile(path.join(txRun, 'REPORT.md'), 'utf8');
  assert.match(md, /Variant activated/);
  assert.doesNotMatch(md, /domain-specific bypass/);
});
