// tests/eval-loader.test.js — criterion ID + criteriaHash contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeEval,
  computeCriteriaHash,
  loadEval,
  loadEvals,
} from '../lib/eval-loader.js';

const SAMPLE = {
  id: '99-test-eval',
  authoringPrompt: 'Create a skill for testing.',
  criteria: {
    must: ['Stage 1 invoked the expected tool.', 'Stage 2 answer cites the source.'],
    should: ['Stage 1: kebab-case name.'],
    could: ['Stage 2: bullets ≤ 5 words.'],
  },
};

test('normalizeEval: legacy string array → rich {id,text,hash}', () => {
  const ev = normalizeEval(SAMPLE);
  assert.equal(ev.criteria.must.length, 2);
  for (const c of ev.criteria.must) {
    assert.match(c.id, /^must-[0-9a-f]{8}$/);
    assert.equal(typeof c.text, 'string');
    assert.match(c.hash, /^[0-9a-f]{64}$/);
  }
  assert.match(ev.criteria.should[0].id, /^should-/);
  assert.match(ev.criteria.could[0].id, /^could-/);
});

test('normalizeEval: rich object form is honored (id preserved)', () => {
  const rich = {
    criteria: {
      must: [{ id: 'human-readable-id', text: 'do the thing' }],
      should: [],
      could: [],
    },
  };
  const ev = normalizeEval(rich);
  assert.equal(ev.criteria.must[0].id, 'human-readable-id');
  // hash always derived from text
  assert.match(ev.criteria.must[0].hash, /^[0-9a-f]{64}$/);
});

test('normalizeEval: malformed criterion throws with tier in message', () => {
  assert.throws(
    () => normalizeEval({ criteria: { must: [42], should: [], could: [] } }),
    /tier "must"/,
  );
});

test('normalizeEval: missing criteria tiers default to []', () => {
  const ev = normalizeEval({ id: 'x', criteria: { must: ['a'] } });
  assert.deepEqual(ev.criteria.should, []);
  assert.deepEqual(ev.criteria.could, []);
});

test('hash is deterministic across calls', () => {
  const a = normalizeEval(SAMPLE).criteriaHash;
  const b = normalizeEval(SAMPLE).criteriaHash;
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('criteriaHash changes when criterion text changes', () => {
  const a = normalizeEval(SAMPLE).criteriaHash;
  const mutated = JSON.parse(JSON.stringify(SAMPLE));
  mutated.criteria.must[0] = mutated.criteria.must[0] + ' (revised)';
  const b = normalizeEval(mutated).criteriaHash;
  assert.notEqual(a, b);
});

test('criteriaHash changes when criterion added or removed', () => {
  const base = normalizeEval(SAMPLE).criteriaHash;
  const added = JSON.parse(JSON.stringify(SAMPLE));
  added.criteria.could.push('Stage 2: extra criterion.');
  assert.notEqual(base, normalizeEval(added).criteriaHash);

  const removed = JSON.parse(JSON.stringify(SAMPLE));
  removed.criteria.must.pop();
  assert.notEqual(base, normalizeEval(removed).criteriaHash);
});

test('criteriaHash changes when criterion moves between tiers', () => {
  const a = normalizeEval(SAMPLE).criteriaHash;
  const moved = JSON.parse(JSON.stringify(SAMPLE));
  // Move first must → could
  const text = moved.criteria.must.shift();
  moved.criteria.could.push(text);
  assert.notEqual(a, normalizeEval(moved).criteriaHash);
});

test('criteriaHash is INVARIANT under reorder within a tier', () => {
  const a = normalizeEval(SAMPLE).criteriaHash;
  const reordered = JSON.parse(JSON.stringify(SAMPLE));
  reordered.criteria.must.reverse();
  assert.equal(a, normalizeEval(reordered).criteriaHash);
});

test('computeCriteriaHash: empty all-tiers is deterministic', () => {
  const empty = { must: [], should: [], could: [] };
  assert.equal(computeCriteriaHash(empty), computeCriteriaHash(empty));
});

test('loadEval: reads existing runbook eval (legacy string-array shape)', async () => {
  const ev = await loadEval(
    path.resolve('tests', 'fixtures', 'sample-eval.json')
  );
  assert.ok(ev.criteria.must.length > 0);
  assert.ok(ev.criteriaHash);
  for (const c of ev.criteria.must) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.text, 'string');
    assert.equal(typeof c.hash, 'string');
  }
});

test('loadEvals: returns sorted list of normalized evals with sourceFile', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-eval-loader-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, '02-b.json'),
    JSON.stringify({ id: '02-b', criteria: { must: ['x'] } }));
  await fs.writeFile(path.join(dir, '01-a.json'),
    JSON.stringify({ id: '01-a', criteria: { must: ['y'] } }));

  const evals = await loadEvals(dir);
  assert.equal(evals.length, 2);
  assert.equal(evals[0].sourceFile, '01-a.json');
  assert.equal(evals[1].sourceFile, '02-b.json');
  assert.equal(evals[0].criteriaHash.length, 64);
});
