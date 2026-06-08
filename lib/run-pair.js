// lib/run-pair.js — resolve a {control, variant} run pair from an experiment.
//
// Used by `forge judge` and `forge report` to find what to compare.
//
// `latest`: pick the most recent control × the most recent run under the
//           highest mark variant. If no marks exist yet, returns variant=null
//           (control-only baseline mode).
// explicit: '<ctlTs>+<mark>:<txTs>' addresses a specific pair.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { latest } from './run-bundle.js';

export async function listMarks(expDir) {
  const dir = path.join(expDir, 'variants');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return [];
    } throw e; 
  }
  const marks = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const m = /^mark-(\d+)$/.exec(e.name);
    if (m) {
      marks.push({ name: e.name, n: Number(m[1]) });
    }
  }
  return marks.sort((a, b) => a.n - b.n);
}

export async function resolvePair(expDir, pairArg) {
  if (!pairArg || pairArg === 'latest') {
    const controlRunsDir = path.join(expDir, 'variants', 'control', 'runs');
    const controlRun = await latest({ runsDir: controlRunsDir });
    if (!controlRun) {
      throw new Error('resolvePair: no control runs');
    }
    const marks = await listMarks(expDir);
    if (marks.length === 0) {
      return { controlRun, variantRun: null, variantName: null };
    }
    const lastMark = marks[marks.length - 1].name;
    const variantRunsDir = path.join(expDir, 'variants', lastMark, 'runs');
    const variantRun = await latest({ runsDir: variantRunsDir });
    if (!variantRun) {
      throw new Error(`resolvePair: no runs under variants/${lastMark}/`);
    }
    return { controlRun, variantRun, variantName: lastMark };
  }
  const m = /^(.+?)\+(mark-\d+):(.+)$/.exec(pairArg);
  if (!m) {
    throw new Error(`resolvePair: --pair must be 'latest' or '<ctlTs>+<mark>:<txTs>' (got '${pairArg}')`);
  }
  return {
    controlRun: path.join(expDir, 'variants', 'control', 'runs', m[1]),
    variantRun: path.join(expDir, 'variants', m[2], 'runs', m[3]),
    variantName: m[2],
  };
}
