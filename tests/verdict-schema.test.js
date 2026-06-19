// tests/verdict-schema.test.js — verdict schema enrichment.
//
// classifyVerdict() labels:
//   missing | malformed | wrong-model | stale-criteria | legacy | valid

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCriteriaPrompt,
  classifyVerdict,
  failAllCriteriaVerdict,
  readVerdictForRep,
  writePromptForRep,
  expectedVerdictPath,
  JUDGE_PROMPT_VERSION,
  REQUIRED_JUDGE_MODEL,
  AUTO_FAIL_MODEL,
} from '../lib/judge.js';

const CRITERIA = {
  must: [{ id: 'must-a', text: 'm1', hash: 'aaaa' }, { id: 'must-b', text: 'm2', hash: 'bbbb' }],
  should: [{ id: 'should-a', text: 's1', hash: 'cccc' }],
  could: [],
};

const HASH = 'deadbeef'.repeat(8); // 64-hex placeholder

function rich(model, criteriaHash) {
  return {
    evalId: 'e', sample: 1,
    model, promptVersion: JUDGE_PROMPT_VERSION, criteriaHash,
    criteria_results: {
      must:   [{ criterion: 'm1', pass: true, reasoning: 'r' },
        { criterion: 'm2', pass: false, reasoning: 'r' }],
      should: [{ criterion: 's1', pass: true, reasoning: 'r' }],
      could:   [],
    },
  };
}

test('classifyVerdict: valid', () => {
  const r = classifyVerdict({ json: rich(REQUIRED_JUDGE_MODEL, HASH), criteria: CRITERIA, expectedCriteriaHash: HASH });
  assert.equal(r.classification, 'valid');
});

test('classifyVerdict: missing on parse error', () => {
  const r = classifyVerdict({ parseError: 'Unexpected token', criteria: CRITERIA });
  assert.equal(r.classification, 'malformed');
});

test('classifyVerdict: malformed on missing criteria_results', () => {
  const r = classifyVerdict({ json: { evalId: 'x' }, criteria: CRITERIA });
  assert.equal(r.classification, 'malformed');
});

test('classifyVerdict: malformed on wrong tier length', () => {
  const v = rich(REQUIRED_JUDGE_MODEL, HASH);
  v.criteria_results.must.pop();
  const r = classifyVerdict({ json: v, criteria: CRITERIA });
  assert.equal(r.classification, 'malformed');
  assert.match(r.errors.join('|'), /must.*length/);
});

test('classifyVerdict: wrong-model rejected (gpt-5.2)', () => {
  const r = classifyVerdict({ json: rich('gpt-5.2', HASH), criteria: CRITERIA });
  assert.equal(r.classification, 'wrong-model');
});

test('classifyVerdict: forge-auto-fail accepted as valid', () => {
  const r = classifyVerdict({ json: rich(AUTO_FAIL_MODEL, HASH), criteria: CRITERIA, expectedCriteriaHash: HASH });
  assert.equal(r.classification, 'valid');
});

test('classifyVerdict: stale-criteria when hash mismatches', () => {
  const r = classifyVerdict({
    json: rich(REQUIRED_JUDGE_MODEL, '0'.repeat(64)),
    criteria: CRITERIA,
    expectedCriteriaHash: HASH,
  });
  assert.equal(r.classification, 'stale-criteria');
});

test('classifyVerdict: wrong-model takes precedence over stale-criteria', () => {
  const r = classifyVerdict({
    json: rich('gpt-5.2', '0'.repeat(64)),
    criteria: CRITERIA,
    expectedCriteriaHash: HASH,
  });
  assert.equal(r.classification, 'wrong-model');
});

test('classifyVerdict: legacy when none of {model,promptVersion,criteriaHash}', () => {
  const v = rich(REQUIRED_JUDGE_MODEL, HASH);
  delete v.model;
  delete v.promptVersion;
  delete v.criteriaHash;
  const r = classifyVerdict({ json: v, criteria: CRITERIA });
  assert.equal(r.classification, 'legacy');
});

test('classifyVerdict: skip stale check when expectedCriteriaHash omitted', () => {
  const r = classifyVerdict({ json: rich(REQUIRED_JUDGE_MODEL, '0'.repeat(64)), criteria: CRITERIA });
  // No expected hash → cannot detect drift; treat as valid
  assert.equal(r.classification, 'valid');
});

test('failAllCriteriaVerdict: stamps AUTO_FAIL_MODEL + criteriaHash', () => {
  const v = failAllCriteriaVerdict({
    evalId: 'e', sample: 2, criteria: CRITERIA, criteriaHash: HASH, reason: 'capability-not-loaded',
  });
  assert.equal(v.model, AUTO_FAIL_MODEL);
  assert.equal(v.promptVersion, JUDGE_PROMPT_VERSION);
  assert.equal(v.criteriaHash, HASH);
  assert.equal(v.autoFailReason, 'capability-not-loaded');
  assert.equal(v.criteria_results.must.length, 2);
  assert.equal(v.criteria_results.must[0].pass, false);

  // And classifyVerdict accepts it as valid.
  const r = classifyVerdict({ json: v, criteria: CRITERIA, expectedCriteriaHash: HASH });
  assert.equal(r.classification, 'valid');
});

test('buildCriteriaPrompt: includes model + promptVersion + criteriaHash placeholders', () => {
  const prompt = buildCriteriaPrompt({
    evalId: 'e', sample: 1, criteria: CRITERIA, criteriaHash: HASH, artifact: { x: 1 },
  });
  assert.match(prompt, new RegExp(`"model": "${REQUIRED_JUDGE_MODEL}"`));
  assert.match(prompt, /"promptVersion": 1/);
  assert.match(prompt, /"criteriaHash": "deadbeef/);
  // Criterion text rendered (not [object Object])
  assert.match(prompt, /1\. m1/);
  assert.match(prompt, /2\. m2/);
});

test('buildCriteriaPrompt: omits criteriaHash gracefully when not provided', () => {
  const prompt = buildCriteriaPrompt({
    evalId: 'e', sample: 1, criteria: CRITERIA, artifact: 'art',
  });
  assert.doesNotMatch(prompt, /"criteriaHash":/);
  assert.match(prompt, new RegExp(`"model": "${REQUIRED_JUDGE_MODEL}"`));
});

test('readVerdictForRep: missing file → classification:missing', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-verdict-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const r = await readVerdictForRep({ runDir: tmp, evalId: 'e', sample: 1, criteria: CRITERIA });
  assert.equal(r.found, false);
  assert.equal(r.classification, 'missing');
  assert.equal(r.ok, false);
});

test('readVerdictForRep: round-trip with criteriaHash → valid', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-verdict-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  // Need the prompt dir to exist before writing the verdict
  await writePromptForRep({ runDir: tmp, evalId: 'e', sample: 1, prompt: 'p' });
  const vp = expectedVerdictPath({ runDir: tmp, evalId: 'e', sample: 1 });
  await fs.writeFile(vp, JSON.stringify(rich(REQUIRED_JUDGE_MODEL, HASH)));

  const r = await readVerdictForRep({ runDir: tmp, evalId: 'e', sample: 1, criteria: CRITERIA, expectedCriteriaHash: HASH });
  assert.equal(r.found, true);
  assert.equal(r.classification, 'valid');
  assert.equal(r.ok, true);
});

test('readVerdictForRep: legacy verdict still ok=true (back-compat)', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-verdict-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  await writePromptForRep({ runDir: tmp, evalId: 'e', sample: 1, prompt: 'p' });
  const vp = expectedVerdictPath({ runDir: tmp, evalId: 'e', sample: 1 });
  const legacy = rich(REQUIRED_JUDGE_MODEL, HASH);
  delete legacy.model;
  delete legacy.promptVersion;
  delete legacy.criteriaHash;
  await fs.writeFile(vp, JSON.stringify(legacy));

  const r = await readVerdictForRep({ runDir: tmp, evalId: 'e', sample: 1, criteria: CRITERIA });
  assert.equal(r.classification, 'legacy');
  assert.equal(r.ok, true, 'legacy verdicts remain readable so old runs still work');
});

test('readVerdictForRep: malformed JSON → classification:malformed, ok:false', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-verdict-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await writePromptForRep({ runDir: tmp, evalId: 'e', sample: 1, prompt: 'p' });
  const vp = expectedVerdictPath({ runDir: tmp, evalId: 'e', sample: 1 });
  await fs.writeFile(vp, '{ not valid json');

  const r = await readVerdictForRep({ runDir: tmp, evalId: 'e', sample: 1, criteria: CRITERIA });
  assert.equal(r.classification, 'malformed');
  assert.equal(r.ok, false);
});
