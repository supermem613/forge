// lib/eval-loader.js — load runbook eval JSON with stable criterion identity.
//
// Contract: every criterion gets `{id, text, hash}` and every eval
// gets a top-level `criteriaHash`. This is what lets the judge collector
// detect when verdicts on disk were produced against a stale rubric.
//
// ## Shapes accepted on read
//
// 1. Legacy (string array, today's runbook eval JSON):
//      "criteria": { "must": ["text 1", "text 2"], ... }
//
// 2. Rich (post-Phase-0.2, written by forge validate):
//      "criteria": { "must": [{ "id": "must-3f2a1c0e", "text": "...", "hash": "..." }], ... }
//
// loadEval() always returns the rich shape in-memory, so downstream code
// (judge orchestrator, score, refit-stale) never branches on input shape.
//
// ## ID derivation (stable as long as criterion text is unchanged)
//
//   id   = `${tier}-${sha256(text).slice(0, 8)}`     (lowercase hex)
//   hash = sha256(text)                              (full lowercase hex)
//
// If the JSON already declares an explicit `id`, we honor it (allows hand-
// editing for human-readable IDs). The hash is always recomputed from text —
// it is a fingerprint, not a name.
//
// ## criteriaHash (eval-level fingerprint)
//
// criteriaHash = sha256(
//   "must:"   + sorted(must.hash).join(',')   + "|" +
//   "should:" + sorted(should.hash).join(',') + "|" +
//   "could:"   + sorted(could.hash).join(',')
// )
//
// Invariant under reorder WITHIN a tier; varies if any criterion text changes
// or any criterion is added/removed in any tier. Verdicts carry this hash so
// `judge --mode collect` can detect drift without comparing every text string.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

const TIERS = ['must', 'should', 'could'];

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function normalizeCriterion(tier, raw) {
  if (typeof raw === 'string') {
    const text = raw;
    const hash = sha256Hex(text);
    return { id: `${tier}-${hash.slice(0, 8)}`, text, hash };
  }
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
    const text = raw.text;
    const hash = sha256Hex(text);
    const id = typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : `${tier}-${hash.slice(0, 8)}`;
    return { id, text, hash };
  }
  throw new Error(
    `eval-loader: criterion in tier "${tier}" must be a string or {id?, text} object (got ${JSON.stringify(raw)})`
  );
}

export function computeCriteriaHash(criteria) {
  const parts = TIERS.map(tier => {
    const list = criteria[tier] ?? [];
    const hashes = list.map(c => c.hash).sort();
    return `${tier}:${hashes.join(',')}`;
  });
  return sha256Hex(parts.join('|'));
}

export function normalizeEval(rawEval) {
  if (!rawEval || typeof rawEval !== 'object') {
    throw new Error('eval-loader: eval JSON must be an object');
  }
  const criteriaIn = rawEval.criteria ?? {};
  const criteria = {};
  for (const tier of TIERS) {
    const list = criteriaIn[tier] ?? [];
    if (!Array.isArray(list)) {
      throw new Error(`eval-loader: criteria.${tier} must be an array (got ${typeof list})`);
    }
    criteria[tier] = list.map(item => normalizeCriterion(tier, item));
  }
  const criteriaHash = computeCriteriaHash(criteria);
  return { ...rawEval, criteria, criteriaHash };
}

export async function loadEval(filePath) {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  return normalizeEval(raw);
}

export async function loadEvals(dirPath) {
  const entries = await fs.readdir(dirPath);
  const files = entries.filter(n => n.endsWith('.json')).sort();
  const out = [];
  for (const name of files) {
    const ev = await loadEval(`${dirPath}/${name}`);
    out.push({ ...ev, sourceFile: name });
  }
  return out;
}
