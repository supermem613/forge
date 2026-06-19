// lib/judge.js — criteria-based PASS/FAIL agent-as-judge.
//
// Each eval declares criteria in three tiers:
//   { must: [..], should: [..], could: [..] }
//
// For each (eval, sample) the host agent reads a prompt file containing the
// sample's artifact (stage 1 + stage 2) and the criteria list, then writes a
// JSON sibling with shape:
//
//   {
//     "evalId": "...", "sample": 1,
//     "model": "gpt-5.5",                 // judge model that produced the verdict
//     "promptVersion": 1,                 // JUDGE_PROMPT_VERSION at time of judging
//     "criteriaHash": "<64-hex>",         // criteriaHash of the rubric used
//     "criteria_results": {
//       "must":   [ { "criterion": "...", "pass": true,  "reasoning": "...", "evidence": ["turn1/..."] }, ... ],
//       "should": [ ... ],
//       "could":   [ ... ]
//     }
//   }
//
// The arrays must have the same length and ORDER as the criteria input.
// score.js aggregates these into per-(eval, tier, variant) pass rates.
//
// `classifyVerdict()` is the durable contract — it labels every verdict as
// one of: valid | legacy | missing | malformed | stale-criteria | wrong-model.
// `--mode collect` uses these labels to give specific error messages instead
// of just "bad verdict".

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TIERS = ['must', 'should', 'could'];

// Bumps when the judge prompt template changes in a way that affects verdict
// reproducibility. Stored in every verdict so refits can be reasoned about.
export const JUDGE_PROMPT_VERSION = 1;

// Mandated judge model. Verdicts produced by other models are rejected by
// classifyVerdict() unless they carry the explicit forge-auto-fail marker.
export const REQUIRED_JUDGE_MODEL = 'gpt-5.5';

// Sentinel marker placed in `model` when the orchestrator pre-fails a sample
// for samples blocked before invoking the judge sub-agent.
export const AUTO_FAIL_MODEL = 'forge-auto-fail';

function sanitizeId(s) {
  return String(s || 'eval').replace(/[^A-Za-z0-9_-]/g, '_'); 
}

// Verdict directory naming. Default is the canonical immutable
// `judge-verdicts/`. When `refitHash` is provided, refits land in a
// sibling `judge-verdicts-refit/<hash>/` keyed by the EXPECTED criteria
// hash. The original `judge-verdicts/` is never overwritten — append-only
// evidence rule (METHODOLOGY §7).
export function verdictDirRel(refitHash) {
  return refitHash ? `judge-verdicts-refit/${refitHash}` : 'judge-verdicts';
}

// Pull display text out of either legacy string-shape or rich {text, hash} shape.
function criterionText(c) {
  return typeof c === 'string' ? c : c.text; 
}

export function buildCriteriaPrompt({ evalId, sample, criteria, criteriaHash, artifact, header, refitHash }) {
  const lines = [];
  lines.push(`# Judge prompt — ${evalId} sample ${sample}`);
  lines.push('');
  if (header) {
    lines.push(header); lines.push(''); 
  }
  lines.push('You are an experiment judge. Decide whether each criterion below PASSES or FAILS based on the artifact provided. Be specific in your reasoning. Cite evidence (file paths inside this run dir, or quotes from the response text).');
  lines.push('');
  lines.push(`Judge model policy: this prompt MUST be evaluated by ${REQUIRED_JUDGE_MODEL} (\`model: "${REQUIRED_JUDGE_MODEL}"\`). If you are dispatched on a different model, halt and ask the orchestrator to re-dispatch. Mixing models within a control/variant pair contaminates the comparison.`);
  lines.push('');
  lines.push('## Artifact');
  lines.push('');
  lines.push(typeof artifact === 'string' ? artifact : JSON.stringify(artifact, null, 2));
  lines.push('');
  lines.push('## Criteria');
  lines.push('');
  for (const tier of TIERS) {
    const list = criteria[tier] || [];
    lines.push(`### ${tier.toUpperCase()} (${list.length})`);
    list.forEach((c, i) => lines.push(`${i + 1}. ${criterionText(c)}`));
    lines.push('');
  }
  lines.push('## Response format');
  lines.push('');
  lines.push(`Write a JSON file at the SAME basename as this prompt but with extension \`.json\` under \`../${verdictDirRel(refitHash)}/\`, with EXACTLY this shape:`);
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push(`  "evalId": "${evalId}",`);
  lines.push(`  "sample": ${sample},`);
  lines.push(`  "model": "${REQUIRED_JUDGE_MODEL}",`);
  lines.push(`  "promptVersion": ${JUDGE_PROMPT_VERSION},`);
  if (criteriaHash) {
    lines.push(`  "criteriaHash": "${criteriaHash}",`);
  }
  lines.push('  "criteria_results": {');
  for (const tier of TIERS) {
    const list = criteria[tier] || [];
    lines.push(`    "${tier}": [`);
    list.forEach((c, i) => {
      const comma = i < list.length - 1 ? ',' : '';
      lines.push(`      { "criterion": ${JSON.stringify(criterionText(c))}, "pass": true, "reasoning": "...", "evidence": ["..."] }${comma}`);
    });
    const tierComma = tier === 'could' ? '' : ',';
    lines.push(`    ]${tierComma}`);
  }
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(`Each criteria array MUST have the same number of items as the criteria provided, in the same order. \`pass\` MUST be a boolean. Provide one or two sentences of reasoning per criterion. The \`model\`, \`promptVersion\`${criteriaHash ? ', and `criteriaHash`' : ''} fields above are required and must be copied through verbatim.`);
  return lines.join('\n');
}

export async function writePromptForRep({ runDir, evalId, sample, prompt, refitHash }) {
  const promptDir = path.join(runDir, 'judge-prompts');
  const verdictDir = path.join(runDir, ...verdictDirRel(refitHash).split('/'));
  await fs.mkdir(promptDir, { recursive: true });
  await fs.mkdir(verdictDir, { recursive: true });
  const safe = sanitizeId(evalId);
  const p = path.join(promptDir, `${safe}-sample${sample}.md`);
  await fs.writeFile(p, prompt);
  return p;
}

export function expectedVerdictPath({ runDir, evalId, sample, refitHash }) {
  return path.join(runDir, ...verdictDirRel(refitHash).split('/'), `${sanitizeId(evalId)}-sample${sample}.json`);
}

export function validateVerdictShape(json, criteria) {
  const errors = [];
  if (!json || typeof json !== 'object') {
    errors.push('not a JSON object'); return { ok: false, errors }; 
  }
  if (!json.criteria_results || typeof json.criteria_results !== 'object') {
    errors.push('missing criteria_results object');
    return { ok: false, errors };
  }
  for (const tier of TIERS) {
    const expected = criteria[tier] || [];
    const got = json.criteria_results[tier];
    if (!Array.isArray(got)) {
      errors.push(`criteria_results.${tier}: not an array`); continue; 
    }
    if (got.length !== expected.length) {
      errors.push(`criteria_results.${tier}: length ${got.length} != expected ${expected.length}`);
    }
    got.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`${tier}[${i}]: not an object`);
      } else if (typeof entry.pass !== 'boolean') {
        errors.push(`${tier}[${i}].pass: not a boolean`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

// Classify a verdict against the expected rubric/model. Distinct
// labels let `judge --mode collect` give precise errors instead of just "bad".
//
// Labels:
//   'missing'        — verdict file does not exist
//   'malformed'      — JSON parse error or shape violation
//   'wrong-model'    — verdict.model exists and is not REQUIRED_JUDGE_MODEL
//                      (and not AUTO_FAIL_MODEL)
//   'stale-criteria' — verdict.criteriaHash exists and != expectedCriteriaHash
//   'legacy'         — pre-Phase-0.3 verdict (no model/promptVersion/criteriaHash);
//                      shape is otherwise valid. Caller decides whether to
//                      accept (back-compat read of old runs) or reject (refit).
//   'valid'          — all checks pass
//
// `expectedCriteriaHash` is optional; omit it to skip the stale-criteria check
// (e.g., when reading historical bundles whose evals didn't carry hashes).
export function classifyVerdict({ json, criteria, expectedCriteriaHash, parseError }) {
  if (parseError) {
    return { classification: 'malformed', errors: [`parse: ${parseError}`] };
  }
  const shape = validateVerdictShape(json, criteria);
  if (!shape.ok) {
    return { classification: 'malformed', errors: shape.errors };
  }

  const hasModel = typeof json.model === 'string';
  const hasPromptVersion = typeof json.promptVersion === 'number';
  const hasCriteriaHash = typeof json.criteriaHash === 'string';

  // Model check FIRST — wrong-model overrides legacy/stale (we must not trust
  // the verdict's claim of correctness if it came from the wrong model).
  if (hasModel && json.model !== REQUIRED_JUDGE_MODEL && json.model !== AUTO_FAIL_MODEL) {
    return {
      classification: 'wrong-model',
      errors: [`verdict.model="${json.model}" but required="${REQUIRED_JUDGE_MODEL}"`],
    };
  }

  if (hasCriteriaHash && expectedCriteriaHash && json.criteriaHash !== expectedCriteriaHash) {
    return {
      classification: 'stale-criteria',
      errors: [`verdict.criteriaHash="${json.criteriaHash.slice(0, 12)}..." but expected="${expectedCriteriaHash.slice(0, 12)}..."`],
    };
  }

  if (!hasModel && !hasPromptVersion && !hasCriteriaHash) {
    return { classification: 'legacy', errors: [] };
  }

  return { classification: 'valid', errors: [] };
}

export async function readVerdictForRep({ runDir, evalId, sample, criteria, expectedCriteriaHash, refitHash }) {
  const p = expectedVerdictPath({ runDir, evalId, sample, refitHash });
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8'); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { found: false, path: p, classification: 'missing', ok: false, errors: [] };
    }
    throw e;
  }
  let json, parseError;
  try {
    json = JSON.parse(raw); 
  } catch (e) {
    parseError = e.message; 
  }
  const cls = classifyVerdict({ json, criteria, expectedCriteriaHash, parseError });
  // Maintain back-compat fields `ok`/`errors` for callers that haven't
  // migrated to the classification surface yet.
  const ok = cls.classification === 'valid' || cls.classification === 'legacy';
  return {
    found: true,
    path: p,
    json,
    parseError,
    classification: cls.classification,
    errors: cls.errors,
    ok,
  };
}

// Helper for auto-fail samples blocked before judge execution.
export function failAllCriteriaVerdict({ evalId, sample, criteria, criteriaHash, reason }) {
  const out = {
    evalId,
    sample,
    model: AUTO_FAIL_MODEL,
    promptVersion: JUDGE_PROMPT_VERSION,
    autoFailed: true,
    autoFailReason: reason,
    reason,                         // legacy field name; keep for back-compat
    criteria_results: {},
  };
  if (criteriaHash) {
    out.criteriaHash = criteriaHash;
  }
  for (const tier of TIERS) {
    out.criteria_results[tier] = (criteria[tier] || []).map(c => ({
      criterion: criterionText(c),
      pass: false,
      reasoning: `Auto-failed: ${reason}`,
      evidence: ['signals.json'],
    }));
  }
  return out;
}
