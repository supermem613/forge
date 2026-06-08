import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDispatchPrompt, validateVerdictDir, summarizeValidation,
} from '../lib/judge-dispatch.js';

test('buildDispatchPrompt names the required model', () => {
  const p = buildDispatchPrompt({
    controlRun: '/runs/c', variantRun: '/runs/v', variantName: 'mark-2',
  });
  assert.match(p, /gpt-5\.4/);
  assert.match(p, /promptVersion/);
});

test('buildDispatchPrompt embeds the criteria_results schema, not criteria', () => {
  const p = buildDispatchPrompt({
    controlRun: '/runs/c', variantRun: '/runs/v', variantName: 'mark-2',
  });
  assert.match(p, /"criteria_results"/);
  assert.match(p, /"must"/);
  assert.match(p, /"should"/);
  assert.match(p, /"could"/);
  // Common-mistakes section explicitly calls out the wrong shape
  assert.match(p, /Top-level key `"criteria"`/);
  assert.match(p, /\{id, verdict, rationale\}/);
});

test('buildDispatchPrompt lists both run paths', () => {
  const p = buildDispatchPrompt({
    controlRun: '/runs/c', variantRun: '/runs/v', variantName: 'mark-2',
  }).replace(/\\/g, '/');
  assert.ok(p.includes('/runs/c'));
  assert.ok(p.includes('/runs/v'));
  assert.ok(p.includes('judge-prompts'));
  assert.ok(p.includes('judge-verdicts'));
});

test('buildDispatchPrompt handles control-only baseline (no variant)', () => {
  const p = buildDispatchPrompt({
    controlRun: '/runs/c', variantRun: null, variantName: null,
  }).replace(/\\/g, '/');
  assert.ok(p.includes('/runs/c'));
  assert.ok(!p.includes('null'));
});

test('buildDispatchPrompt treats discovery calls as informational', () => {
  const p = buildDispatchPrompt({ controlRun: '/c', variantRun: '/v', variantName: 'm' });
  assert.match(p, /read-only discovery calls/);
});

test('validateVerdictDir: missing dir returns empty file list', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-validate-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const r = await validateVerdictDir({ runDir: tmp, evals: [], refitHash: null });
  assert.deepEqual(r.files, []);
});

test('validateVerdictDir: classifies valid + malformed files', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-validate-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const verdictDir = path.join(tmp, 'judge-verdicts');
  await fs.mkdir(verdictDir, { recursive: true });
  // Eval rubric that the verdict files must match.
  const evals = [{
    id: 'demo',
    criteria: {
      must:   [{ description: 'must-1' }],
      should: [{ description: 'should-1' }],
      could:   [{ description: 'could-1' }],
    },
  }];
  // Valid verdict
  await fs.writeFile(path.join(verdictDir, 'demo-sample1.json'), JSON.stringify({
    evalId: 'demo', sample: 1,
    model: 'gpt-5.4', promptVersion: 1, criteriaHash: 'h',
    criteria_results: {
      must:   [{ criterion: 'must-1',   pass: true,  reasoning: 'ok', evidence: [] }],
      should: [{ criterion: 'should-1', pass: false, reasoning: 'no', evidence: [] }],
      could:   [{ criterion: 'could-1',   pass: true,  reasoning: 'ok', evidence: [] }],
    },
  }));
  // Wrong-shape verdict (uses "criteria" not "criteria_results")
  await fs.writeFile(path.join(verdictDir, 'demo-sample2.json'), JSON.stringify({
    evalId: 'demo', sample: 2, model: 'gpt-5.4', promptVersion: 1, criteriaHash: 'h',
    criteria: [{ id: 'must.1', verdict: 'PASS', rationale: 'ok' }],
  }));
  // Unparseable file
  await fs.writeFile(path.join(verdictDir, 'demo-sample3.json'), '{ not json');

  const r = await validateVerdictDir({ runDir: tmp, evals, refitHash: null });
  assert.equal(r.files.length, 3);
  const byFile = Object.fromEntries(r.files.map(f => [f.file, f.classification]));
  assert.equal(byFile['demo-sample1.json'], 'valid');
  assert.equal(byFile['demo-sample2.json'], 'malformed');
  assert.equal(byFile['demo-sample3.json'], 'malformed');
});

test('summarizeValidation: counts ok vs bad', () => {
  const s = summarizeValidation([
    { classification: 'valid' },
    { classification: 'valid' },
    { classification: 'legacy' },
    { classification: 'malformed' },
    { classification: 'wrong-model' },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.ok, 3);
  assert.equal(s.bad, 2);
  assert.equal(s.counts.valid, 2);
  assert.equal(s.counts.malformed, 1);
});
