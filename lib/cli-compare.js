// lib/cli-compare.js — `forge compare <exp> <a> <b>`.
//
// Compares the latest REPORT.json from two variants in the same
// experiment. Prints headline overall + per-tier deltas side-by-side
// plus a "B - A" delta column. Useful for "is mark-2 actually better
// than mark-1, or did we just regress further from control?".
//
// Each variant arg can be:
//   - "control"       (latest control run)
//   - "mark-N"        (latest run under variants/mark-N/runs/)
//   - "mark-N:<ts>"   (specific run timestamp)
//
// Returns { ok, a, b, headline:{overall:{a,b,delta}, tiers:{must:..,should:..,could:..}}}.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const TIERS = ['must', 'should', 'could'];

function parseSpec(spec) {
  const m = /^([^:]+)(?::(.+))?$/.exec(spec);
  if (!m) {
    throw new Error(`compare: bad variant spec "${spec}"`);
  }
  return { variant: m[1], ts: m[2] || null };
}

async function latestRunDir({ expDir, variant }) {
  const runsDir = path.join(expDir, 'variants', variant, 'runs');
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true }); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`compare: no runs for variant "${variant}"`);
    }
    throw e;
  }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  if (dirs.length === 0) {
    throw new Error(`compare: no runs for variant "${variant}"`);
  }
  return path.join(runsDir, dirs[dirs.length - 1]);
}

async function loadReport({ expDir, spec }) {
  const { variant, ts } = parseSpec(spec);
  const runDir = ts
    ? path.join(expDir, 'variants', variant, 'runs', ts)
    : await latestRunDir({ expDir, variant });
  const reportPath = path.join(runDir, 'REPORT.json');
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8')); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`compare: no REPORT.json in ${runDir} (run \`forge report\` first)`);
    }
    throw e;
  }
  return { variant, runDir, report };
}

export async function compareVariants({ expDir, specA, specB } = {}) {
  if (!expDir) {
    throw new Error('compareVariants: expDir required');
  }
  if (!specA || !specB) {
    throw new Error('compareVariants: specA and specB required');
  }
  const a = await loadReport({ expDir, spec: specA });
  const b = await loadReport({ expDir, spec: specB });

  const overallA = a.report.headline?.overall ?? null;
  const overallB = b.report.headline?.overall ?? null;
  const tiersA = a.report.headline?.tiers || {};
  const tiersB = b.report.headline?.tiers || {};

  const headline = {
    overall: {
      a: overallA, b: overallB,
      delta: (overallA != null && overallB != null) ? overallB - overallA : null,
    },
    tiers: {},
  };
  for (const tier of TIERS) {
    const ta = tiersA[tier] ?? null;
    const tb = tiersB[tier] ?? null;
    headline.tiers[tier] = { a: ta, b: tb, delta: (ta != null && tb != null) ? tb - ta : null };
  }

  return {
    ok: true,
    a: { spec: specA, variant: a.variant, runDir: a.runDir },
    b: { spec: specB, variant: b.variant, runDir: b.runDir },
    headline,
  };
}

function fmtPp(v) {
  if (v == null || Number.isNaN(v)) {
    return '   n/a';
  }
  const sign = v > 0 ? '+' : (v < 0 ? '−' : '±');
  return `${sign}${Math.abs(v).toFixed(1)}pp`.padStart(7);
}

export function formatCompare(result) {
  const lines = [];
  lines.push(`Compare: ${result.a.spec} vs ${result.b.spec}`);
  lines.push(`  A: ${result.a.runDir}`);
  lines.push(`  B: ${result.b.runDir}`);
  lines.push('');
  lines.push('  Metric        A          B          B − A');
  lines.push('  ──────────  ───────    ───────    ───────');
  const o = result.headline.overall;
  lines.push(`  Overall     ${fmtPp(o.a)}    ${fmtPp(o.b)}    ${fmtPp(o.delta)}`);
  for (const tier of TIERS) {
    const t = result.headline.tiers[tier];
    lines.push(`  ${tier.padEnd(10)}  ${fmtPp(t.a)}    ${fmtPp(t.b)}    ${fmtPp(t.delta)}`);
  }
  return lines.join('\n') + '\n';
}
