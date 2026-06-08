#!/usr/bin/env node
// lib/cli.js — `forge` CLI dispatcher.
//
// Forge separates two concepts:
//
//   runbooks/<name>/        committed, durable recipe (manifest + scripts +
//                           fixtures + evals). Quiesces over time.
//
//   experiments/<name>/     local-only (gitignored), per-user lab notebook.
//                           Holds one control + N variants (mark-N) and
//                           their runs. Each experiment names its runbook
//                           in experiment.json.
//
// Usage:
//   forge list
//   forge experiments
//   forge new-experiment <experiment> --runbook <runbook> [--notes "..."]
//   forge propose      <experiment> [--from <path>] [--iterate mark-N] [--mark mark-N]
//   forge setup        <experiment>
//   forge run          <experiment> control          [--samples N] [--evalIds a,b] [--capture]
//   forge run          <experiment> mark-N           [--samples N] [--evalIds a,b] [--capture]
//   forge score        <experiment> [--pair latest|<spec>]
//   forge judge        <experiment> [--pair latest|<spec>] [--mode agent|collect]
//   forge report       <experiment> [--pair latest|<spec>]
//   forge teardown     <experiment>
//   forge runs         <experiment>
//   forge artifact-check <runDir> [--json]

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, formatDoctorText, waitForDoctorOk } from './doctor.js';
import { sweepStaleLocks } from './locks.js';
import { resolveSampleN } from './symmetric-n.js';
import { validateRunbook, formatValidateResult } from './cli-validate.js';
import { bumpRunbook } from './cli-bump.js';
import { scaffoldRunbook } from './cli-new-runbook.js';
import { compareVariants, formatCompare } from './cli-compare.js';
import { addEval } from './cli-add-eval.js';
import { archiveExperiment } from './cli-archive.js';
import { updateForge } from './cli-update.js';
import { checkRunArtifact, formatArtifactCheck } from './run-artifact-check.js';
import { loadForgeRegistry, listRunbooks as listRegisteredRunbooks, findRunbook } from './module-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks');
const EXPERIMENTS_DIR = path.join(REPO_ROOT, 'experiments');

function usage(exit = 0) {
  process.stdout.write(`forge — experiment harness

Commands:
  list                                              list runbooks (committed recipes)
  experiments                                       list local experiments
  propose        <exp> [--from <p>] [--iterate mark-N] [--copy-prev] [--mark mark-N]
                                                    draft a variant under variants/mark-<next>/
  new-experiment <exp> --runbook <rb> [--notes ..] [--control-from <dir>] [--treatment-url-params "?..."]
                                                    scaffold experiments/<exp>/
  setup          <exp>                              upload fixtures (runbook setup.js)
  run            <exp> control [--append-control --samples N]
                                                    append N more samples to latest control run
  run            <exp> mark-N                       run the named variant
  score          <exp> [--pair latest|<spec>]       deterministic scoring of a paired run
  judge          <exp> [--pair latest|<spec>]       agent-as-judge (criteria PASS/FAIL per sample)
  report         <exp> [--pair latest|<spec>]       write REPORT.md (pp deltas) into the variant run
  present        <exp> [--pair latest|<spec>]       paste-ready summary (headline, learnings, heatmap)
  teardown       <exp>                              clean up runbook fixtures
  archive        <exp> --to <path> [--keep-shell] [--no-zip] [--reason "..."] [--dry-run]
                                                    move experiments/<exp>/ into <path>/experiments/<exp>/<ts>/
                                                    (per-run dirs zipped by default to satisfy GitHub's 100MB file limit)
  runs           <exp> [--json]                     list runs across control + variants
  artifact-check <runDir> [--json]                  validate manifest/transcript run artifact schema
  compare        <exp> <variantA> <variantB> [--json]
                                                    diff REPORT.json headlines (B − A)
  resample       <exp> <variant> --eval <id> --sample <N>
                                                    re-run a single sample (forwards --resample-only)
  <module-command>                                  commands registered by configured modules
  doctor         [--json] [--fix] [--wait] [--timeout MS] [--interval MS]
                                                    environment health checks (--wait polls until OK or timeout)
  validate       [<runbook>]                        validate one or all runbooks vs RUNBOOK_CONTRACT
  update                                            self-update: git pull + npm install + build + npm link
  bump           <runbook> [patch|minor|major] [--changelog "summary"]
                                                    bump runbook manifest version (default: patch)
  add-eval       <runbook> --file <path>            register a new eval JSON in runbooks/<rb>/
  new-runbook    <id> [--description "..."]
                                                    scaffold a new runbooks/<id>/

Pair spec:
  latest                          latest control run × latest variant run under the largest mark
  <ctlTs>+<mark>:<txTs>           explicit, e.g. 2026-04-23T18-15-19-428+mark-1:2026-04-23T18-36-11-926

Examples:
  forge list
  forge new-experiment prompt-routing --runbook router-eval --notes "first cut"
  forge propose prompt-routing --from C:/temp/variant-artifacts
  forge setup prompt-routing
  forge run   prompt-routing control --samples 3
  forge run   prompt-routing mark-1  --samples 3
  forge score prompt-routing --pair latest
  forge judge prompt-routing --pair latest
  forge report prompt-routing --pair latest
  forge teardown prompt-routing
`);
  process.exit(exit);
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true; 
      } else {
        flags[key] = next; i++; 
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

async function listRunbooks(registry) {
  return listRegisteredRunbooks(registry);
}

async function listExperiments() {
  let entries;
  try {
    entries = await fs.readdir(EXPERIMENTS_DIR, { withFileTypes: true }); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return [];
    } throw e; 
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const expJsonPath = path.join(EXPERIMENTS_DIR, e.name, 'experiment.json');
    let expJson = null;
    try {
      expJson = JSON.parse(await fs.readFile(expJsonPath, 'utf8')); 
    } catch {}
    out.push({ id: e.name, experiment: expJson });
  }
  return out;
}

async function readExperiment(name) {
  const dir = path.join(EXPERIMENTS_DIR, name);
  const expJsonPath = path.join(dir, 'experiment.json');
  let json;
  try {
    json = JSON.parse(await fs.readFile(expJsonPath, 'utf8')); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`no such experiment: ${name} (missing experiments/${name}/experiment.json)`);
    }
    throw e;
  }
  if (!json.runbook) {
    throw new Error(`experiments/${name}/experiment.json missing "runbook" field`);
  }
  return { dir, json };
}

async function listMarks(expDir) {
  const variantsDir = path.join(expDir, 'variants');
  let entries;
  try {
    entries = await fs.readdir(variantsDir, { withFileTypes: true }); 
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

async function listRuns(expName) {
  const expDir = path.join(EXPERIMENTS_DIR, expName);
  const runs = [];
  const controlRuns = path.join(expDir, 'variants', 'control', 'runs');
  try {
    for (const d of await fs.readdir(controlRuns, { withFileTypes: true })) {
      if (d.isDirectory()) {
        runs.push({ variant: 'control', ts: d.name, dir: path.join(controlRuns, d.name) });
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    } 
  }
  const variantsDir = path.join(expDir, 'variants');
  try {
    for (const m of await fs.readdir(variantsDir, { withFileTypes: true })) {
      if (!m.isDirectory()) {
        continue;
      }
      if (m.name === 'control') {
        continue;
      }
      const runsDir = path.join(variantsDir, m.name, 'runs');
      try {
        for (const d of await fs.readdir(runsDir, { withFileTypes: true })) {
          if (d.isDirectory()) {
            runs.push({ variant: m.name, ts: d.name, dir: path.join(runsDir, d.name) });
          }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e;
        } 
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    } 
  }
  return runs.sort((a, b) => a.ts.localeCompare(b.ts));
}

async function copyDirRec(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      await copyDirRec(s, d);
    } else if (ent.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function runStep({ registry, runbook, runbookDir, experiment, step, args }) {
  const scriptPath = path.join(runbookDir, `${step}.js`);
  try {
    await fs.access(scriptPath); 
  } catch {
    throw new Error(`no such step: ${path.join(runbookDir, `${step}.js`)}`); 
  }

  // SIGINT cleanup: modules can register idempotent abort hooks for any
  // resources their runbooks acquire outside the child process.
  let cleanupRequested = false;
  let child;
  const onSigint = () => {
    if (cleanupRequested) {
      // Second Ctrl+C: hard-kill the child immediately.
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL'); 
        } catch {} 
      }
      return;
    }
    cleanupRequested = true;
    process.stderr.write(`\nforge: SIGINT — forwarding to runbook child for graceful cleanup\n`);
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM'); 
      } catch {}
    }
  };
  if (step === 'run') {
    process.on('SIGINT', onSigint);
  }

  try {
    return await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [scriptPath, '--experiment', experiment, ...args], {
        stdio: 'inherit',
        env: { ...process.env, FORGE_RUNBOOK_ID: runbook, FORGE_EXPERIMENT: experiment },
        cwd: REPO_ROOT,
      });
      child.on('exit', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`runbooks/${runbook}/${step}.js exited ${code}`));
        }
      });
      child.on('error', reject);
    });
  } finally {
    if (step === 'run') {
      process.removeListener('SIGINT', onSigint);
    }
    // Run module-provided cleanup on ANY abnormal exit.
    if (step === 'run') {
      const cleanExit = !cleanupRequested && child && !child.killed && child.exitCode === 0;
      if (!cleanExit) {
        await postAbortCleanup({ registry, runbook, runbookDir, experiment, reason: cleanupRequested ? 'sigint' : 'child-error' }).catch((e) => {
          process.stderr.write(`forge: post-abort cleanup error: ${e.message}\n`);
        });
      }
    }
  }
}

// Belt-and-suspenders cleanup invoked after a `forge run` ended abnormally.
async function postAbortCleanup({ registry, runbook, runbookDir, experiment, reason = 'unknown' }) {
  const log = (m) => process.stderr.write(`${m}\n`);
  log(`forge: post-abort cleanup (reason=${reason})`);
  for (const hook of registry.abortHooks()) {
    await hook({ runbook, runbookDir, experiment, reason, log });
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage(0);
  }
  const registry = await loadForgeRegistry({ repoRoot: REPO_ROOT });

  if (cmd === 'config') {
    const sub = rest[0];
    const configPath = path.join(REPO_ROOT, 'forge.config.json');
    if (sub === 'init') {
      try {
        await fs.access(configPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
        await fs.writeFile(configPath, JSON.stringify({ modules: [] }, null, 2) + '\n');
      }
      process.stdout.write(`${configPath}\n`);
      return;
    }
    if (sub === 'add-module') {
      const { args: cargs, flags: cflags } = parseArgs(rest.slice(1));
      const modulePath = cflags.path && cflags.path !== true ? String(cflags.path) : cargs[0];
      if (!modulePath) {
        throw new Error('config add-module: --path <path> required');
      }
      let config;
      try {
        config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
        config = { modules: [] };
      }
      config.modules = Array.isArray(config.modules) ? config.modules : [];
      const resolved = path.resolve(modulePath);
      if (!config.modules.some(m => path.resolve(REPO_ROOT, m.path || m) === resolved)) {
        config.modules.push({ name: cflags.name && cflags.name !== true ? String(cflags.name) : path.basename(resolved), path: resolved });
      }
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
      process.stdout.write(`${configPath}\n`);
      return;
    }
    throw new Error('config: unknown subcommand (init|add-module)');
  }

  if (cmd === 'list') {
    const rbs = await listRunbooks(registry);
    if (rbs.length === 0) {
      process.stdout.write('(no runbooks)\n'); return; 
    }
    for (const r of rbs) {
      const desc = r.manifest?.description || '(no manifest)';
      process.stdout.write(`  ${r.id.padEnd(20)} ${desc}\n`);
    }
    return;
  }

  if (cmd === 'experiments') {
    const exps = await listExperiments();
    if (exps.length === 0) {
      process.stdout.write('(no experiments — use `forge new-experiment <name> --runbook <rb>`)\n'); return; 
    }
    for (const e of exps) {
      const rb = e.experiment?.runbook || '(no experiment.json)';
      const notes = e.experiment?.notes ? ` — ${e.experiment.notes}` : '';
      process.stdout.write(`  ${e.id.padEnd(40)} runbook=${rb}${notes}\n`);
    }
    return;
  }

  if (cmd === 'doctor') {
    const { flags: dflags } = parseArgs(rest);
    if (dflags.fix) {
      const swept = await sweepStaleLocks();
      if (swept.length) {
        process.stdout.write(`swept ${swept.length} stale resource lock(s)\n`);
      }
    }
    if (dflags.wait) {
      const timeoutMs = Number(dflags.timeout) > 0 ? Number(dflags.timeout) : 240_000;
      const intervalMs = Number(dflags.interval) > 0 ? Number(dflags.interval) : 5_000;
      const wait = await waitForDoctorOk({
        timeoutMs, intervalMs, fix: !!dflags.fix, extraChecks: registry.doctorChecks(),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      if (dflags.json) {
        process.stdout.write(JSON.stringify(wait.result, null, 2) + '\n');
      } else {
        process.stdout.write(formatDoctorText(wait.result) + '\n');
      }
      process.exit(wait.ok ? 0 : 1);
    }
    const result = await runDoctor({ fix: !!dflags.fix, extraChecks: registry.doctorChecks() });
    if (dflags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(formatDoctorText(result) + '\n');
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'update') {
    const result = await updateForge();
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'artifact-check') {
    const { args: cargs, flags: cflags } = parseArgs(rest);
    const runDir = cargs[0] ? path.resolve(cargs[0]) : null;
    if (!runDir) {
      throw new Error('artifact-check: <runDir> required');
    }
    const result = await checkRunArtifact({ runDir });
    if (cflags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(formatArtifactCheck(result));
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'validate') {
    const { args: vargs, flags: vflags } = parseArgs(rest);
    const target = vargs[0];
    const targets = target
      ? [target]
      : (await listRunbooks(registry)).map(r => r.id);
    if (targets.length === 0) {
      process.stdout.write('(no runbooks)\n'); return; 
    }
    let anyFail = false;
    const all = [];
    for (const id of targets) {
      const runbook = await findRunbook(registry, id);
      if (!runbook) {
        throw new Error(`no such runbook: ${id}`);
      }
      const runbookDir = runbook.dir;
      const result = await validateRunbook({ runbookDir, runbookId: id });
      all.push({ id, ...result });
      if (!result.ok) {
        anyFail = true;
      }
      if (!vflags.json) {
        process.stdout.write(formatValidateResult(result, { runbookId: id }));
      }
    }
    if (vflags.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    }
    process.exit(anyFail ? 1 : 0);
  }

  if (cmd === 'bump') {
    const { args: bargs, flags: bflags } = parseArgs(rest);
    const id = bargs[0];
    const level = bargs[1] || 'patch';
    if (!id) {
      throw new Error('bump: <runbook> required');
    }
    const runbook = await findRunbook(registry, id);
    if (!runbook) {
      throw new Error(`no such runbook: ${id}`); 
    }
    const runbookDir = runbook.dir;
    const changelog = bflags.changelog && bflags.changelog !== true ? String(bflags.changelog) : null;
    const result = await bumpRunbook({ runbookDir, level, changelog });
    process.stdout.write(JSON.stringify({ action: 'bump', runbook: id, ...result }, null, 2) + '\n');
    return;
  }

  if (cmd === 'new-runbook') {
    const { args: nargs, flags: nflags } = parseArgs(rest);
    const id = nargs[0];
    if (!id) {
      throw new Error('new-runbook: <id> required');
    }
    const result = await scaffoldRunbook({
      runbookId: id,
      runbooksDir: RUNBOOKS_DIR,
      description: nflags.description && nflags.description !== true ? String(nflags.description) : null,
    });
    process.stdout.write(JSON.stringify({
      action: 'new-runbook', runbook: id, dir: result.dir,
      catalog: result.catalog,
      nextSteps: [
        `1. Edit runbooks/${id}/manifest.json (fixturePrefix, description, and module-specific fields).`,
        `2. Add real evals via: node lib/cli.js add-eval ${id} --file <path-to-eval.json>`,
        `3. Implement runbooks/${id}/run.js (sample loop) and score.js (deterministic scoring).`,
        `4. Run: node lib/cli.js validate ${id}`,
      ],
    }, null, 2) + '\n');
    return;
  }

  if (cmd === 'add-eval') {
    const { args: aargs, flags: aflags } = parseArgs(rest);
    const id = aargs[0];
    if (!id) {
      throw new Error('add-eval: <runbook> required');
    }
    const file = aflags.file && aflags.file !== true ? String(aflags.file) : null;
    if (!file) {
      throw new Error('add-eval: --file <path> required');
    }
    const runbook = await findRunbook(registry, id);
    if (!runbook) {
      throw new Error(`no such runbook: ${id}`); 
    }
    const runbookDir = runbook.dir;
    const result = await addEval({ runbookDir, sourceFile: path.resolve(file) });
    process.stdout.write(JSON.stringify({ action: 'add-eval', runbook: id, ...result }, null, 2) + '\n');
    return;
  }

  const { args, flags } = parseArgs(rest);

  if (cmd === 'new-experiment') {
    const name = args[0];
    if (!name) {
      throw new Error('new-experiment: <experiment-name> required');
    }
    if (!flags.runbook) {
      throw new Error('new-experiment: --runbook <runbook> required');
    }
    const runbook = String(flags.runbook);
    const runbookInfo = await findRunbook(registry, runbook);
    if (!runbookInfo) {
      throw new Error(`no such runbook: ${runbook}`); 
    }
    const expDir = path.join(EXPERIMENTS_DIR, name);
    let exists = false;
    try {
      await fs.access(expDir); exists = true; 
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      } 
    }
    if (exists) {
      throw new Error(`experiment already exists: experiments/${name}/`);
    }
    await fs.mkdir(path.join(expDir, 'variants', 'control', 'artifacts'), { recursive: true });
    await fs.mkdir(path.join(expDir, 'variants', 'control', 'runs'), { recursive: true });
    await fs.mkdir(path.join(expDir, 'variants'), { recursive: true });
    const expJson = {
      runbook,
      createdAt: new Date().toISOString(),
      notes: flags.notes && flags.notes !== true ? String(flags.notes) : null,
    };
    if (flags['treatment-url-params'] && flags['treatment-url-params'] !== true) {
      expJson.urlParams = { control: '', treatment: String(flags['treatment-url-params']) };
    }
    await fs.writeFile(path.join(expDir, 'experiment.json'), JSON.stringify(expJson, null, 2) + '\n');
    if (flags['control-from'] && flags['control-from'] !== true) {
      const src = path.resolve(String(flags['control-from']));
      let stat;
      try {
        stat = await fs.stat(src); 
      } catch {
        throw new Error(`--control-from: no such path: ${src}`); 
      }
      if (!stat.isDirectory()) {
        throw new Error(`--control-from: must be a directory (got ${src})`);
      }
      await copyDirRec(src, path.join(expDir, 'variants', 'control', 'artifacts'));
    }
    process.stdout.write(JSON.stringify({
      action: 'new-experiment', experiment: name, runbook, dir: expDir,
      controlFrom: flags['control-from'] && flags['control-from'] !== true ? String(flags['control-from']) : null,
      treatmentUrlParams: expJson.urlParams ? expJson.urlParams.treatment : null,
    }, null, 2) + '\n');
    return;
  }

  const registeredCommand = registry.commands().get(cmd);
  if (registeredCommand) {
    await registeredCommand({ argv: rest, args, flags, registry, repoRoot: REPO_ROOT, experimentsDir: EXPERIMENTS_DIR, parseArgs });
    return;
  }

  const experiment = args[0];
  if (!experiment) {
    usage(1);
  }

  if (cmd === 'runs') {
    const runs = await listRuns(experiment);
    if (flags.json) {
      process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
      return;
    }
    if (runs.length === 0) {
      process.stdout.write(`(no runs for ${experiment})\n`); return; 
    }
    for (const r of runs) {
      const tag = r.variant;
      process.stdout.write(`  ${tag.padEnd(20)} ${r.ts}\n`);
    }
    return;
  }

  if (cmd === 'compare') {
    const a = args[1], b = args[2];
    if (!a || !b) {
      throw new Error('compare: <variantA> and <variantB> required (e.g. mark-1 mark-2)');
    }
    const expDir = path.join(EXPERIMENTS_DIR, experiment);
    const result = await compareVariants({ expDir, specA: a, specB: b });
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(formatCompare(result));
    }
    return;
  }

  if (cmd === 'present') {
    const { buildPresentation } = await import('./cli-present.js');
    const pair = (typeof flags.pair === 'string') ? flags.pair : 'latest';
    const out = await buildPresentation({ experiment, pair, repoRoot: REPO_ROOT });
    process.stdout.write(out);
    return;
  }

  if (cmd === 'resample') {
    // Forwards to the runbook's run.js with --resample-only=<evalId>:<sample>.
    // The runbook must honor this by reusing the latest run dir for <variant>
    // and rewriting only the matching sample's bundle entries (append-only
    // for new files; overwrite-allowed for the targeted sample).
    const variant = args[1];
    if (!variant) {
      throw new Error('resample: <variant> required');
    }
    const evalId = flags.eval && flags.eval !== true ? String(flags.eval) : null;
    const sample = flags.sample && flags.sample !== true ? String(flags.sample) : null;
    if (!evalId || !sample) {
      throw new Error('resample: --eval <id> and --sample <N> required');
    }
    if (!/^\d+$/.test(sample)) {
      throw new Error('resample: --sample must be a positive integer');
    }
    const { json: expJsonObj } = await readExperiment(experiment);
    const runbookInfo = await findRunbook(registry, expJsonObj.runbook);
    if (!runbookInfo) {
      throw new Error(`no such runbook: ${expJsonObj.runbook}`);
    }
    const passthrough = ['--variant', variant, '--resample-only', `${evalId}:${sample}`, '--forge-root', REPO_ROOT];
    await runStep({
      registry, runbook: expJsonObj.runbook, runbookDir: runbookInfo.dir, experiment, step: 'run', args: passthrough,
    });
    return;
  }

  if (cmd === 'propose') {
    const { dir: expDir } = await readExperiment(experiment);
    const marks = await listMarks(expDir);
    let targetMark;
    if (flags.mark) {
      targetMark = String(flags.mark);
      if (!/^mark-\d+$/.test(targetMark)) {
        throw new Error(`--mark must look like mark-<N>`);
      }
    } else {
      const next = (marks.length ? marks[marks.length - 1].n : 0) + 1;
      targetMark = `mark-${next}`;
    }
    const markDir = path.join(expDir, 'variants', targetMark);
    const artifactsDir = path.join(markDir, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });

    if (flags['copy-prev'] && !flags.iterate) {
      // --copy-prev: shorthand for --iterate <latest-mark>. If no prior
      // mark exists, fall back to copying control artifacts so the new
      // mark starts from the current baseline.
      if (marks.length > 0) {
        flags.iterate = marks[marks.length - 1].name;
      } else {
        const ctrlSrc = path.join(expDir, 'variants', 'control', 'artifacts');
        try {
          const entries = await fs.readdir(ctrlSrc);
          if (entries.length > 0) {
            await copyDirRec(ctrlSrc, artifactsDir);
            await fs.writeFile(path.join(markDir, 'NOTES.md'),
              `# ${targetMark}\n\nCopied from control (no prior marks).\n\n## Hypothesis\n\n(fill in)\n`);
          }
        } catch (e) {
          if (e.code !== 'ENOENT') {
            throw e;
          } 
        }
      }
    }

    if (flags.iterate) {
      const src = path.join(expDir, 'variants', String(flags.iterate), 'artifacts');
      try {
        await fs.access(src); 
      } catch {
        throw new Error(`--iterate: no such mark: ${flags.iterate}`); 
      }
      await fs.rm(artifactsDir, { recursive: true, force: true });
      await copyDirRec(src, artifactsDir);
      await fs.writeFile(
        path.join(markDir, 'NOTES.md'),
        `# ${targetMark}\n\nIterating from ${flags.iterate}.\n\n## Hypothesis\n\n(fill in: what changed, and why)\n`
      );
    } else if (flags.from) {
      const src = path.resolve(String(flags.from));
      const stat = await fs.stat(src);
      const skillDirName = path.basename(src.replace(/[\\/]$/, ''));
      const targetSkillDir = path.join(artifactsDir, skillDirName);
      await fs.rm(targetSkillDir, { recursive: true, force: true });
      if (stat.isDirectory()) {
        await copyDirRec(src, targetSkillDir);
      } else {
        const wrapName = skillDirName.replace(/\.md$/i, '');
        const wrapDir = path.join(artifactsDir, wrapName);
        await fs.mkdir(wrapDir, { recursive: true });
        await fs.copyFile(src, path.join(wrapDir, path.basename(src)));
      }
      const notesPath = path.join(markDir, 'NOTES.md');
      try {
        await fs.access(notesPath); 
      } catch {
        await fs.writeFile(notesPath,
          `# ${targetMark}\n\nImported from ${src}.\n\n## Hypothesis\n\n(fill in)\n`);
      }
    } else {
      const notesPath = path.join(markDir, 'NOTES.md');
      try {
        await fs.access(notesPath); 
      } catch {
        await fs.writeFile(notesPath,
          `# ${targetMark}\n\n## Hypothesis\n\n(fill in: what's the change vs control / previous variant and why)\n`);
      }
    }

    process.stdout.write(JSON.stringify({
      action: 'propose-variant', experiment, mark: targetMark, markDir, artifactsDir,
      previousMarks: marks.map(m => m.name),
    }, null, 2) + '\n');
    return;
  }

  if (cmd === 'archive') {
    const archiveRoot = (typeof flags.to === 'string' && flags.to) || process.env.FORGE_ARCHIVE_ROOT || null;
    const result = await archiveExperiment({
      repoRoot: REPO_ROOT,
      experimentsDir: EXPERIMENTS_DIR,
      experiment,
      archiveRoot,
      reason: typeof flags.reason === 'string' ? flags.reason : null,
      keepShell: !!flags['keep-shell'],
      dryRun: !!flags['dry-run'],
      zipRuns: !flags['no-zip'],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const stepMap = { setup: 'setup', run: 'run', score: 'score', judge: 'judge', report: 'report', teardown: 'teardown' };
  if (!stepMap[cmd]) {
    usage(1);
  }

  const { json: expJson } = await readExperiment(experiment);
  const runbook = expJson.runbook;
  const runbookInfo = await findRunbook(registry, runbook);
  if (!runbookInfo) {
    throw new Error(`no such runbook: ${runbook}`);
  }

  for (const hook of registry.preStepHooks()) {
    await hook({
      step: cmd,
      runbook,
      runbookDir: runbookInfo.dir,
      experiment,
      experimentJson: expJson,
      args,
      flags,
      repoRoot: REPO_ROOT,
      log: (m) => process.stderr.write(`${m}\n`),
    });
  }

  const passthrough = [];
  if (cmd === 'run') {
    const variant = args[1];
    if (!variant) {
      throw new Error(`run: <variant> required (control or mark-N)`);
    }
    passthrough.push('--variant', variant);

    // Enforce symmetric-n unless --asymmetric is set. Mutates flags.samples
    // in place so the standard flag-passthrough below picks it up.
    // allow-asymmetric is consumed here and NOT forwarded.
    // --append-control bypasses symmetric-n (appending more control samples
    // is by definition asymmetric until the next variant run is sized to
    // match).
    const allowAsymmetric = !!flags['asymmetric'];
    delete flags['asymmetric'];
    const appendControl = !!flags['append-control'];
    if (!appendControl) {
      const requested = flags.samples != null && flags.samples !== true
        ? Number(flags.samples) : null;
      const expDir = path.join(EXPERIMENTS_DIR, experiment);
      const pinned = await resolveSampleN({
        expDir, variant, requestedSamples: requested, allowAsymmetric,
        log: (m) => process.stderr.write(`[forge] ${m}\n`),
      });
      if (pinned != null) {
        flags.samples = String(pinned);
      }
    } else if (variant !== 'control') {
      throw new Error('run --append-control: only valid with variant=control');
    }
  }
  for (const [k, v] of Object.entries(flags)) {
    passthrough.push(`--${k}`);
    if (v !== true) {
      passthrough.push(String(v));
    }
  }
  passthrough.push('--forge-root', REPO_ROOT);
  await runStep({ registry, runbook, runbookDir: runbookInfo.dir, experiment, step: stepMap[cmd], args: passthrough });
}

main().catch(err => {
  process.stderr.write(`forge: ${err.message}\n`);
  process.exit(1);
});
