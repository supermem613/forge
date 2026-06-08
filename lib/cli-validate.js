// lib/cli-validate.js — `forge validate <runbook>`.
//
// Validates a runbook directory against the contract documented in
// docs/RUNBOOK_CONTRACT.md. Reports issues without modifying anything.
//
// Checks:
//   - manifest.json exists and parses
//   - manifest.id matches directory name
//   - manifest.version is a semver string (x.y.z)
//   - manifest.evals is a non-empty array; every referenced file exists
//   - each eval JSON parses, has id + criteria.{must,should,could} arrays
//   - manifest.fixturePrefix exists and starts with `_ForgeTest_`
//   - README.md exists for human runbook context
//   - if manifest.fixtures.docLib.files referenced, every file exists
//
// Returns { ok: boolean, errors: string[], warnings: string[] }.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const STEP_SHIM_WARN_LINES = 120;
const RUN_STEP_WARN_LINES = 300;
const CRITERION_MIN_CHARS = 8;
const LARGE_FIXTURE_WARN_BYTES = 5 * 1024 * 1024;

function criterionText(criterion) {
  if (typeof criterion === 'string') {
    return criterion;
  }
  if (criterion && typeof criterion === 'object') {
    if (typeof criterion.text === 'string') {
      return criterion.text;
    }
    if (typeof criterion.criterion === 'string') {
      return criterion.criterion;
    }
  }
  return null;
}

function countMeaningfulLines(source) {
  return source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('//') && !line.startsWith('#!')).length;
}

export async function validateRunbook({ runbookDir, runbookId } = {}) {
  if (!runbookDir) {
    throw new Error('validateRunbook: runbookDir required');
  }
  const errors = [];
  const warnings = [];

  let manifest;
  const manifestPath = path.join(runbookDir, 'manifest.json');
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (e) {
    errors.push(`manifest.json missing or invalid JSON: ${e.message}`);
    return { ok: false, errors, warnings };
  }

  const expectedId = runbookId || path.basename(runbookDir);
  if (manifest.id !== expectedId) {
    errors.push(`manifest.id="${manifest.id}" != directory name "${expectedId}"`);
  }
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    errors.push(`manifest.version must be semver (x.y.z), got "${manifest.version}"`);
  }
  if (typeof manifest.fixturePrefix !== 'string' || !manifest.fixturePrefix.startsWith('_ForgeTest_')) {
    errors.push(`manifest.fixturePrefix must start with "_ForgeTest_" (got "${manifest.fixturePrefix}")`);
  }

  try {
    await fs.access(path.join(runbookDir, 'README.md'));
  } catch {
    errors.push('README.md missing: runbooks require a human-facing overview');
  }

  if (!Array.isArray(manifest.evals) || manifest.evals.length === 0) {
    errors.push('manifest.evals must be a non-empty array');
  } else {
    for (const rel of manifest.evals) {
      const evalPath = path.join(runbookDir, rel);
      let evalJson;
      try {
        evalJson = JSON.parse(await fs.readFile(evalPath, 'utf8')); 
      } catch (e) {
        errors.push(`evals: ${rel}: missing or invalid JSON (${e.message})`);
        continue;
      }
      if (typeof evalJson.id !== 'string' || !evalJson.id) {
        errors.push(`evals: ${rel}: missing "id" field`);
      }
      const c = evalJson.criteria || {};
      for (const tier of ['must', 'should', 'could']) {
        if (!Array.isArray(c[tier])) {
          errors.push(`evals: ${rel}: criteria.${tier} must be an array`);
        }
      }
      const must = Array.isArray(c.must) ? c.must : [];
      if (must.length === 0) {
        warnings.push(`evals: ${rel}: criteria.must is empty (gate-style evals usually need at least one must)`);
      }
      const seenCriteria = new Set();
      for (const tier of ['must', 'should', 'could']) {
        const criteria = Array.isArray(c[tier]) ? c[tier] : [];
        for (let i = 0; i < criteria.length; i++) {
          const text = criterionText(criteria[i]);
          if (text == null) {
            warnings.push(`evals: ${rel}: criteria.${tier}[${i}] has no text field; judge prompts need explicit criterion text`);
            continue;
          }
          const trimmed = text.trim();
          if (trimmed.length < CRITERION_MIN_CHARS) {
            warnings.push(`evals: ${rel}: criteria.${tier}[${i}] is very short; make criteria observable and specific`);
          }
          const key = `${tier}\0${trimmed.toLowerCase()}`;
          if (seenCriteria.has(key)) {
            warnings.push(`evals: ${rel}: duplicate criteria.${tier} text "${trimmed}"`);
          }
          seenCriteria.add(key);
        }
      }

    }
  }

  if (manifest.fixtures && manifest.fixtures.docLib && Array.isArray(manifest.fixtures.docLib.files)) {
    for (const f of manifest.fixtures.docLib.files) {
      const fp = path.join(runbookDir, f);
      try {
        const stat = await fs.stat(fp);
        if (stat.size >= LARGE_FIXTURE_WARN_BYTES) {
          warnings.push(`fixtures.docLib.files: ${f} is ${stat.size} bytes; large fixtures slow setup/run and should be intentional`);
        }
      } catch {
        errors.push(`fixtures.docLib.files: ${f} not found`); 
      }
    }
  }

  // Check the canonical step shims exist (RUNBOOK_CONTRACT §3).
  for (const step of ['setup.js', 'run.js', 'score.js', 'judge.js', 'report.js', 'teardown.js']) {
    const stepPath = path.join(runbookDir, step);
    try {
      const source = await fs.readFile(stepPath, 'utf8');
      const lineCount = countMeaningfulLines(source);
      const warnAt = step === 'run.js' ? RUN_STEP_WARN_LINES : STEP_SHIM_WARN_LINES;
      if (lineCount > warnAt) {
        warnings.push(`step shim ${step} has ${lineCount} meaningful lines; prefer moving mechanics into lib/`);
      }
    } catch {
      errors.push(`step shim missing: ${step}`); 
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatValidateResult(result, { runbookId } = {}) {
  const lines = [];
  const tag = runbookId ? `[${runbookId}] ` : '';
  if (result.ok && result.warnings.length === 0) {
    lines.push(`${tag}OK`);
  } else if (result.ok) {
    lines.push(`${tag}OK with ${result.warnings.length} warning(s):`);
    for (const w of result.warnings) {
      lines.push(`  warning: ${w}`);
    }
  } else {
    lines.push(`${tag}FAIL: ${result.errors.length} error(s)${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ''}`);
    for (const e of result.errors) {
      lines.push(`  error:   ${e}`);
    }
    for (const w of result.warnings) {
      lines.push(`  warning: ${w}`);
    }
  }
  return lines.join('\n') + '\n';
}
