// lib/cli-add-eval.js — `forge add-eval <runbook> --file <path>`.
//
// Adds an eval JSON file to runbooks/<rb>/evals/ and registers it in
// runbooks/<rb>/manifest.json's `evals` array. Idempotent: re-running
// with the same destination is a no-op for the manifest. The runbook-
// add-eval skill becomes a thin wrapper.
//
// Eval shape requirements (the minimum forge enforces; runbook-specific
// fields are passed through unchanged):
//   - top-level `id` string (kebab-case)
//   - `criteria` object with `must`, `should`, `could` arrays

import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

export function validateEvalShape(json) {
  const errors = [];
  if (!json || typeof json !== 'object') {
    errors.push('eval: not a JSON object'); return errors; 
  }
  if (typeof json.id !== 'string' || !json.id) {
    errors.push('eval: missing string `id`');
  }
  if (json.id && !KEBAB_RE.test(json.id)) {
    errors.push(`eval.id: must be kebab-case (got "${json.id}")`);
  }
  if (!json.criteria || typeof json.criteria !== 'object') {
    errors.push('eval: missing `criteria` object'); return errors;
  }
  for (const tier of ['must', 'should', 'could']) {
    if (!Array.isArray(json.criteria[tier])) {
      errors.push(`eval.criteria.${tier}: must be an array (use [] for empty)`);
    }
  }
  return errors;
}

// Pick the next NN- prefix by scanning existing eval filenames.
export function nextEvalNumber(existingFilenames) {
  let max = 0;
  for (const name of existingFilenames) {
    const m = /^(\d+)-/.exec(name);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(2, '0');
}

export function destFilename(evalId, existingFilenames) {
  const nn = nextEvalNumber(existingFilenames);
  // If the id already starts with NN-, don't double-prefix.
  if (/^\d+-/.test(evalId)) {
    return `${evalId}.json`;
  }
  return `${nn}-${evalId}.json`;
}

// Insert relative path into manifest.evals, preserving order and
// avoiding duplicates. Returns updated manifest object.
export function addEvalToManifest(manifest, evalRelPath) {
  const evals = Array.isArray(manifest.evals) ? [...manifest.evals] : [];
  if (!evals.includes(evalRelPath)) {
    evals.push(evalRelPath);
  }
  return { ...manifest, evals };
}

export async function addEval({ runbookDir, sourceFile, json, dryRun = false } = {}) {
  if (!runbookDir) {
    throw new Error('addEval: runbookDir required');
  }
  if (!sourceFile && !json) {
    throw new Error('addEval: sourceFile or json required');
  }

  let payload = json;
  if (sourceFile) {
    const raw = await fs.readFile(sourceFile, 'utf8');
    try {
      payload = JSON.parse(raw); 
    } catch (e) {
      throw new Error(`addEval: ${sourceFile} is not valid JSON: ${e.message}`); 
    }
  }

  const errors = validateEvalShape(payload);
  if (errors.length) {
    throw new Error(`addEval: invalid eval shape:\n  - ${errors.join('\n  - ')}`);
  }

  const evalsDir = path.join(runbookDir, 'evals');
  await fs.mkdir(evalsDir, { recursive: true });
  const existing = (await fs.readdir(evalsDir)).filter(f => f.endsWith('.json'));
  const filename = destFilename(payload.id, existing);
  const destPath = path.join(evalsDir, filename);
  const evalRelPath = path.posix.join('evals', filename);

  // Refuse to overwrite an existing eval file (would silently drop the
  // user's previous eval). The user can delete + re-run if intentional.
  let dstExists = false;
  try {
    await fs.access(destPath); dstExists = true; 
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    } 
  }
  if (dstExists) {
    throw new Error(`addEval: ${destPath} already exists (delete first if you really want to replace it)`);
  }

  const manifestPath = path.join(runbookDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const updatedManifest = addEvalToManifest(manifest, evalRelPath);

  if (dryRun) {
    return {
      changed: false, dryRun: true,
      destPath, evalRelPath, manifestPath, manifest: updatedManifest,
    };
  }

  await fs.writeFile(destPath, JSON.stringify(payload, null, 2) + '\n');
  await fs.writeFile(manifestPath, JSON.stringify(updatedManifest, null, 2) + '\n');
  return {
    changed: true, destPath, evalRelPath, manifestPath,
    addedToManifest: !manifest.evals?.includes(evalRelPath),
  };
}
