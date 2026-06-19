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
import { ForgeError } from './envelope.js';

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
      throw new ForgeError('resolvePair: no control runs', { code: 'NOT_FOUND', hint: 'Run `forge run <exp> control` to produce a control run first.' });
    }
    const marks = await listMarks(expDir);
    if (marks.length === 0) {
      return { controlRun, variantRun: null, variantName: null };
    }
    const lastMark = marks[marks.length - 1].name;
    const variantRunsDir = path.join(expDir, 'variants', lastMark, 'runs');
    const variantRun = await latest({ runsDir: variantRunsDir });
    if (!variantRun) {
      throw new ForgeError(`resolvePair: no runs under variants/${lastMark}/`, { code: 'NOT_FOUND', hint: `Run \`forge run <exp> ${lastMark}\` to produce a variant run first.` });
    }
    return { controlRun, variantRun, variantName: lastMark };
  }
  const m = /^(.+?)\+(mark-\d+):(.+)$/.exec(pairArg);
  if (!m) {
    throw new ForgeError(`resolvePair: --pair must be 'latest' or '<ctlTs>+<mark>:<txTs>' (got '${pairArg}')`, { code: 'USAGE', hint: 'Use --pair latest or --pair <ctlTs>+<mark>:<txTs>.' });
  }
  return {
    controlRun: path.join(expDir, 'variants', 'control', 'runs', m[1]),
    variantRun: path.join(expDir, 'variants', m[2], 'runs', m[3]),
    variantName: m[2],
  };
}

// Resolve the variant run for the mark immediately before `currentVariantName`.
// "Previous" means the highest mark whose number is below the current mark, so a
// mark-8 current resolves to the latest run under mark-7. Returns nulls when the
// current variant is not a mark, when no earlier mark exists, or when the earlier
// mark has no runs. The trend comparison must degrade to a control-vs-variant view
// rather than fail when there is nothing earlier to compare against.
export async function resolvePrevVariant(expDir, currentVariantName) {
  if (!currentVariantName) {
    return { prevVariantRun: null, prevVariantName: null };
  }
  const cur = /^mark-(\d+)$/.exec(currentVariantName);
  if (!cur) {
    return { prevVariantRun: null, prevVariantName: null };
  }
  const curN = Number(cur[1]);
  const marks = await listMarks(expDir);
  const earlier = marks.filter(m => m.n < curN);
  if (earlier.length === 0) {
    return { prevVariantRun: null, prevVariantName: null };
  }
  const prevMark = earlier[earlier.length - 1].name;
  const prevVariantRun = await latest({ runsDir: path.join(expDir, 'variants', prevMark, 'runs') });
  if (!prevVariantRun) {
    return { prevVariantRun: null, prevVariantName: null };
  }
  return { prevVariantRun, prevVariantName: prevMark };
}
