// lib/experiment.js — shared experiment.json load/validate, used by forge
// core and by forge modules so both classify the same failures identically.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ForgeError } from './envelope.js';

// Read, parse, and validate an experiment's experiment.json.
// File-read and JSON.parse are split so only an actual parse failure maps to
// VALIDATION_FAILED. A non-ENOENT read failure such as EACCES or EISDIR stays
// an honest IO error rather than a misleading "repair your JSON" hint.
// INVARIANT: callers across both repos depend on these exact error codes
// (NOT_FOUND for a missing experiment, VALIDATION_FAILED for corrupt or
// runbook-less config). Keep this the single source for that contract.
export async function readExperimentConfig({ experimentsDir, name }) {
  const dir = path.join(experimentsDir, name);
  const expJsonPath = path.join(dir, 'experiment.json');
  let raw;
  try {
    raw = await fs.readFile(expJsonPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ForgeError(`no such experiment: ${name} (missing experiments/${name}/experiment.json)`, { code: 'NOT_FOUND', hint: 'Run `forge experiments` to list experiments, or `forge new-experiment <name> --runbook <rb>`.' });
    }
    throw e;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ForgeError(`experiments/${name}/experiment.json could not be parsed: ${e.message}`, { code: 'VALIDATION_FAILED', hint: 'Repair experiment.json so it is valid JSON, or re-scaffold with `forge new-experiment`.' });
  }
  if (!json.runbook) {
    throw new ForgeError(`experiments/${name}/experiment.json missing "runbook" field`, { code: 'VALIDATION_FAILED', hint: 'Add a "runbook" field naming the runbook this experiment uses.' });
  }
  return { dir, json };
}
