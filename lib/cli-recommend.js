// lib/cli-recommend.js — `forge recommend <experiment>`
//
// The deliberate counterpart to `forge report` / `forge present`. Those surfaces
// are data-only: what happened, did the tools behave, what moved. This surface
// is the prescriptive layer: what to do next. Keeping advice in its own step is
// the whole point. A reader who only wants the numbers never has recommendations
// braided into the analysis, and a reader who wants advice asks for it explicitly.
//
// It reads the already-written REPORT.json (no re-derivation) so the
// recommendations are exactly the ones the scored run produced.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePair } from './run-pair.js';
import { ForgeError } from './envelope.js';

function fmtDelta(d) {
  if (d == null) {
    return 'n/a';
  }
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}pp`;
}

// Headline-driven next-step call. Mirrors the prior in-report heuristic, now
// owned by the recommendation surface instead of the analysis surface.
function nextStep(report) {
  const overall = report.headline?.overall ?? 0;
  if (overall >= 5) {
    return `Variant is winning by ${fmtDelta(overall)}. Promote it to the next mark and lock the prior baseline in the runbook README changelog.`;
  }
  if (overall <= -5) {
    return `Variant is regressing by ${fmtDelta(overall)}. Inspect the top criterion movements before iterating; the regression is concentrated in those criteria.`;
  }
  return `Variant is roughly flat (${fmtDelta(overall)}). Increase samples before drawing a verdict, or pivot the change rather than committing more iterations.`;
}

export async function buildRecommendation({ experiment, pair = 'latest', repoRoot }) {
  const expDir = path.join(repoRoot, 'experiments', experiment);
  const { variantRun, variantName } = await resolvePair(expDir, pair);
  if (!variantRun) {
    throw new ForgeError(`recommend: no variant run for experiment '${experiment}' (pair=${pair}) — control-only baselines have nothing to recommend against`, { code: 'NOT_FOUND', hint: 'Propose and run a variant first: `forge propose <exp>` then `forge run <exp> mark-N`.' });
  }
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(variantRun, 'REPORT.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ForgeError(`recommend: REPORT.json missing under ${variantRun}. Run \`forge report ${experiment}\` first.`, { code: 'NOT_FOUND', hint: `Run \`forge report ${experiment}\` first.` });
    }
    throw e;
  }

  const suggestions = (report.insights && report.insights.suggestions) || [];

  const lines = [];
  lines.push(`# Recommendations — ${experiment} · ${variantName}`);
  lines.push('');
  lines.push('_Prescriptive guidance, derived from the scored run. For the data-only analysis, see `forge present` / REPORT.md._');
  lines.push('');
  lines.push('## Next step');
  lines.push('');
  lines.push(`- ${nextStep(report)}`);
  lines.push('');
  if (suggestions.length) {
    lines.push('## Suggested next variant');
    lines.push('');
    for (const s of suggestions) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  } else {
    lines.push('_No additional variant-level suggestions were derived for this run._');
    lines.push('');
  }

  return { markdown: lines.join('\n'), variantName, suggestionCount: suggestions.length };
}
