// tests/judge-orchestrator.test.js — judge orchestrator entry point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJudge } from '../lib/judge-orchestrator.js';
import { REQUIRED_JUDGE_MODEL } from '../lib/judge.js';

// Write a verdict file that classifies as 'valid' (model present, shape ok, no
// criteriaHash so the stale-criteria check is skipped). One must criterion.
async function writeValidVerdict(runDir, evalId, sample) {
  const dir = path.join(runDir, 'judge-verdicts');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${evalId}-sample${sample}.json`), JSON.stringify({
    evalId, sample, model: REQUIRED_JUDGE_MODEL, promptVersion: 1,
    criteria_results: {
      must: [{ criterion: 'm', pass: true, reasoning: 'ok', evidence: [] }],
      should: [], could: [],
    },
  }));
}

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

test('runJudge: collect mode BLOCKS (throws) on missing verdicts', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false });
  await assert.rejects(
    () => runJudge({
      argv: ['--experiment', 'demo', '--mode', 'collect', '--variant', 'control'],
      runbookDir: rb, repoRoot: root, log: () => {},
    }),
    (err) => err.code === 'JUDGE_COLLECT_BLOCKED',
  );
  // judge-status.json is written before the throw so the blocked set is inspectable.
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(status.missing.length, 2);
  assert.equal(status.processed, 0);
});

test('runJudge: collect mode BLOCKS (throws) on invalid verdicts', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false });
  // Both reps present but wrong-shape (uses "criteria" not "criteria_results").
  const vdir = path.join(ctlRun, 'judge-verdicts');
  await fs.mkdir(vdir, { recursive: true });
  for (const eid of ['e1', 'e2']) {
    await fs.writeFile(path.join(vdir, `${eid}-sample1.json`), JSON.stringify({
      evalId: eid, sample: 1, model: REQUIRED_JUDGE_MODEL, promptVersion: 1,
      criteria: [{ id: 'must.1', verdict: 'PASS' }],
    }));
  }
  await assert.rejects(
    () => runJudge({
      argv: ['--experiment', 'demo', '--mode', 'collect', '--variant', 'control'],
      runbookDir: rb, repoRoot: root, log: () => {},
    }),
    (err) => err.code === 'JUDGE_COLLECT_BLOCKED',
  );
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(status.invalid.length, 2);
});

test('runJudge: collect mode does NOT throw when all verdicts present and valid', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false });
  await writeValidVerdict(ctlRun, 'e1', 1);
  await writeValidVerdict(ctlRun, 'e2', 1);
  const logs = [];
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'collect', '--variant', 'control'],
    runbookDir: rb, repoRoot: root, log: (m) => logs.push(m),
  });
  assert.ok(logs.some(l => l.includes('all verdicts present and valid')));
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(status.processed, 2);
  assert.equal(status.missing.length, 0);
  assert.equal(status.invalid.length, 0);
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

test('runJudge: single-turn artifact surfaces turn1 response text', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false });
  // Single-turn runbooks (spark-scenario-efficiency) carry the answer in
  // turn1.response.text with no turn2. Overwrite the e1 turn1 stub with a real
  // answer and assert the judge prompt renders it instead of "(no response)".
  await fs.writeFile(path.join(ctlRun, 'turn1', 'e1-sample1.json'),
    JSON.stringify({ prompt: 'p', response: { toolDetails: [], text: 'ANSWER_XYZ_42' } }));
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const prompt = await fs.readFile(path.join(ctlRun, 'judge-prompts', 'e1-sample1.md'), 'utf8');
  assert.ok(prompt.includes('ANSWER_XYZ_42'), 'judge prompt must include the turn1 answer text');
  assert.ok(!prompt.includes('(no response)'), 'single-turn artifact must not render "(no response)"');
  assert.ok(!prompt.includes('Stage 2 — Exercise'), 'single-turn artifact must not render a Stage 2 section');
});

test('runJudge: single-turn artifact surfaces model reasoning chain of thought', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t, { withVariant: false });
  // kash >= 1.7.0 carries the model's ChainOfThought in response.reasoning
  // (ordered segments). The judge must see it so reasoning informs the verdict.
  await fs.writeFile(path.join(ctlRun, 'turn1', 'e1-sample1.json'),
    JSON.stringify({ prompt: 'p', response: {
      toolDetails: [], text: 'ANSWER_XYZ_42',
      reasoning: ['REASON_SEG_ALPHA list the library first', 'REASON_SEG_BETA then filter by extension'],
    } }));
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const prompt = await fs.readFile(path.join(ctlRun, 'judge-prompts', 'e1-sample1.md'), 'utf8');
  assert.ok(prompt.includes('REASON_SEG_ALPHA'), 'judge prompt must include reasoning segment 1');
  assert.ok(prompt.includes('REASON_SEG_BETA'), 'judge prompt must include reasoning segment 2');
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
