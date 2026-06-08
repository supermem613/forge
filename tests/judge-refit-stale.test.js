// tests/judge-refit-stale.test.js — `forge judge --refit-stale` writes to sibling judge-verdicts-refit/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJudge } from '../lib/judge-orchestrator.js';
import { normalizeEval } from '../lib/eval-loader.js';

const MANIFEST = { evals: ['evals/01.json', 'evals/02.json'] };

async function scaffold(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-refit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rb = path.join(root, 'rb');
  await fs.mkdir(path.join(rb, 'evals'), { recursive: true });
  await fs.writeFile(path.join(rb, 'manifest.json'), JSON.stringify(MANIFEST));
  // Initial criteria — these define the original criteriaHash.
  const e1 = { id: 'e1', criteria: { must: ['original-m1'], should: [], could: [] } };
  const e2 = { id: 'e2', criteria: { must: ['original-m2'], should: [], could: [] } };
  await fs.writeFile(path.join(rb, 'evals/01.json'), JSON.stringify(e1));
  await fs.writeFile(path.join(rb, 'evals/02.json'), JSON.stringify(e2));

  const ctlRun = path.join(root, 'experiments', 'demo', 'variants', 'control', 'runs', '2026-01-01');
  await fs.mkdir(path.join(ctlRun, 'turn1'), { recursive: true });
  await fs.writeFile(path.join(ctlRun, 'results.json'), JSON.stringify({
    samples: 1,
    results: [{ evalId: 'e1', sample: 1 }, { evalId: 'e2', sample: 1 }],
  }));
  for (const eid of ['e1', 'e2']) {
    await fs.writeFile(path.join(ctlRun, 'turn1', `${eid}-sample1.json`),
      JSON.stringify({ prompt: 'p', response: { toolDetails: [], capabilitiesLoaded: [] } }));
  }
  return { root, rb, ctlRun, evals: { e1, e2 } };
}

async function writeStaleVerdict(runDir, evalId, criteria) {
  const dir = path.join(runDir, 'judge-verdicts');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${evalId}-sample1.json`), JSON.stringify({
    evalId, sample: 1, model: 'gpt-5.4', promptVersion: 1,
    criteriaHash: 'deadbeef'.repeat(8), // wrong hash
    criteria_results: {
      must: criteria.must.map(c => ({ criterion: typeof c === 'string' ? c : c.text, pass: true, reasoning: 'old', evidence: [] })),
      should: [], could: [],
    },
  }));
}

test('refit-stale: skips valid verdicts; refits stale to sibling dir', async (t) => {
  const { root, rb, ctlRun, evals } = await scaffold(t);
  // Write a VALID verdict for e1 (matching current criteriaHash) and a STALE
  // verdict for e2 (different criteriaHash).
  const e1Norm = normalizeEval(evals.e1);
  const validE1 = {
    evalId: 'e1', sample: 1, model: 'gpt-5.4', promptVersion: 1,
    criteriaHash: e1Norm.criteriaHash,
    criteria_results: {
      must: [{ criterion: 'original-m1', pass: true, reasoning: 'r', evidence: [] }],
      should: [], could: [],
    },
  };
  const verdictDir = path.join(ctlRun, 'judge-verdicts');
  await fs.mkdir(verdictDir, { recursive: true });
  await fs.writeFile(path.join(verdictDir, 'e1-sample1.json'), JSON.stringify(validE1));
  await writeStaleVerdict(ctlRun, 'e2', evals.e2.criteria);

  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control', '--refit-stale'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });

  // Original judge-verdicts/ untouched (append-only evidence rule).
  const origE1 = JSON.parse(await fs.readFile(path.join(verdictDir, 'e1-sample1.json'), 'utf8'));
  assert.equal(origE1.criteriaHash, e1Norm.criteriaHash); // unchanged
  const origE2 = JSON.parse(await fs.readFile(path.join(verdictDir, 'e2-sample1.json'), 'utf8'));
  assert.equal(origE2.criteriaHash, 'deadbeef'.repeat(8)); // stale verdict NOT overwritten

  // A refit prompt was written for e2 only (e1 was valid → skipped).
  const e2Norm = normalizeEval(evals.e2);
  const refitDir = path.join(ctlRun, 'judge-verdicts-refit', e2Norm.criteriaHash);
  // The refit verdict dir exists (orchestrator mkdirs it via writePromptForRep).
  await fs.access(refitDir);

  const promptFiles = (await fs.readdir(path.join(ctlRun, 'judge-prompts'))).sort();
  assert.deepEqual(promptFiles, ['e2-sample1.md']);

  // Prompt body references the refit dir.
  const prompt = await fs.readFile(path.join(ctlRun, 'judge-prompts', 'e2-sample1.md'), 'utf8');
  assert.match(prompt, new RegExp(`judge-verdicts-refit/${e2Norm.criteriaHash}/`));
  assert.match(prompt, /REFIT/);

  // Status reflects skipped + refit.
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status-refit.json'), 'utf8'));
  assert.equal(status.refit, true);
  assert.equal(status.processed, 1);
  assert.equal(status.skippedValid, 1);
});

test('refit-stale: collect reads from refit dir keyed by expected hash', async (t) => {
  const { root, rb, ctlRun, evals } = await scaffold(t);
  await writeStaleVerdict(ctlRun, 'e1', evals.e1.criteria);
  await writeStaleVerdict(ctlRun, 'e2', evals.e2.criteria);

  // Step 1: agent mode → writes prompts under refit dir.
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control', '--refit-stale'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });

  // Step 2: simulate the agent dropping verdicts in the refit dirs.
  for (const ev of [normalizeEval(evals.e1), normalizeEval(evals.e2)]) {
    const refitDir = path.join(ctlRun, 'judge-verdicts-refit', ev.criteriaHash);
    await fs.writeFile(path.join(refitDir, `${ev.id}-sample1.json`), JSON.stringify({
      evalId: ev.id, sample: 1, model: 'gpt-5.4', promptVersion: 1,
      criteriaHash: ev.criteriaHash,
      criteria_results: {
        must: ev.criteria.must.map(c => ({ criterion: c.text, pass: true, reasoning: 'r', evidence: [] })),
        should: [], could: [],
      },
    }));
  }

  // Step 3: collect with refit-stale → reads from refit dir, all valid.
  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'collect', '--variant', 'control', '--refit-stale'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status-refit.json'), 'utf8'));
  assert.equal(status.processed, 2);
  assert.equal(status.missing.length, 0);
  assert.equal(status.invalid.length, 0);
});

test('refit-stale: refits missing and malformed verdicts too', async (t) => {
  const { root, rb, ctlRun } = await scaffold(t);
  // e1: missing entirely. e2: malformed JSON.
  const verdictDir = path.join(ctlRun, 'judge-verdicts');
  await fs.mkdir(verdictDir, { recursive: true });
  await fs.writeFile(path.join(verdictDir, 'e2-sample1.json'), 'not json{');

  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control', '--refit-stale'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const promptFiles = (await fs.readdir(path.join(ctlRun, 'judge-prompts'))).sort();
  assert.deepEqual(promptFiles, ['e1-sample1.md', 'e2-sample1.md']);
  const status = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status-refit.json'), 'utf8'));
  assert.equal(status.processed, 2);
  assert.equal(status.skippedValid, 0);
});

test('refit-stale: status file is judge-status-refit.json (does not clobber canonical)', async (t) => {
  const { root, rb, ctlRun, evals } = await scaffold(t);
  // Pre-existing canonical judge-status.json
  await fs.writeFile(path.join(ctlRun, 'judge-status.json'), JSON.stringify({ keep: 'me' }));
  await writeStaleVerdict(ctlRun, 'e1', evals.e1.criteria);
  await writeStaleVerdict(ctlRun, 'e2', evals.e2.criteria);

  await runJudge({
    argv: ['--experiment', 'demo', '--mode', 'agent', '--variant', 'control', '--refit-stale'],
    runbookDir: rb, repoRoot: root, log: () => {},
  });
  const canonical = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status.json'), 'utf8'));
  assert.equal(canonical.keep, 'me'); // canonical untouched
  const refit = JSON.parse(await fs.readFile(path.join(ctlRun, 'judge-status-refit.json'), 'utf8'));
  assert.equal(refit.refit, true);
});
