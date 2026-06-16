// lib/cli-present.js — `forge present <experiment>`
// Reads REPORT.json (canonical) and emits a single tight stdout block:
// headline · learnings · per-sample heatmap · top criterion contrasts ·
// next-step suggestion. The orchestrator agent is expected to pipe this
// straight to the user without re-summarizing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePair } from './run-pair.js';
import { ForgeError } from './envelope.js';

const TIERS = ['must', 'should', 'could'];

function fmtDelta(d) {
  if (d == null) {
    return 'n/a';
  }
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}pp`;
}

function fmtPct(p) {
  if (p == null) {
    return 'n/a';
  }
  return `${p.toFixed(1)}%`;
}

export async function buildPresentation({ experiment, pair = 'latest', repoRoot }) {
  const expDir = path.join(repoRoot, 'experiments', experiment);
  const { controlRun, variantRun, variantName } = await resolvePair(expDir, pair);
  if (!variantRun) {
    throw new ForgeError(`present: no variant run for experiment '${experiment}' (pair=${pair}) — control-only baselines have nothing to compare`, { code: 'NOT_FOUND', hint: 'Propose and run a variant first: `forge propose <exp>` then `forge run <exp> mark-N`.' });
  }
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(variantRun, 'REPORT.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ForgeError(`present: REPORT.json missing under ${variantRun}. Run \`forge report ${experiment}\` first.`, { code: 'NOT_FOUND', hint: `Run \`forge report ${experiment}\` first.` });
    }
    throw e;
  }
  const ctlScore = JSON.parse(await fs.readFile(path.join(controlRun, 'score.json'), 'utf8'));
  const txScore  = JSON.parse(await fs.readFile(path.join(variantRun, 'score.json'), 'utf8'));

  const lines = [];
  lines.push(`# ${experiment} · ${variantName} vs control`);
  lines.push('');

  // ─── Headline ────────────────────────────────────────────────────────────
  lines.push('## Headline');
  lines.push('');
  lines.push(`- Overall: ${fmtDelta(report.headline.overall)} (control ${fmtPct(ctlScore.overallPct)} → variant ${fmtPct(txScore.overallPct)})`);
  for (const t of TIERS) {
    const d = report.headline.tiers[t];
    const c = ctlScore.tiers?.[t]?.pct;
    const v = txScore.tiers?.[t]?.pct;
    lines.push(`- ${t.padEnd(6)}: ${fmtDelta(d)} (${fmtPct(c)} → ${fmtPct(v)})`);
  }
  lines.push('');

  // ─── Learnings ───────────────────────────────────────────────────────────
  const ins = report.insights || {};
  if ((ins.breakthroughs || []).length || (ins.pitfalls || []).length || (ins.suggestions || []).length) {
    lines.push('## Key learnings');
    lines.push('');
    for (const b of (ins.breakthroughs || [])) {
      lines.push(`- 🟢 ${b}`);
    }
    for (const p of (ins.pitfalls || []))      {
      lines.push(`- 🔴 ${p}`);
    }
    for (const s of (ins.suggestions || []))   {
      lines.push(`- 💡 ${s}`);
    }
    lines.push('');
  }

  // ─── Per-sample heatmap (recomputed from score.json sampleMatrix) ────────
  const heatmap = renderHeatmap(ctlScore, txScore);
  if (heatmap) {
    lines.push('## Per-sample heatmap (variant)');
    lines.push('');
    lines.push('```');
    lines.push(heatmap);
    lines.push('```');
    lines.push('');
  }

  // ─── Top criterion contrasts ─────────────────────────────────────────────
  const contrasts = (report.criterionContrasts || [])
    .slice()
    .sort((a, b) => Math.abs((b.delta ?? 0)) - Math.abs((a.delta ?? 0)))
    .slice(0, 5);
  if (contrasts.length) {
    lines.push('## Top criterion movements');
    lines.push('');
    for (const c of contrasts) {
      const arrow = (c.delta ?? 0) >= 0 ? '↑' : '↓';
      lines.push(`- ${arrow} ${fmtDelta(c.delta)}  ${c.tier}/${c.evalId}: ${truncate(c.criterion, 80)}`);
    }
    lines.push('');
  }

  // ─── Outliers ────────────────────────────────────────────────────────────
  const outliers = report.outliers || [];
  if (outliers.length) {
    lines.push('## Eval outliers (>1σ from mean)');
    lines.push('');
    for (const o of outliers.slice(0, 5)) {
      lines.push(`- ${fmtDelta(o.delta)} (z=${o.z.toFixed(2)})  ${o.evalId}`);
    }
    lines.push('');
  }

  // ─── Next-step suggestion ────────────────────────────────────────────────
  lines.push('## Suggested next step');
  lines.push('');
  lines.push(suggestNextStep(report));
  lines.push('');

  return lines.join('\n');
}

function renderHeatmap(ctl, tx) {
  // sampleMatrix[evalId][sampleN] = { overallPct, autoFailed, ... }.
  const txMatrix = tx.sampleMatrix;
  if (!txMatrix) {
    return null;
  }
  const evalIds = Object.keys(txMatrix).sort();
  if (!evalIds.length) {
    return null;
  }
  const sampleCount = Math.max(...evalIds.map(id => Object.keys(txMatrix[id]).length));
  const header = '  eval'.padEnd(28) + ' ' + Array.from({ length: sampleCount }, (_, i) => `s${i + 1}`.padStart(5)).join(' ');
  const rows = [header];
  for (const id of evalIds) {
    const cells = [];
    for (let i = 1; i <= sampleCount; i++) {
      const cell = txMatrix[id][i];
      if (!cell) {
        cells.push('  -- '); continue; 
      }
      if (cell.autoFailed) {
        cells.push('  AF '); continue; 
      }
      const pct = cell.overallPct;
      cells.push(pct == null ? '  -- ' : `${pct.toFixed(0).padStart(4)}%`);
    }
    rows.push('  ' + truncate(id, 26).padEnd(26) + ' ' + cells.join(' '));
  }
  return rows.join('\n');
}

function suggestNextStep(report) {
  const overall = report.headline?.overall ?? 0;
  if (overall >= 5) {
    return `Variant is winning by ${fmtDelta(overall)}. Consider promoting to the next mark and locking the prior baseline in the runbook README changelog.`;
  }
  if (overall <= -5) {
    return `Variant is regressing by ${fmtDelta(overall)}. Inspect the top criterion movements (above) before iterating; the regression is concentrated in those criteria.`;
  }
  return `Variant is roughly flat (${fmtDelta(overall)}). Increase samples (bias-corrected reliability suggests this run is underpowered) or pivot the change before committing more iterations.`;
}

function truncate(s, n) {
  if (!s) {
    return '';
  }
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
