// tests/judge-orchestrator.test.js — judge orchestrator entry point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJudge } from '../lib/judge-orchestrator.js';

const MANIFEST = {
  evals: ['evals/01.json', 'evals/02.json'],
};

async function scaffold(t, { withVariant = true, results = true, signals = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-judgeo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rb = path.join(root, 'rb');
  await fs.mkdir(path.join(rb, 'evals'), { recursive: true });
  await fs.writeFile(path.join(rb, 'manifest.json'), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(rb, 'evals/01.json'), JSON.stringify({
    id: 'e1',
    criteria: { must: ['m1'], should: [], could: [] },
  }));
  await fs.writeFile(path.join(rb, 'evals/02.json'), JSON.stringify({
    id: 'e2',
    criteria: { must: ['m2'], should: [], could: [] },
  }));

  const expDir = path.join(root, 'experiments', 'demo');
  const ctlRun = path.join(expDir, 'variants', 'control', 'runs', '2026-01-01');
  await fs.mkdir(ctlRun, { recursive: true });
  if (results) {
    await fs.writeFile(path.join(ctlRun, 'results.json'), JSON.stringify({
      samples: 1,
      results: [
        { evalId: 'e1', sample: 1 },
        { evalId: 'e2', sample: 1 },
      ],
    }));
  }
  if (signals.length) {
    await fs.writeFile(path.join(ctlRun, 'signals.json'), JSON.stringify({ signals }));
  }
  // Stub turn files so artifact builder doesn't choke.
  for (const eid of ['e1', 'e2']) {
    await fs.mkdir(path.join(ctlRun, 'turn1'), { recursive: true });
    await fs.writeFile(path.join(ctlRun, 'turn1', `${eid}-sample1.json`),
      JSON.stringify({ prompt: 'p', response: { toolDetails: [], capabilitiesLoaded: [] } }));
  }

  let txRun = null;
  if (withVariant) {
    txRun = path.join(expDir, 'variants', 'mark-1', 'runs', '2026-01-02');
    await fs.mkdir(txRun, { recursive: true });
    await fs.writeFile(path.join(txRun, 'results.json'), JSON.stringify({
      samples: 1,
      results: [{ evalId: 'e1', sample: 1 }],
    }));
    await fs.mkdir(path.join(txRun, 'turn1'), { recursive: true });
    await fs.writeFile(path.join(txRun, 'turn1', 'e1-sample1.json'),
      JSON.stringify({ prompt: 'p', response: { toolDetails: [], capabilitiesLoaded: [] } }));
  }
  return { root, rb, ctlRun, txRun };
}

test('runJudge: agent mode writes prompts for control + variant', async (t) => {
  const { root, rb, ctlRun, txRun } = await scaffold(t);
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const ctlPrompts = await fs.readdir(path.join(ctlRun, 'judge-prompts'));
  assert.equal(ctlPrompts.length, 2);
  const txPrompts = await fs.readdir(path.join(txRun, 'judge-prompts'));
  assert.equal(txPrompts.length, 1);
  const ctlStatus = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(ctlStatus.processed, 2);
  assert.equal(ctlStatus.autoFailed, 0);
});

test('runJudge: agent mode auto-fails blocked samples', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, {
    withVariant: false,
    signals: [{ eval: 'e1', sample: 1, level: 'block', kind: 'capability-not-loaded', message: 'missing' }],
  });
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const verdict = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-verdicts', 'e1-sample1.json'), 'utf8'));
  assert.equal(verdict.criteria_results.must[0].pass, false);
  assert.equal(verdict.autoFailed, true);
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(status.autoFailed, 1);
  assert.equal(status.processed, 1); // e2 still processed
});

test('runJudge: collect mode reports missing verdicts', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false });
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'collect', '--variant', 'control'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(status.missing.length, 2);
  assert.equal(status.processed, 0);
});

test('runJudge: rejects bad mode', async (t) => {
  const { root, rb } = await scaffold(t);
  await assert.rejects(
    () => runJudge({ argv: ['--experiment', 'demo', '--mode', 'bogus'], runbookDir: rb, repoRoot: root }),
    /--mode must be agent\|collect/,
  );
});

test('runJudge: rejects missing --experiment', async () => {
  await assert.rejects(
    () => runJudge({ argv: [], runbookDir: '/x', repoRoot: '/y' }),
    /--experiment <name> required/,
  );
});

test('runJudge: skips run with no results.json', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false, results: false });
  const logs = [];
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control'],
    runbookDir: rb, repoRoot: root, log: (m) => logs.push(m),
  });
  assert.ok(logs.some(l => l.includes('no results.json')));
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(status.processed, 0);
});
