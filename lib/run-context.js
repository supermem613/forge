// lib/run-context.js — shared run-context loader.
//
// Both runbook run.js scripts open their run by doing nearly identical
// work: parse the standard CLI args, locate the experiment, load
// manifest + experiment.json, compute the variant directory layout,
// load + filter evals, and compute URL params.
// `loadRunContext` consolidates that header so each runbook's run.js
// can focus on its actual stage logic.
//
// Inputs:
//   argv        — process.argv.slice(2)-style array
//   runbookId   — e.g. 'create-skill'
//   runbookDir  — absolute path to runbooks/<id>/
//   repoRoot    — absolute path to forge repo root
//   extraArgs   — optional map of extra `--flag` names to record on the
//                 returned context (e.g. ['keep-skills', 'clean-orphans']).
//                 Boolean flags (no value) become `true`; valued flags
//                 become string. Unknown args are ignored.
//
// Output (frozen):
//   {
//     experiment, variant, isControl, samples, evalIds, extras,
//     expDir, variantDir, artifactsDir, runsDir,
//     manifest, experimentJson, evals,
//     urlParams: { control, treatment, active },
//   }
//
// Throws on: missing --experiment / --variant, unknown experiment,
// unparseable variant, eval-not-found when --evalIds is given.

import { promises as fs } from 'node:fs';
import path from 'node:path';

function parseArgsRaw(argv) {
  const out = {
    experiment: null, variant: null, samples: null, evalIds: null,
    extras: {},
  };
  const _extras = out.extras;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === '--experiment') {
      out.experiment = n; i++; 
    } else if (a === '--variant') {
      out.variant = n; i++; 
    } else if (a === '--samples') {
      out.samples = Number(n); i++; 
    } else if (a === '--evalIds') {
      out.evalIds = n.split(','); i++; 
    } else if (a && a.startsWith('--')) {
      const key = a.slice(2);
      if (n === undefined || n.startsWith('--')) {
        _extras[key] = true; 
      } else {
        _extras[key] = n; i++; 
      }
    }
  }
  return out;
}

function validateVariant(v) {
  if (v === 'control') {
    return true;
  }
  if (/^mark-\d+$/.test(v)) {
    return true;
  }
  return false;
}

export async function loadRunContext({ argv, runbookId, runbookDir, repoRoot } = {}) {
  if (!runbookId) {
    throw new Error('loadRunContext: runbookId required');
  }
  if (!runbookDir) {
    throw new Error('loadRunContext: runbookDir required');
  }
  if (!repoRoot) {
    throw new Error('loadRunContext: repoRoot required');
  }

  const parsed = parseArgsRaw(argv || []);
  if (!parsed.experiment) {
    throw new Error('run: --experiment <name> required');
  }
  if (!parsed.variant) {
    throw new Error('run: --variant <control|mark-N> required');
  }
  if (!validateVariant(parsed.variant)) {
    throw new Error(`run: --variant must be 'control' or 'mark-N' (got '${parsed.variant}')`);
  }

  const experiment = parsed.experiment;
  const variant = parsed.variant;
  const isControl = variant === 'control';

  const expDir = path.join(repoRoot, 'experiments', experiment);
  let experimentJson;
  try {
    experimentJson = JSON.parse(await fs.readFile(path.join(expDir, 'experiment.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`run: no such experiment: ${experiment}`);
    }
    throw e;
  }

  const manifest = JSON.parse(await fs.readFile(path.join(runbookDir, 'manifest.json'), 'utf8'));
  const samples = parsed.samples != null ? parsed.samples : (manifest.defaults?.samples ?? 1);

  const variantDir = path.join(expDir, 'variants', variant);
  const artifactsDir = path.join(variantDir, 'artifacts');
  const runsDir = path.join(variantDir, 'runs');

  // Evals: load all, filter by --evalIds if present. We do NOT use
  // eval-loader.normalizeEval here — runtime stages use the raw eval
  // shape (prompts, fixtures). The judge orchestrator normalizes
  // separately when computing criteriaHash.
  const allEvals = [];
  for (const rel of manifest.evals || []) {
    allEvals.push(JSON.parse(await fs.readFile(path.join(runbookDir, rel), 'utf8')));
  }
  let evals = allEvals;
  if (parsed.evalIds && parsed.evalIds.length > 0) {
    const wanted = new Set(parsed.evalIds);
    evals = allEvals.filter(e => wanted.has(e.id));
    const missing = parsed.evalIds.filter(id => !allEvals.some(e => e.id === id));
    if (missing.length) {
      throw new Error(`run: --evalIds includes unknown id(s): ${missing.join(', ')}`);
    }
  }

  // URL params: experiment.json may declare urlParams.{control,treatment}.
  // Active set is picked by isControl. Strips a leading `?` so callers
  // can append directly. Empty string is the safe default.
  const urlParamsAll = experimentJson.urlParams || {};
  const stripQ = (s) => (s || '').replace(/^\?+/, '');
  const urlParams = {
    control: stripQ(urlParamsAll.control),
    treatment: stripQ(urlParamsAll.treatment),
    active: stripQ(isControl ? urlParamsAll.control : urlParamsAll.treatment),
  };

  const ctx = Object.freeze({
    experiment, variant, isControl,
    samples, evalIds: parsed.evalIds, extras: parsed.extras,
    expDir, variantDir, artifactsDir, runsDir,
    manifest, experimentJson, evals,
    urlParams,
  });
  // Single source of truth for the per-run start banner — every runbook's
  // run.js gets a uniform context dump for free, so the orchestrator agent
  // never has to cat README.md + experiment.json to know what's about to run.
  // Suppress with FORGE_NO_RUN_BANNER=1 (used by tests to keep snapshots
  // stable).
  if (!process.env.FORGE_NO_RUN_BANNER) {
    process.stderr.write(formatRunBanner(ctx) + '\n');
  }
  return ctx;
}

export function formatRunBanner(ctx) {
  const evalIds = ctx.evals.map(e => e.id);
  const lines = [
    '─── forge run ──────────────────────────────────────────────',
    `  runbook:    ${ctx.manifest.id}@${ctx.manifest.version}` +
      (ctx.manifest.description ? ` — ${ctx.manifest.description}` : ''),
    `  experiment: ${ctx.experiment}` +
      (ctx.experimentJson?.description ? ` — ${ctx.experimentJson.description}` : ''),
    `  variant:    ${ctx.variant}${ctx.isControl ? ' (control)' : ''}`,
    `  samples:    ${ctx.samples}`,
    `  evals:      ${evalIds.length}` + (evalIds.length ? ` [${evalIds.join(', ')}]` : ''),
    `  urlParams:  ${ctx.urlParams.active || '<none>'}` +
      (ctx.isControl ? '  (control)' : '  (treatment)'),
    '────────────────────────────────────────────────────────────',
  ];
  return lines.join('\n');
}
