// lib/judge-orchestrator.js — judge orchestrator entry point.
//
// runJudge({argv, runbookDir, repoRoot, log}) drives the two-phase
// agent-as-judge flow per runbook:
//   --mode agent   → write judge-prompts/<eval>-sample<N>.md (auto-fail
//                    blocked samples up front).
//   --mode collect → validate verdicts and emit judge-status.{json,md}.
//
// Reads <runbookDir>/manifest.json for the eval list, resolves the run
// pair via lib/run-pair, and uses lib/judge primitives for prompt + verdict
// IO. Pure orchestration — all side effects routed through `log`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildCriteriaPrompt, writePromptForRep, expectedVerdictPath,
  readVerdictForRep, failAllCriteriaVerdict, verdictDirRel,
  REQUIRED_JUDGE_MODEL,
} from './judge.js';
import { resolvePair } from './run-pair.js';
import { normalizeEval } from './eval-loader.js';
import { buildDispatchPrompt, validateVerdictDir, summarizeValidation } from './judge-dispatch.js';

function parseArgs(argv) {
  const out = { experiment: null, pair: 'latest', mode: 'agent', variant: null, refitStale: false, dispatchPrompt: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--experiment') {
      out.experiment = argv[i + 1]; i++; 
    } else if (argv[i] === '--pair') {
      out.pair = argv[i + 1]; i++; 
    } else if (argv[i] === '--mode') {
      out.mode = argv[i + 1]; i++; 
    } else if (argv[i] === '--variant') {
      out.variant = argv[i + 1]; i++; 
    } else if (argv[i] === '--refit-stale') {
      out.refitStale = true; 
    } else if (argv[i] === '--dispatch-prompt') {
      out.dispatchPrompt = true; 
    }
  }
  return out;
}

async function loadEvals(runbookDir) {
  const m = JSON.parse(await fs.readFile(path.join(runbookDir, 'manifest.json'), 'utf8'));
  const evals = [];
  for (const rel of m.evals) {
    const raw = JSON.parse(await fs.readFile(path.join(runbookDir, rel), 'utf8'));
    evals.push(normalizeEval(raw));
  }
  return { manifest: m, evals };
}

async function loadTurn(runDir, evalId, sample, turnIdx) {
  const p = path.join(runDir, `turn${turnIdx}`, `${evalId}-sample${sample}.json`);
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')); 
  } catch {
    return null; 
  }
}

function renderToolCalls(lines, response) {
  const td = response?.toolDetails || [];
  if (td.length === 0) {
    lines.push('Tools called (in order): (none)');
    return;
  }
  lines.push(`Tools called (in order, ${td.length} total):`);
  for (let i = 0; i < td.length; i++) {
    const t = td[i];
    const inp = JSON.stringify(t?.input ?? {});
    const inpShort = inp.length > 200 ? inp.slice(0, 200) + '…' : inp;
    lines.push(`  ${i + 1}. ${t?.toolName || '(unknown)'}  input=${inpShort}`);
  }
}

function buildArtifact(sample, turn1, turn2, loadedSkills) {
  const lines = [`# sample ${sample}`];

  // Single-turn runbooks (e.g. spark-scenario-efficiency) record the whole
  // solve in turn1, with the user-facing answer in turn1.response.text and no
  // exercise turn. The two-stage author/exercise layout below assumes a turn2
  // and would render the answer as "(no response)", failing every criterion on
  // a correct answer. When there is no turn2, render the single solve directly
  // so the judge sees the actual answer text.
  if (!turn2) {
    lines.push(`Prompt: ${turn1?.prompt || '(missing)'}`);
    renderToolCalls(lines, turn1?.response);
    lines.push(`capabilitiesLoaded: ${JSON.stringify(loadedSkills(turn1?.response || {}))}`);
    lines.push('Response:');
    lines.push('```');
    lines.push(turn1?.response?.text || '(no response)');
    lines.push('```');
    return lines.join('\n');
  }

  lines.push('## Stage 1 — Author');
  lines.push(`Prompt: ${turn1?.prompt || '(missing)'}`);
  renderToolCalls(lines, turn1?.response);
  // Show judges the same loaded-capability union the runbook scorer uses.
  lines.push(`capabilitiesLoaded: ${JSON.stringify(loadedSkills(turn1?.response || {}))}`);
  lines.push(`Generated artifact (${turn1?.generated?.body ? Buffer.byteLength(turn1.generated.body, 'utf8') : 0} bytes):`);
  lines.push('```markdown');
  lines.push(turn1?.generated?.body || '(no skill generated)');
  lines.push('```');
  lines.push('## Stage 2 — Exercise');
  lines.push(`Prompt: ${turn2?.prompt || '(skipped)'}`);
  lines.push(`capabilitiesLoaded: ${JSON.stringify(loadedSkills(turn2?.response || {}))}`);
  lines.push(`Response:`);
  lines.push('```');
  lines.push(turn2?.response?.text || '(no response)');
  lines.push('```');
  return lines.join('\n');
}

async function loadSignals(runDir) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(runDir, 'signals.json'), 'utf8'));
    return j.signals || [];
  } catch {
    return []; 
  }
}

async function loadResults(runDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(runDir, 'results.json'), 'utf8')); 
  } catch {
    return null; 
  }
}

async function processVariant({ runDir, variantLabel, evals, mode, refitStale, log, loadedSkills }) {
  const results = await loadResults(runDir);
  if (!results) {
    log(`${variantLabel}: no results.json — skipping`);
    return { runDir, variantLabel, processed: 0, autoFailed: 0, missing: [], invalid: [], skippedValid: 0, refit: refitStale };
  }
  const signals = await loadSignals(runDir);
  const sampleSignals = new Map();
  for (const s of signals) {
    if (!s.eval || !s.sample) {
      continue;
    }
    const k = `${s.eval}-sample${s.sample}`;
    if (!sampleSignals.has(k)) {
      sampleSignals.set(k, []);
    }
    sampleSignals.get(k).push(s);
  }

  let processed = 0, autoFailed = 0, skippedValid = 0;
  const missing = [], invalid = [];

  for (const r of results.results) {
    const ev = evals.find(e => e.id === r.evalId);
    if (!ev) {
      continue;
    }
    const refitHash = refitStale ? ev.criteriaHash : undefined;
    const sampleId = `${r.evalId}-sample${r.sample}`;
    const sigs = sampleSignals.get(sampleId) || [];
    const blockingSignal = sigs.find(s => s.level === 'block' && s.kind === 'capability-not-loaded');

    if (mode === 'agent') {
      // Refit-stale skips samples whose canonical verdict is already valid
      // against the current criteriaHash. Stale, missing, malformed, and
      // wrong-model verdicts are refit. Legacy verdicts are also refit
      // (they predate criteriaHash so we can't trust them under the new rubric).
      if (refitStale) {
        const cur = await readVerdictForRep({
          runDir, evalId: r.evalId, sample: r.sample,
          criteria: ev.criteria, expectedCriteriaHash: ev.criteriaHash,
        });
        if (cur.classification === 'valid') {
          skippedValid++;
          continue;
        }
      }

      if (blockingSignal) {
        const verdict = failAllCriteriaVerdict({
          evalId: r.evalId, sample: r.sample, criteria: ev.criteria,
          criteriaHash: ev.criteriaHash,
          reason: `capability-not-loaded: ${blockingSignal.message}`,
        });
        const vp = expectedVerdictPath({ runDir, evalId: r.evalId, sample: r.sample, refitHash });
        await fs.mkdir(path.dirname(vp), { recursive: true });
        await fs.writeFile(vp, JSON.stringify(verdict, null, 2) + '\n');
        autoFailed++;
        const stubPrompt = `# Judge prompt — ${r.evalId} sample ${r.sample}\n\nAuto-failed by signal: ${blockingSignal.message}\n\nVerdict already written to ../${verdictDirRel(refitHash)}/${path.basename(vp)} — no agent action required.\n`;
        await writePromptForRep({ runDir, evalId: r.evalId, sample: r.sample, prompt: stubPrompt, refitHash });
        continue;
      }
      const t1 = await loadTurn(runDir, r.evalId, r.sample, 1);
      const t2 = await loadTurn(runDir, r.evalId, r.sample, 2);
      const artifact = buildArtifact(r.sample, t1, t2, loadedSkills);
      const prompt = buildCriteriaPrompt({
        evalId: r.evalId, sample: r.sample, criteria: ev.criteria,
        criteriaHash: ev.criteriaHash, artifact, refitHash,
        header: `Variant: ${variantLabel}. This is sample ${r.sample} of ${results.samples} for eval "${r.evalId}".${refitStale ? ' (REFIT — original verdict was stale or invalid; new verdict goes to the refit directory.)' : ''}`,
      });
      await writePromptForRep({ runDir, evalId: r.evalId, sample: r.sample, prompt, refitHash });
      processed++;
    } else if (mode === 'collect') {
      const v = await readVerdictForRep({
        runDir, evalId: r.evalId, sample: r.sample,
        criteria: ev.criteria, expectedCriteriaHash: ev.criteriaHash, refitHash,
      });
      if (!v.found) {
        missing.push(path.basename(v.path));
      } else if (v.parseError) {
        invalid.push({ file: path.basename(v.path), errors: [v.parseError] });
      } else if (!v.ok) {
        invalid.push({ file: path.basename(v.path), classification: v.classification, errors: v.errors });
      } else {
        processed++;
      }
    }
  }

  return { runDir, variantLabel, processed, autoFailed, missing, invalid, skippedValid, refit: refitStale };
}

export async function runJudge({ argv, runbookDir, repoRoot, log, loadedSkills = () => [] } = {}) {
  const onLog = log || ((m) => process.stderr.write(`[judge] ${m}\n`));
  const { experiment, pair, mode, variant, refitStale, dispatchPrompt } = parseArgs(argv || []);
  if (!experiment) {
    throw new Error('judge: --experiment <name> required');
  }
  if (!['agent', 'collect', 'validate'].includes(mode)) {
    throw new Error(`--mode must be agent|collect|validate (got '${mode}')`);
  }
  const expDir = path.join(repoRoot, 'experiments', experiment);
  const { controlRun, variantRun, variantName } = await resolvePair(expDir, pair);

  // --dispatch-prompt: print sub-agent prompt to stdout and exit.
  // Pure read-only — does not load evals or touch judge-* dirs.
  if (dispatchPrompt) {
    const prompt = buildDispatchPrompt({ controlRun, variantRun, variantName, refitStale });
    process.stdout.write(prompt + '\n');
    return { controlRun, variantRun, variantName, dispatchPrompt: true };
  }

  const { evals } = await loadEvals(runbookDir);

  // --mode validate: walk both run dirs' judge-verdicts/ and report
  // per-file classification. Fast feedback after a sub-agent dispatch
  // before running --mode collect.
  if (mode === 'validate') {
    const refitHash = refitStale ? '<criteriaHash>' : null;
    const targets = [];
    if (controlRun) {
      targets.push({ runDir: controlRun, label: 'control' });
    }
    if (variantRun) {
      targets.push({ runDir: variantRun, label: variantName });
    }
    let anyBad = false;
    const results = [];
    for (const t of targets) {
      const r = await validateVerdictDir({ runDir: t.runDir, evals, refitHash });
      const summary = summarizeValidation(r.files);
      results.push({ label: t.label, ...r, summary });
      onLog(`[validate] ${t.label}: ${summary.ok}/${summary.total} valid` +
        (summary.bad ? ` — ${summary.bad} BAD` : ''));
      for (const f of r.files) {
        if (f.classification === 'valid' || f.classification === 'legacy') {
          continue;
        }
        anyBad = true;
        onLog(`[validate]   ${f.classification.toUpperCase()}: ${f.file}`);
        for (const e of f.errors) {
          onLog(`[validate]     ${e}`);
        }
      }
    }
    if (anyBad) {
      onLog('FAIL: at least one verdict file has the wrong shape. Re-dispatch the judge sub-agent (use --dispatch-prompt for the exact contract).');
      const err = new Error('verdict validation failed');
      err.code = 'JUDGE_VALIDATION_FAIL';
      throw err;
    }
    return { controlRun, variantRun, variantName, results };
  }

  onLog(`[${mode}${refitStale ? ' refit-stale' : ''}] control:   ${controlRun}`);
  if (variantRun) {
    onLog(`[${mode}${refitStale ? ' refit-stale' : ''}] variant: ${variantRun}  (${variantName})`);
  } else {
    onLog(`[${mode}] (control-only baseline mode — no variant yet)`);
  }

  const variants = [];
  if (!variant || variant === 'control') {
    variants.push({ runDir: controlRun, label: 'control' });
  }
  if (variantRun && (!variant || variant === variantName)) {
    variants.push({ runDir: variantRun, label: variantName });
  }

  const summary = [];
  for (const a of variants) {
    const r = await processVariant({ runDir: a.runDir, variantLabel: a.label, evals, mode, refitStale, log: onLog, loadedSkills });
    summary.push(r);
    if (mode === 'agent') {
      const refitTag = refitStale ? ` (refit; ${r.skippedValid} valid skipped)` : '';
      onLog(`[agent] ${a.label}: wrote ${r.processed} prompt(s), auto-failed ${r.autoFailed} blocked sample(s)${refitTag}`);
    } else {
      onLog(`[collect${refitStale ? ' refit' : ''}] ${a.label}: ${r.processed} valid, ${r.missing.length} missing, ${r.invalid.length} invalid`);
      if (r.missing.length) {
        onLog(`[collect]   missing: ${r.missing.join(', ')}`);
      }
      for (const inv of r.invalid) {
        // Pretty per-file errors so the agent can paste them straight back
        // to the sub-agent. Avoid the JSON.stringify wall-of-text format.
        const file = inv.file || inv.path || '<unknown>';
        const cls = inv.classification ? ` [${inv.classification}]` : '';
        onLog(`[collect]   INVALID: ${file}${cls}`);
        for (const e of (inv.errors || [])) {
          onLog(`[collect]     ${e}`);
        }
      }
      if (r.invalid.length) {
        onLog('[collect] tip: re-dispatch the judge sub-agent with the exact contract via:');
        onLog('[collect]   forge judge <experiment> --dispatch-prompt');
      }
    }
  }

  for (const r of summary) {
    const status = {
      mode, refit: !!refitStale,
      processed: r.processed, autoFailed: r.autoFailed,
      skippedValid: r.skippedValid || 0,
      missing: r.missing, invalid: r.invalid,
      writtenAt: new Date().toISOString(),
    };
    const statusName = refitStale ? 'judge-status-refit.json' : 'judge-status.json';
    await fs.writeFile(path.join(r.runDir, statusName), JSON.stringify(status, null, 2) + '\n');
  }

  if (mode === 'agent') {
    onLog(`next: hand the sub-agent the verbatim contract from \`forge judge ${experiment} --dispatch-prompt\` (do NOT hand-write the schema), then run \`forge judge ${experiment} --mode validate\` to catch wrong-shape verdicts BEFORE collect/score.`);
    onLog(`policy: dispatch the judge sub-agent with model='${REQUIRED_JUDGE_MODEL}' — see .claude/skills/experiment/SKILL.md "Judge model policy".`);
  } else {
    const allMissing = summary.reduce((n, r) => n + r.missing.length, 0);
    const allInvalid = summary.reduce((n, r) => n + r.invalid.length, 0);
    if (allMissing > 0 || allInvalid > 0) {
      // Fail loud with a non-zero exit: a cheerful "all verdicts present" while
      // files are missing or wrong-shape sends score into a null/zero-tier
      // result that looks like a pass. Logging alone is not enough because the
      // judge shim only exits non-zero when runJudge throws, so downstream
      // automation could still run `forge score` on a blocked set. Throw so the
      // chain halts. judge-status.json is already written above for inspection.
      onLog(`BLOCKED: ${allMissing} verdict file(s) missing, ${allInvalid} invalid. Fix them before scoring — re-dispatch via \`forge judge ${experiment} --dispatch-prompt\`, then \`--mode validate\`. Missing samples score as auto-fail; invalid samples are not gradeable.`);
      const err = new Error(`collect blocked: ${allMissing} missing, ${allInvalid} invalid verdict file(s)`);
      err.code = 'JUDGE_COLLECT_BLOCKED';
      throw err;
    }
    onLog(`all verdicts present and valid. Run \`forge score ${experiment}\` next.`);
  }
  return { summary, controlRun, variantRun, variantName, refitStale };
}
