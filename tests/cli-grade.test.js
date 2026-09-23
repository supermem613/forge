// tests/cli-grade.test.js — forge grade oracle vs judge dispatch contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGrade } from '../lib/cli-grade.js';

test('runGrade: oracle prepare next names judgeDispatches=0 and score.json', async () => {
  const result = await runGrade({
    experiment: 'demo',
    evalKind: 'oracle',
    runStep: async () => JSON.stringify({ evalKind: 'oracle', judgeDispatches: 0 }),
  });
  assert.equal(result.phase, 'prepare');
  assert.equal(result.judge.judgeDispatches, 0);
  // Spec literals: operator next-steps must name the skip and the score path.
  assert.ok(result.next.some((s) => s.includes('judgeDispatches=0')));
  assert.ok(result.next.some((s) => s.includes('score.json')));
});

test('runGrade: oracle finalize scores without validate or collect', async () => {
  const steps = [];
  const result = await runGrade({
    experiment: 'demo',
    evalKind: 'oracle',
    finalize: true,
    runStep: async ({ step }) => {
      steps.push(step);
      return JSON.stringify({ step, ok: true });
    },
  });
  assert.equal(result.phase, 'finalize');
  assert.equal(result.score.ok, true);
  assert.deepEqual(steps, ['score']);
});
