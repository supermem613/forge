// lib/sample-loop.js — eval × sample loop scaffolding.
//
// Runbooks often duplicate the same outer structure:
//
//   for (ev of evals) for (sample of 1..N) {
//     hooks.beforeSample({ ev, sample })
//     try {
//       result = await stage({ ev, sample })       // runbook-specific
//     } catch (e) { result = { error: e.message } }
//     hooks.afterSample({ ev, sample, result })
//     allResults.push(result)
//   }
//
// This module owns the loop. Stage execution is injectable so tests don't
// need a real external runner, and so each runbook can pass its own
// orchestration. Errors thrown by `stage` are caught and surfaced as
// `{ evalId, sample, variant, error }` rows; hooks errors propagate.
//
// Counts errors per eval/sample so callers can fail-fast or summarize.

function noop() {}

export async function runSamples({
  evals,
  samples,
  variant,
  stage,                    // async ({ ev, sample, sampleId, variant }) => result
  beforeSample = noop,      // optional pre-sample hook
  afterSample = noop,       // optional post-sample hook
  beforeEval = noop,        // optional pre-eval hook
  afterEval = noop,         // optional post-eval hook
  log = noop,
} = {}) {
  if (!Array.isArray(evals)) {
    throw new Error('runSamples: evals[] required');
  }
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(`runSamples: samples must be positive integer (got ${samples})`);
  }
  if (typeof stage !== 'function') {
    throw new Error('runSamples: stage(fn) required');
  }
  if (!variant) {
    throw new Error('runSamples: variant required');
  }

  const results = [];
  const errorCounts = { byEval: new Map(), total: 0 };

  for (const ev of evals) {
    if (!ev || !ev.id) {
      throw new Error('runSamples: every eval needs an id');
    }
    await beforeEval({ ev, variant });
    for (let sample = 1; sample <= samples; sample++) {
      const sampleId = `${ev.id}-sample${sample}`;
      log(`[sample-loop] ${variant} ${sampleId}\n`);
      await beforeSample({ ev, sample, sampleId, variant });

      let result;
      try {
        result = await stage({ ev, sample, sampleId, variant });
        if (!result || typeof result !== 'object') {
          throw new Error(`stage returned non-object for ${sampleId}`);
        }
      } catch (e) {
        result = {
          evalId: ev.id,
          sample,
          variant,
          error: e.message,
          stages: {},
        };
        errorCounts.total += 1;
        errorCounts.byEval.set(ev.id, (errorCounts.byEval.get(ev.id) || 0) + 1);
        log(`[sample-loop] ${sampleId} ERROR: ${e.message}\n`);
      }

      await afterSample({ ev, sample, sampleId, variant, result });
      results.push(result);
    }
    await afterEval({ ev, variant });
  }

  return { results, errorCounts };
}
