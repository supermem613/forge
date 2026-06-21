// lib/report.js — generate REPORT.md + REPORT.json for a {control, variant} run pair.
//
// Used by `forge report` and runbook report.js shims.
//
// API: runReport({argv, repoRoot, log}) → resolves to {mdPath, jsonPath, summary}.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { aggregate } from './score.js';
import { resolvePair, resolvePrevScore } from './run-pair.js';
import { TIERS } from './judge.js';

function parseArgs(argv) {
  const out = { experiment: null, pair: 'latest', prev: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--experiment') {
      out.experiment = argv[i + 1]; i++; 
    } else if (argv[i] === '--pair') {
      out.pair = argv[i + 1]; i++; 
    } else if (argv[i] === '--prev') {
      out.prev = argv[i + 1]; i++;
      if (out.prev == null || out.prev.startsWith('--')) {
        throw new Error('report: --prev requires a mark argument (e.g. --prev mark-1)');
      }
    }
  }
  return out;
}

function pp(delta) {
  if (delta == null || Number.isNaN(delta)) {
    return 'n/a';
  }
  const sign = delta > 0 ? '+' : (delta < 0 ? '−' : '±');
  return `${sign}${Math.abs(delta).toFixed(1)}pp`;
}

function pct(v) {
  return v == null ? 'n/a' : `${v.toFixed(1)}%`; 
}

// Compact number with thousands separators. Large means round to integer; small
// values keep two decimals so per-solve counts stay legible. Null renders n/a.
function fmtNum(n) {
  if (n == null || Number.isNaN(n)) {
    return 'n/a';
  }
  const abs = Math.abs(n);
  const rounded = (Number.isInteger(n) || abs >= 100) ? Math.round(n) : Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US');
}

function fmtPctSaved(p) {
  return (p == null || Number.isNaN(p)) ? 'n/a' : `${p}%`;
}

// camelCase efficiency-metric key to a human label, e.g. latencyMs -> "latency ms".
function humanizeMetric(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

function deltaOf(tx, ctl) {
  if (tx == null || ctl == null) {
    return null;
  }
  return tx - ctl;
}

// ASCII bar for a percentage 0..100, fixed width=10 cells.
function bar(p, width = 10) {
  if (p == null || Number.isNaN(p)) {
    return '─'.repeat(width);
  }
  const filled = Math.round((Math.max(0, Math.min(100, p)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Heatmap glyph for n/total.
function cellGlyph(passed, total) {
  if (total === 0) {
    return '·';
  }
  if (passed === total) {
    return '█';
  }
  if (passed === 0) {
    return '░';
  }
  const ratio = passed / total;
  if (ratio >= 0.66) {
    return '▓';
  }
  if (ratio >= 0.33) {
    return '▒';
  }
  return '▒';
}

function fmtMs(ms) {
  if (ms == null) {
    return 'n/a';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

// Build per-sample heatmap rows for a given variant score.
function buildHeatmap(variantScore) {
  const lines = [];
  if (!variantScore.evals?.length) {
    return lines;
  }
  const samples = variantScore.samples;
  const repHeaders = Array.from({ length: samples }, (_, i) => `r${i + 1}`).join(' ');
  // Three sub-rows per eval (must/should/could). Width = max(eval id length).
  const evalIdW = Math.max(12, ...variantScore.evals.map(e => e.evalId.length));
  lines.push(`${'eval'.padEnd(evalIdW)}  tier   ${repHeaders}   pass`);
  lines.push(`${'-'.repeat(evalIdW)}  -----  ${'-- '.repeat(samples).trim()}   -----`);
  for (const ev of variantScore.evals) {
    for (const tier of TIERS) {
      const cells = [];
      let totalPass = 0, totalAll = 0;
      for (let r = 1; r <= samples; r++) {
        const row = ev.sampleMatrix.find(m => m.sample === r);
        const t = row?.[tier] || { passed: 0, total: 0 };
        cells.push(cellGlyph(t.passed, t.total));
        totalPass += t.passed; totalAll += t.total;
      }
      const tally = totalAll === 0 ? '·' : `${totalPass}/${totalAll}`;
      const evalCell = tier === 'must' ? ev.evalId.padEnd(evalIdW) : ' '.repeat(evalIdW);
      lines.push(`${evalCell}  ${tier.padEnd(5)}  ${cells.join('  ')}   ${tally}`);
    }
  }
  return lines;
}

// Find criteria where variant vs control diverges most. Returns
// [{ tier, criterion, ctlPct, txPct, delta, evalId }, ...] sorted by |delta|.
function criterionContrasts(ctl, tx) {
  const out = [];
  for (const txEv of tx.evals) {
    const ctlEv = ctl.evals.find(e => e.evalId === txEv.evalId);
    for (const tier of TIERS) {
      for (const c of (txEv.perCriterion?.[tier] || [])) {
        const ctlC = ctlEv?.perCriterion?.[tier]?.find(x => x.criterion === c.criterion);
        const d = deltaOf(c.pct, ctlC?.pct);
        if (d == null) {
          continue;
        }
        out.push({
          evalId: txEv.evalId, tier,
          criterion: c.criterion,
          ctlPct: ctlC?.pct ?? null,
          txPct: c.pct,
          delta: d,
        });
      }
    }
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// Auto-derive insights (pitfalls + breakthroughs) from reliability,
// signals, criterion contrasts, and tier deltas.
function deriveInsights({ ctl, tx, evalDeltas: _evalDeltas, contrasts, tierDeltas, overallDelta }) {
  const breakthroughs = [];
  const pitfalls = [];
  const suggestions = [];

  const txR = tx.reliability, ctlR = ctl.reliability;
  const txEligibleReps = tx.eligibleSamples ?? 0;
  const txTotalReps = tx.totalSamplesAcrossEvals ?? (tx.samples * (tx.evals?.length || 0));
  const ctlEligibleReps = ctl.eligibleSamples ?? 0;

  // --- Trust qualifier: this is the most important block ---
  if (txEligibleReps === 0) {
    pitfalls.push(`**No variant sample cleared the gate.** None of the quality criteria can be meaningfully evaluated until the runbook's deterministic gate succeeds.`);
    suggestions.push('Before drawing conclusions, fix the runbook gate or variant setup and re-run.');
  } else if (txEligibleReps / txTotalReps < 0.5) {
    pitfalls.push(`Only **${txEligibleReps}/${txTotalReps}** variant samples cleared the gate. All quality conclusions below are conditioned on those eligible samples and should be treated as preliminary until gate-pass rate is at least 80%.`);
    suggestions.push('Priority: lift gate-pass rate first before optimizing quality metrics.');
  }

  // --- Breakthroughs (only when there's enough eligible data to claim one) ---
  if (txEligibleReps >= 2) {
    for (const tier of TIERS) {
      const d = tierDeltas[tier];
      if (d != null && d >= 20) {
        breakthroughs.push(`**${tier.toUpperCase()} +${d.toFixed(1)}pp** (conditional on ${txEligibleReps} eligible sample${txEligibleReps === 1 ? '' : 's'}) — variant lifts the ${tier}-tier substantially over control.`);
      }
    }
    for (const c of contrasts.filter(c => c.delta >= 50).slice(0, 4)) {
      breakthroughs.push(`Criterion moved **+${c.delta.toFixed(0)}pp** (\`${c.evalId}\` · ${c.tier}, conditional): _${c.criterion}_`);
    }
  }
  // Reliability breakthroughs (these are about the gate itself, always meaningful).
  if (ctlR && txR && (ctlR.gateValidPct ?? 0) === 0 && (txR.gateValidPct ?? 0) > 0) {
    breakthroughs.push(`Treatment unblocked the runbook gate (${txR.gateValid}/${txR.totalSamples} samples; control 0/${ctlR.totalSamples}).`);
  }
  if (ctlR && txR && (ctlR.variantCapabilityLoadedPct ?? 0) < 50 && (txR.variantCapabilityLoadedPct ?? 0) >= 80) {
    breakthroughs.push(`Variant activation reliability jumped to ${txR.variantCapabilityLoadedPct.toFixed(0)}% (control ${ctlR.variantCapabilityLoadedPct == null ? 'n/a' : ctlR.variantCapabilityLoadedPct.toFixed(0) + '%'}).`);
  }

  // --- Pitfalls ---
  if (txR && txR.gateValidPct != null && txR.gateValidPct < 80 && txR.totalSamples >= 3) {
    pitfalls.push(`The runbook gate completed on only **${txR.gateValid}/${txR.totalSamples}** variant samples (${txR.gateValidPct.toFixed(0)}%). The other samples cannot be judged on quality.`);
  }
  if (txR && txR.loadButNoCreate > 0) {
    pitfalls.push(`On **${txR.loadButNoCreate}** variant sample(s), the first gate action completed but the follow-up action did not.`);
    suggestions.push('Make the variant instructions more directive about the required follow-up action.');
  }
  if (txR && txR.createSkillOOB > 0) {
    pitfalls.push(`On **${txR.createSkillOOB}** variant sample(s), the follow-up action happened without the expected first gate action. These samples do not measure the variant.`);
    suggestions.push('Tighten variant routing or setup so the intended variant path is selected before follow-up actions run.');
  }
  if (txR && txR.variantCapabilityLoaded < txR.totalSamples && (txR.variantCapabilityLoadedPct ?? 0) < 100) {
    pitfalls.push(`The variant activated on only **${txR.variantCapabilityLoaded}/${txR.totalSamples}** samples.`);
    suggestions.push('Tighten variant selection signals so the variant activates deterministically on eval prompts.');
  }
  // Recurring failing criteria in variant — but only when evaluable.
  if (txEligibleReps >= 2) {
    const txFails = contrasts
      .filter(c => c.txPct === 0 && c.tier !== 'could')
      .slice(0, 5);
    for (const c of txFails) {
      pitfalls.push(`Criterion failing **0/${txEligibleReps}** eligible samples in variant (\`${c.evalId}\` · ${c.tier}): _${c.criterion}_`);
    }
  }
  // Regressions vs control.
  if (txEligibleReps >= 2) {
    const regressions = contrasts.filter(c => c.delta <= -33).slice(0, 3);
    for (const c of regressions) {
      pitfalls.push(`Regression vs control (**${c.delta.toFixed(0)}pp**, \`${c.evalId}\` · ${c.tier}): _${c.criterion}_`);
    }
  }
  // Signals.
  const sigCounts = tx.signals?.counts || {};
  for (const [kind, n] of Object.entries(sigCounts)) {
    if (kind === 'capability-not-loaded') {
      pitfalls.push(`Treatment capability failed to load on **${n}** sample(s).`);
      suggestions.push('Recheck variant routing so the expected capability loads on the eval prompts.');
    } else if (kind === 'bloat-warning' || kind === 'bloat-block') {
      pitfalls.push(`Generated artifact exceeded the configured byte budget on **${n}** sample(s).`);
      suggestions.push('Trim the generated artifact or split supporting detail into referenced files.');
    } else {
      pitfalls.push(`\`${kind}\` warning fired on **${n}** variant sample(s).`);
    }
  }

  // Per-sample variance pattern: gate fires on exactly k of N samples for every eval.
  const txEvals = tx.evals || [];
  if (txEvals.length >= 2 && tx.samples >= 2) {
    const gateHits = txEvals.map(ev => (ev.sampleMatrix || []).filter(m => m.gatePassed).length);
    const allEqual = gateHits.every(k => k === gateHits[0]);
    const k = gateHits[0];
    if (allEqual && k > 0 && k < tx.samples) {
      pitfalls.push(`Each eval cleared the gate on exactly **${k}/${tx.samples}** variant samples, which points to cross-suite flakiness rather than eval-specific failure.`);
      suggestions.push('Reduce run-to-run ambiguity in the variant before judging quality changes.');
    }
  }

  // --- Suggestions (general next-variant guidance) ---
  if (txEligibleReps >= 2 && overallDelta != null && overallDelta > 0 && overallDelta < 30) {
    suggestions.push(`Real but small win (+${overallDelta.toFixed(1)}pp on eligible samples). Iterate on the same hypothesis; don't pivot.`);
  }
  if (txEligibleReps >= 2 && overallDelta != null && overallDelta < 0) {
    suggestions.push(`Net regression on eligible samples — back out the changes that diverge from the prior best variant and re-bisect.`);
  }
  if (tx.samples < 5) {
    suggestions.push(`Re-run with at least 5 samples before promoting this variant — pp deltas at samples=${tx.samples} are noisy.`);
  }
  // Bytes signal.
  if (txR?.skillBody?.meanBytes != null) {
    const b = txR.skillBody.meanBytes;
    if (b > 8192) {
      suggestions.push(`Generated artifact averages ${b}B (> 8KB); consider splitting details into referenced files.`);
    } else if (b < 400) {
      suggestions.push(`Generated artifact averages only ${b}B; it may be too thin to be useful.`);
    }
  }

  return { breakthroughs, pitfalls, suggestions, txEligibleReps, txTotalReps, ctlEligibleReps };
}

export async function runReport({ argv, repoRoot, log } = {}) {
  const onLog = log || ((m) => process.stderr.write(`[report] ${m}\n`));
  const REPO_ROOT = repoRoot;
  const { experiment, pair, prev: prevOverride } = parseArgs(argv || []);
  if (!experiment) {
    throw new Error('report: --experiment <name> required');
  }
  const expDir = path.join(REPO_ROOT, 'experiments', experiment);
  const { controlRun, variantRun, variantName } = await resolvePair(expDir, pair);

  const ctl = JSON.parse(await fs.readFile(path.join(controlRun, 'score.json'), 'utf8'));
  const tx = JSON.parse(await fs.readFile(path.join(variantRun, 'score.json'), 'utf8'));

  // Previous mark, when one exists, for the iteration-over-iteration trend. Read
  // its already-written score.json rather than re-scoring so an old run with no
  // surviving capture stream still contributes. A missing or unscored prior mark
  // simply drops the trend section. --prev pins an explicit baseline mark instead
  // of the immediately-preceding one, and a pinned-but-unscored baseline fails loudly.
  const { prevVariantRun, prevVariantName, prevScore } = await resolvePrevScore(expDir, variantName, prevOverride);
  const prev = prevScore;

  // Canonical efficiency metrics computed by the runbook score step. Read whatever
  // metric keys it emitted rather than recomputing savings math here. An old run
  // that predates pair.json simply omits the efficiency tables.
  let pairData;
  try {
    pairData = JSON.parse(await fs.readFile(path.join(variantRun, 'pair.json'), 'utf8'));
  } catch {
    pairData = null;
  }

  // Per-eval deltas.
  const evalDeltas = [];
  for (const txEv of tx.evals) {
    const ctlEv = ctl.evals.find(e => e.evalId === txEv.evalId);
    const tiers = {};
    for (const tier of TIERS) {
      tiers[tier] = deltaOf(txEv.tiers[tier]?.pct, ctlEv?.tiers[tier]?.pct);
    }
    const overall = deltaOf(txEv.overallPct, ctlEv?.overallPct);
    evalDeltas.push({
      evalId: txEv.evalId,
      controlOverall: ctlEv?.overallPct ?? null,
      treatmentOverall: txEv.overallPct ?? null,
      tiers, overall,
      autoFailedSamples: txEv.autoFailedSamples,
      missingSamples: txEv.missingSamples,
    });
  }

  // Tier-level deltas.
  const tierDeltas = {};
  for (const tier of TIERS) {
    tierDeltas[tier] = deltaOf(tx.tiers[tier]?.pct, ctl.tiers[tier]?.pct);
  }
  const overallDelta = deltaOf(tx.overallPct, ctl.overallPct);

  // Variant vs previous mark trend (current − previous). Null throughout when
  // there is no scored previous mark.
  let prevTrend = null;
  if (prev) {
    const prevTierDeltas = {};
    for (const tier of TIERS) {
      prevTierDeltas[tier] = deltaOf(tx.tiers[tier]?.pct, prev.tiers[tier]?.pct);
    }
    const prevPerEval = [];
    for (const txEv of tx.evals) {
      const prevEv = (prev.evals || []).find(e => e.evalId === txEv.evalId);
      prevPerEval.push({
        evalId: txEv.evalId,
        prevOverall: prevEv?.overallPct ?? null,
        variantOverall: txEv.overallPct ?? null,
        overall: deltaOf(txEv.overallPct, prevEv?.overallPct),
      });
    }
    prevTrend = {
      variantName: prevVariantName,
      variantRun: prevVariantRun,
      overall: deltaOf(tx.overallPct, prev.overallPct),
      prevOverallPct: prev.overallPct ?? null,
      tiers: prevTierDeltas,
      perEval: prevPerEval,
    };
  }

  // Distribution stats over per-eval overall deltas.
  const overallSeries = evalDeltas.map(e => e.overall).filter(d => d != null);
  const stats = aggregate(overallSeries);
  // Flag outliers > 1σ (concentrated regressions/improvements).
  const sigma = stats.stddev || 0;
  const mean = stats.mean || 0;
  const outliers = evalDeltas
    .filter(e => e.overall != null && Math.abs(e.overall - mean) > sigma && sigma > 0)
    .map(e => ({ evalId: e.evalId, delta: e.overall, z: sigma > 0 ? (e.overall - mean) / sigma : 0 }));

  // Criterion-level contrasts (variant − control).
  const contrasts = criterionContrasts(ctl, tx);
  const insights = deriveInsights({ ctl, tx, evalDeltas, contrasts, tierDeltas, overallDelta });

  // Efficiency three-way is only internally consistent when the pinned prev mark
  // matches the one the score step baked into pair.json. Otherwise fall back to
  // the two-way efficiency table so the report never shows mismatched baselines.
  const effPrevMatches = !!(prevTrend && pairData?.threeWay?.efficiency
    && pairData.threeWay.prevVariant === prevTrend.variantName);
  const effThreeWay = effPrevMatches ? pairData.threeWay.efficiency : null;

  const reportJson = {
    experiment, variant: variantName,
    controlRun, variantRun,
    prevVariant: prevVariantName,
    prevVariantRun: prevVariantRun || null,
    headline: { overall: overallDelta, tiers: tierDeltas, vsPrev: prevTrend ? { overall: prevTrend.overall, tiers: prevTrend.tiers } : null },
    perEval: evalDeltas,
    prevTrend,
    efficiency: pairData?.efficiency || null,
    efficiencyThreeWay: effThreeWay,
    captureHealth: pairData?.captureHealth || null,
    codeMode: pairData?.codeMode || null,
    distribution: { ...stats, sigma, mean },
    outliers,
    criterionContrasts: contrasts,
    insights,
    reliability: { control: ctl.reliability, variant: tx.reliability },
    signals: { control: ctl.signals, variant: tx.signals },
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(variantRun, 'REPORT.json'), JSON.stringify(reportJson, null, 2) + '\n');

  // Markdown.
  const lines = [];
  lines.push(`# REPORT — ${experiment} · ${variantName} vs control`);
  lines.push('');
  // ─── Trust gate ─────────────────────────────────────────────────────────
  const txEligible = tx.eligibleSamples ?? 0;
  const txTotal = tx.totalSamplesAcrossEvals ?? (tx.samples * (tx.evals?.length || 0));
  const ctlEligible = ctl.eligibleSamples ?? 0;
  const ctlTotal = ctl.totalSamplesAcrossEvals ?? (ctl.samples * (ctl.evals?.length || 0));
  const txGatePct = txTotal > 0 ? (txEligible / txTotal) * 100 : null;
  const ctlGatePct = ctlTotal > 0 ? (ctlEligible / ctlTotal) * 100 : null;

  let trustBanner;
  if (txEligible === 0) {
    trustBanner = `> ⚠️ **Variant never cleared the gate.** No sample met the runbook's deterministic eligibility gate across ${txTotal} variant samples. **No quality conclusions can be drawn from this run.**`;
  } else if (txGatePct < 50) {
    trustBanner = `> ⚠️ **Low gate pass-rate (${txEligible}/${txTotal} = ${txGatePct.toFixed(0)}%).** Quality percentages below are conditional on the ${txEligible} eligible sample${txEligible === 1 ? '' : 's'}. Treat as **preliminary** until gate-pass rate is at least 80%.`;
  } else if (txGatePct < 80) {
    trustBanner = `> ℹ️ **Partial gate coverage (${txEligible}/${txTotal} = ${txGatePct.toFixed(0)}%).** Quality percentages are conditional on eligible samples.`;
  } else {
    trustBanner = `> ✅ **Gate cleared on ${txEligible}/${txTotal} variant samples (${txGatePct.toFixed(0)}%).** Quality percentages below are well-grounded.`;
  }
  lines.push(trustBanner);
  lines.push('');
  lines.push(`**Headline: Overall ${pp(overallDelta)}** (conditional on eligible samples)`);
  lines.push('');
  lines.push(`- **Gate:**  control ${ctlEligible}/${ctlTotal} (${pct(ctlGatePct)}) → variant ${txEligible}/${txTotal} (${pct(txGatePct)})`);
  lines.push(`- must:   ${pp(tierDeltas.must)}   (control ${pct(ctl.tiers.must?.pct)} → variant ${pct(tx.tiers.must?.pct)})`);
  lines.push(`- should: ${pp(tierDeltas.should)}   (control ${pct(ctl.tiers.should?.pct)} → variant ${pct(tx.tiers.should?.pct)})`);
  lines.push(`- could:   ${pp(tierDeltas.could)}   (control ${pct(ctl.tiers.could?.pct)} → variant ${pct(tx.tiers.could?.pct)})`);
  lines.push('');
  lines.push(`Overall control: **${pct(ctl.overallPct)}** · variant: **${pct(tx.overallPct)}**  _(non-gate criteria counted only over samples where the gate passed)_`);
  lines.push('');

  // ─── Three-way quality trend (control · previous mark · current variant) ──
  lines.push(`## Trend vs previous mark${prevTrend ? ` (${prevTrend.variantName})` : ''}`);
  lines.push('');
  if (!prevTrend) {
    lines.push(`_No earlier mark to compare against — ${variantName} is the first variant in this experiment._`);
    lines.push('');
  } else {
    lines.push(`Quality pass-rate across all three points. **Δ vs prev** is current ${variantName} minus previous ${prevTrend.variantName}.`);
    lines.push('');
    lines.push(`| tier | control | ${prevTrend.variantName} | ${variantName} | Δ vs prev |`);
    lines.push('|------|--------:|--------:|--------:|----------:|');
    const trow = (label, ctlPct, prevPct, txPct, d) =>
      lines.push(`| ${label} | ${pct(ctlPct)} | ${pct(prevPct)} | ${pct(txPct)} | ${pp(d)} |`);
    for (const tier of TIERS) {
      trow(tier, ctl.tiers[tier]?.pct, prev.tiers[tier]?.pct, tx.tiers[tier]?.pct, prevTrend.tiers[tier]);
    }
    trow('**overall**', ctl.overallPct, prev.overallPct, tx.overallPct, prevTrend.overall);
    lines.push('');
    lines.push(`- previous: \`${path.relative(REPO_ROOT, prevTrend.variantRun).replace(/\\/g, '/')}\``);
    lines.push('');
    const movedEvals = prevTrend.perEval.filter(e => e.overall != null && Math.abs(e.overall) >= 1);
    if (movedEvals.length) {
      lines.push(`Per-eval overall vs ${prevTrend.variantName}:`);
      lines.push('');
      lines.push(`| eval | ${prevTrend.variantName} | ${variantName} | Δ |`);
      lines.push('|------|--------:|--------:|--:|');
      for (const e of movedEvals.sort((a, b) => Math.abs(b.overall) - Math.abs(a.overall))) {
        lines.push(`| \`${e.evalId}\` | ${pct(e.prevOverall)} | ${pct(e.variantOverall)} | ${pp(e.overall)} |`);
      }
      lines.push('');
    }
  }

  // ─── Efficiency — all metrics (control · previous · current) ──────────────
  if (pairData?.efficiency) {
    lines.push(`## Efficiency — all metrics${effThreeWay ? ` (control · ${prevTrend.variantName} · ${variantName})` : ` (control · ${variantName})`}`);
    lines.push('');
    if (effThreeWay) {
      lines.push(`Every model-context metric across all three points. **Δ vs prev** and **% saved vs prev** compare current ${variantName} against previous ${prevTrend.variantName}.`);
      lines.push('');
      lines.push(`| metric | control | ${prevTrend.variantName} | ${variantName} | Δ vs prev | % saved vs prev |`);
      lines.push('|--------|--------:|--------:|--------:|---------:|---------------:|');
      for (const [key, m] of Object.entries(effThreeWay)) {
        lines.push(`| ${humanizeMetric(key)} | ${fmtNum(m.control)} | ${fmtNum(m.previous)} | ${fmtNum(m.variant)} | ${fmtNum(m.deltaVsPrev)} | ${fmtPctSaved(m.pctSavedVsPrev)} |`);
      }
    } else {
      lines.push(`Every model-context metric, variant vs control. **% saved** is positive when the variant uses fewer tokens or less time.`);
      lines.push('');
      lines.push(`| metric | control | ${variantName} | Δ | % saved |`);
      lines.push('|--------|--------:|--------:|--:|--------:|');
      for (const [key, m] of Object.entries(pairData.efficiency)) {
        lines.push(`| ${humanizeMetric(key)} | ${fmtNum(m.control)} | ${fmtNum(m.variant)} | ${fmtNum(m.delta)} | ${fmtPctSaved(m.pctSaved)} |`);
      }
    }
    lines.push('');
    if (pairData.codeMode) {
      const cm = pairData.codeMode;
      lines.push(`Code mode engaged: control ${pct(cm.control?.pct)} (${cm.control?.engaged}/${cm.control?.total}) · ${variantName} ${pct(cm.variant?.pct)} (${cm.variant?.engaged}/${cm.variant?.total}).`);
      lines.push('');
    }
  }

  // ─── Reasoning capture health ─────────────────────────────────────────────
  // Capture completeness, not a cost saving, so it never routes through the
  // efficiency savings table. zero-seg multi-call is the honest drop detector:
  // gate-valid samples that made 2+ model calls yet captured no reasoning.
  if (pairData?.captureHealth) {
    const ch = pairData.captureHealth;
    const fmtCh = (c) => (!c || c.n === 0)
      ? 'n/a'
      : `${fmtNum(c.meanSegsPerCall)} segs/call · ${c.zeroSegMultiCall} zero-seg multi-call / ${c.n}`;
    lines.push('## Reasoning capture health');
    lines.push('');
    lines.push('Segments captured per model call (higher is more complete). **zero-seg multi-call** counts gate-valid samples with 2+ model calls but no captured reasoning — the capture-drop detector.');
    lines.push('');
    lines.push(`| point | capture |`);
    lines.push(`|-------|---------|`);
    lines.push(`| control | ${fmtCh(ch.control)} |`);
    if (ch.previous) {
      lines.push(`| ${prevTrend?.variantName ?? 'previous'} | ${fmtCh(ch.previous)} |`);
    }
    lines.push(`| ${variantName} | ${fmtCh(ch.variant)} |`);
    lines.push('');
  }

  // ─── Insights ───────────────────────────────────────────────────────────
  lines.push('## Key learnings');
  lines.push('');
  if (insights.breakthroughs.length === 0 && insights.pitfalls.length === 0) {
    lines.push('_No notable signals derived; samples may be too thin or variants too similar._');
    lines.push('');
  }
  if (insights.breakthroughs.length) {
    lines.push('### 🟢 Breakthroughs');
    lines.push('');
    for (const b of insights.breakthroughs) {
      lines.push(`- ${b}`);
    }
    lines.push('');
  }
  if (insights.pitfalls.length) {
    lines.push('### 🔴 Pitfalls');
    lines.push('');
    for (const p of insights.pitfalls) {
      lines.push(`- ${p}`);
    }
    lines.push('');
  }
  if (insights.suggestions.length) {
    lines.push('### 🧭 Suggested next variant');
    lines.push('');
    for (const s of insights.suggestions) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  // ─── Reliability dashboard ──────────────────────────────────────────────
  lines.push('## Reliability dashboard');
  lines.push('');
  lines.push('```');
  const ctlR = ctl.reliability, txR = tx.reliability;
  const drow = (label, ctlVal, ctlPct, txVal, txPct) => {
    const ctlStr = ctlVal == null ? '   n/a' : `${String(ctlVal).padStart(2)}/${String(ctlR?.totalSamples ?? '?').padStart(2)}`;
    const txStr  = txVal == null  ? '   n/a' : `${String(txVal).padStart(2)}/${String(txR?.totalSamples ?? '?').padStart(2)}`;
    const ctlBar = ctlPct == null ? bar(0) : bar(ctlPct);
    const txBar = txPct == null ? bar(0) : bar(txPct);
    return `${label.padEnd(28)}  control ${ctlStr} ${ctlBar} ${pct(ctlPct).padStart(6)}   variant ${txStr} ${txBar} ${pct(txPct).padStart(6)}`;
  };
  if (ctlR && txR) {
    // Reliability schemas vary by runbook. The two-stage authoring runbooks
    // expose stage1/stage2/skillMaterialized; single-turn scenario runbooks
    // expose a flat ok/codeModeEngaged/tokensMatched shape. Render only the
    // rows whose underlying field is present so any runbook's reliability
    // object renders without dereferencing a field it never wrote.
    const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
    const derivePct = (val, total) => (val != null && total ? (val / total) * 100 : null);
    const rowSpecs = [
      ['Stage 1 OK', 'stage1.ok', 'stage1.okPct'],
      ['Variant activated', 'variantCapabilityLoaded', 'variantCapabilityLoadedPct'],
      ['Gate valid', 'gateValid', 'gateValidPct'],
      ['Artifact materialized', 'skillMaterialized', 'skillMaterializedPct'],
      ['Stage 2 attempted', 'stage2.attempted', 'stage2.attemptedPct'],
      ['Stage 2 OK', 'stage2.ok', 'stage2.okPct'],
      ['Run OK', 'ok', null],
      ['Code mode engaged', 'codeModeEngaged', 'codeModeEngagedPct'],
      ['Tokens matched', 'tokensMatched', 'tokensMatchedPct'],
    ];
    let anyRow = false;
    for (const [label, valPath, pctPath] of rowSpecs) {
      const cv = get(ctlR, valPath), tv = get(txR, valPath);
      if (cv == null && tv == null) {
        continue;
      }
      anyRow = true;
      const cp = pctPath ? get(ctlR, pctPath) : derivePct(cv, ctlR.totalSamples);
      const tp = pctPath ? get(txR, pctPath) : derivePct(tv, txR.totalSamples);
      lines.push(drow(label, cv, cp, tv, tp));
    }
    if (!anyRow) {
      lines.push('(no comparable reliability rows)');
    }
    lines.push('');
    if (get(ctlR, 'stage1.meanMs') != null || get(txR, 'stage1.meanMs') != null) {
      lines.push(`Mean Stage 1 latency:   control ${fmtMs(get(ctlR, 'stage1.meanMs'))}   variant ${fmtMs(get(txR, 'stage1.meanMs'))}`);
      lines.push(`Mean Stage 2 latency:   control ${fmtMs(get(ctlR, 'stage2.meanMs'))}   variant ${fmtMs(get(txR, 'stage2.meanMs'))}`);
    }
    if (ctlR.meanLatencyMs != null || txR.meanLatencyMs != null) {
      lines.push(`Mean scenario latency:  control ${fmtMs(ctlR.meanLatencyMs)}   variant ${fmtMs(txR.meanLatencyMs)}`);
    }
    if (txR?.skillBody?.meanBytes != null) {
      lines.push(`Mean artifact body:     variant ${txR.skillBody.meanBytes}B (n=${txR.skillBody.n})`);
    }
  } else {
    lines.push('(no reliability data)');
  }
  lines.push('```');
  lines.push('');

  // ─── Per-sample tool invocation order ──────────────────────────────────────
  lines.push('## Tool invocation order per sample (variant Stage 1)');
  lines.push('');
  lines.push('Gate validity is defined by the runbook score step.');
  lines.push('');
  lines.push('| eval | sample | gate | tools (in order) | reason |');
  lines.push('|------|----:|:----:|------------------|--------|');
  for (const ev of (tx.evals || [])) {
    const diag = ev.gateDiagBySample || {};
    for (let r = 1; r <= (tx.samples || 0); r++) {
      const d = diag[r];
      const tools = (d?.tools && d.tools.length > 0) ? d.tools.join(' → ') : '_(no tools)_';
      const gateGlyph = d?.gateValid ? '✅' : '❌';
      const reason = d?.gateValid ? '—' : (d?.reason || 'unknown');
      lines.push(`| \`${ev.evalId}\` | ${r} | ${gateGlyph} | ${tools} | ${reason} |`);
    }
  }
  lines.push('');
  lines.push('## Tool invocation order per sample (control Stage 1)');
  lines.push('');
  lines.push('| eval | sample | gate | tools (in order) | reason |');
  lines.push('|------|----:|:----:|------------------|--------|');
  for (const ev of (ctl.evals || [])) {
    const diag = ev.gateDiagBySample || {};
    for (let r = 1; r <= (ctl.samples || 0); r++) {
      const d = diag[r];
      const tools = (d?.tools && d.tools.length > 0) ? d.tools.join(' → ') : '_(no tools)_';
      const gateGlyph = d?.gateValid ? '✅' : '❌';
      const reason = d?.gateValid ? '—' : (d?.reason || 'unknown');
      lines.push(`| \`${ev.evalId}\` | ${r} | ${gateGlyph} | ${tools} | ${reason} |`);
    }
  }
  lines.push('');

  // ─── Per-sample heatmap ────────────────────────────────────────────────────
  lines.push('## Per-sample heatmap (variant)');
  lines.push('');
  lines.push('Glyphs: `█` all pass · `▓` ≥66% · `▒` partial · `░` all fail · `·` empty');
  lines.push('');
  lines.push('```');
  for (const ln of buildHeatmap(tx)) {
    lines.push(ln);
  }
  lines.push('```');
  lines.push('');
  lines.push('## Per-sample heatmap (control)');
  lines.push('');
  lines.push('```');
  for (const ln of buildHeatmap(ctl)) {
    lines.push(ln);
  }
  lines.push('```');
  lines.push('');

  // ─── Per-eval deltas ────────────────────────────────────────────────────
  lines.push('## Per-eval deltas');
  lines.push('');
  lines.push('| Eval | Must Δ | Should Δ | Could Δ | Overall Δ | Notes |');
  lines.push('|------|-------:|---------:|-------:|----------:|-------|');
  for (const e of evalDeltas) {
    const notes = [];
    if (e.autoFailedSamples) {
      notes.push(`auto-failed ${e.autoFailedSamples}/${tx.samples}`);
    }
    if (e.missingSamples) {
      notes.push(`missing ${e.missingSamples}/${tx.samples}`);
    }
    if (outliers.find(o => o.evalId === e.evalId)) {
      notes.push(`outlier (>1σ)`);
    }
    lines.push(`| \`${e.evalId}\` | ${pp(e.tiers.must)} | ${pp(e.tiers.should)} | ${pp(e.tiers.could)} | **${pp(e.overall)}** | ${notes.join('; ') || '—'} |`);
  }
  lines.push('');

  // ─── Top criterion contrasts ────────────────────────────────────────────
  lines.push('## Criterion contrasts (|Δ| ≥ 1pp)');
  lines.push('');
  const movers = contrasts.filter(c => Math.abs(c.delta) >= 1);
  if (movers.length === 0) {
    lines.push('_No criterion-level movement._');
  } else {
    lines.push('| Δ | tier | eval | criterion | ctl → tx |');
    lines.push('|--:|:----:|------|-----------|---------:|');
    for (const c of movers) {
      const arrow = c.delta > 0 ? '🟢' : '🔴';
      lines.push(`| ${arrow} **${pp(c.delta)}** | ${c.tier} | \`${c.evalId}\` | ${c.criterion} | ${pct(c.ctlPct)} → ${pct(c.txPct)} |`);
    }
  }
  lines.push('');

  // ─── Distribution ───────────────────────────────────────────────────────
  lines.push('## Distribution (per-eval overall deltas)');
  lines.push('');
  if (stats.n > 0) {
    lines.push(`- n=${stats.n}, mean=${stats.mean?.toFixed(2) ?? 'n/a'}pp, stdev=${stats.stddev?.toFixed(2) ?? 'n/a'}pp`);
    lines.push(`- min=${stats.min?.toFixed(2)}pp, p50=${stats.p50?.toFixed(2)}pp, max=${stats.max?.toFixed(2)}pp`);
    if (outliers.length) {
      lines.push('');
      lines.push(`**Outliers (>1σ from mean):**`);
      for (const o of outliers) {
        const tag = o.delta < 0 ? 'concentrated regression' : 'concentrated improvement';
        lines.push(`- \`${o.evalId}\`: ${pp(o.delta)} (z=${o.z.toFixed(2)}) — ${tag}`);
      }
    }
  } else {
    lines.push('No paired evals to summarize.');
  }
  lines.push('');

  // ─── Signals ────────────────────────────────────────────────────────────
  const sigCounts = tx.signals?.counts || {};
  if (Object.keys(sigCounts).length > 0) {
    lines.push('## Signals (variant)');
    lines.push('');
    for (const [kind, n] of Object.entries(sigCounts)) {
      lines.push(`- \`${kind}\` × ${n}`);
    }
    lines.push('');
  }

  // ─── Run pair / caveats ────────────────────────────────────────────────
  lines.push('## Run pair');
  lines.push('');
  lines.push(`- control:   \`${path.relative(REPO_ROOT, controlRun).replace(/\\/g, '/')}\``);
  lines.push(`- variant: \`${path.relative(REPO_ROOT, variantRun).replace(/\\/g, '/')}\``);
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  const caveats = [];
  const txAutoFails = tx.evals.reduce((n, e) => n + e.autoFailedSamples, 0);
  const txMissing = tx.evals.reduce((n, e) => n + e.missingSamples, 0);
  if (txAutoFails) {
    caveats.push(`${txAutoFails} variant sample(s) auto-failed because a required capability was not loaded. All criteria for those samples counted as FAIL.`);
  }
  if (txMissing) {
    caveats.push(`${txMissing} variant sample(s) had missing/invalid judge verdicts → counted as FAIL.`);
  }
  if (tx.samples < 5) {
    caveats.push(`Thin samples (${tx.samples} per eval) — pp deltas are noisy.`);
  }
  if (caveats.length === 0) {
    caveats.push('None flagged.');
  }
  for (const c of caveats) {
    lines.push(`- ${c}`);
  }
  lines.push('');

  const mdPath = path.join(variantRun, 'REPORT.md');
  await fs.writeFile(mdPath, lines.join('\n'));
  onLog(`wrote ${mdPath}`);
  onLog(`${variantName} vs control: Overall ${pp(overallDelta)} (must ${pp(tierDeltas.must)} · should ${pp(tierDeltas.should)} · could ${pp(tierDeltas.could)})`);
  if (prevTrend) {
    onLog(`${variantName} vs ${prevTrend.variantName}: Overall ${pp(prevTrend.overall)} (prev ${pct(prevTrend.prevOverallPct)} → ${pct(tx.overallPct)})`);
  }
  if (insights.breakthroughs.length) {
    onLog(`breakthroughs: ${insights.breakthroughs.length}`);
    for (const b of insights.breakthroughs.slice(0, 3)) {
      onLog(`  🟢 ${b.replace(/[*_`]/g, '')}`);
    }
  }
  if (insights.pitfalls.length) {
    onLog(`pitfalls: ${insights.pitfalls.length}`);
    for (const p of insights.pitfalls.slice(0, 3)) {
      onLog(`  🔴 ${p.replace(/[*_`]/g, '')}`);
    }
  }
  if (insights.suggestions.length) {
    onLog(`suggestions: ${insights.suggestions.length}`);
    for (const s of insights.suggestions.slice(0, 3)) {
      onLog(`  🧭 ${s.replace(/[*_`]/g, '')}`);
    }
  }
  return { mdPath, jsonPath: path.join(variantRun, 'REPORT.json'), variantName, overallDelta };
}
