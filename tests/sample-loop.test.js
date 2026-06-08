// tests/sample-loop.test.js — eval × sample loop scaffolding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSamples } from '../lib/sample-loop.js';

const EVALS = [
  { id: 'eval-a', expectedFlow: 'load-then-create' },
  { id: 'eval-b', expectedFlow: 'create-only' },
  { id: 'eval-c' },
];

test('happy path: M evals × N samples produces M*N results in order', async () => {
  const seen = [];
  const stage = async ({ ev, sample }) => {
    seen.push(`${ev.id}:${sample}`);
    return { evalId: ev.id, sample, variant: 'control', stages: { stage1: { ok: true } } };
  };
  const { results, errorCounts } = await runSamples({
    evals: EVALS, samples: 2, variant: 'control', stage,
  });
  assert.equal(results.length, 6);
  assert.equal(errorCounts.total, 0);
  assert.deepEqual(seen, [
    'eval-a:1', 'eval-a:2',
    'eval-b:1', 'eval-b:2',
    'eval-c:1', 'eval-c:2',
  ]);
});

test('stage error: caught, recorded as result, loop continues', async () => {
  const stage = async ({ ev, sample }) => {
    if (ev.id === 'eval-b' && sample === 1) {
      throw new Error('synthetic boom');
    }
    return { evalId: ev.id, sample, variant: 'mark-1', stages: {} };
  };
  const { results, errorCounts } = await runSamples({
    evals: EVALS, samples: 2, variant: 'mark-1', stage,
  });
  assert.equal(results.length, 6);
  assert.equal(errorCounts.total, 1);
  assert.equal(errorCounts.byEval.get('eval-b'), 1);
  const errored = results.find((r) => r.error);
  assert.equal(errored.evalId, 'eval-b');
  assert.equal(errored.sample, 1);
  assert.match(errored.error, /synthetic boom/);
});

test('stage returning non-object is treated as error', async () => {
  const stage = async () => null;
  const { results, errorCounts } = await runSamples({
    evals: [EVALS[0]], samples: 1, variant: 'control', stage,
  });
  assert.equal(errorCounts.total, 1);
  assert.match(results[0].error, /non-object/);
});

test('hooks: before/after sample + eval fire in order', async () => {
  const order = [];
  const { results } = await runSamples({
    evals: [EVALS[0], EVALS[1]],
    samples: 1,
    variant: 'control',
    stage: async ({ ev }) => {
      order.push(`stage:${ev.id}`); return { evalId: ev.id, sample: 1, variant: 'control' }; 
    },
    beforeEval: ({ ev }) => order.push(`beforeEval:${ev.id}`),
    afterEval: ({ ev }) => order.push(`afterEval:${ev.id}`),
    beforeSample: ({ ev }) => order.push(`beforeSample:${ev.id}`),
    afterSample: ({ ev }) => order.push(`afterSample:${ev.id}`),
  });
  assert.equal(results.length, 2);
  assert.deepEqual(order, [
    'beforeEval:eval-a', 'beforeSample:eval-a', 'stage:eval-a', 'afterSample:eval-a', 'afterEval:eval-a',
    'beforeEval:eval-b', 'beforeSample:eval-b', 'stage:eval-b', 'afterSample:eval-b', 'afterEval:eval-b',
  ]);
});

test('hooks errors propagate (loop bails)', async () => {
  await assert.rejects(
    () => runSamples({
      evals: [EVALS[0]],
      samples: 1,
      variant: 'control',
      stage: async () => ({}),
      beforeSample: () => {
        throw new Error('hook explosion'); 
      },
    }),
    /hook explosion/,
  );
});

test('validation: missing evals', async () => {
  await assert.rejects(() => runSamples({ samples: 1, variant: 'c', stage: () => {} }), /evals\[\] required/);
});

test('validation: bad samples count', async () => {
  await assert.rejects(() => runSamples({ evals: [EVALS[0]], samples: 0, variant: 'c', stage: () => {} }), /positive integer/);
});

test('validation: missing stage', async () => {
  await assert.rejects(() => runSamples({ evals: [EVALS[0]], samples: 1, variant: 'c' }), /stage\(fn\) required/);
});

test('validation: missing variant', async () => {
  await assert.rejects(() => runSamples({ evals: [EVALS[0]], samples: 1, stage: () => {} }), /variant required/);
});

test('validation: eval without id', async () => {
  await assert.rejects(
    () => runSamples({ evals: [{}], samples: 1, variant: 'c', stage: () => {} }),
    /every eval needs an id/,
  );
});
