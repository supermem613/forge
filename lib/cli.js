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
//   forge artifact-check <runDir>

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, waitForDoctorOk } from './doctor.js';
import { sweepStaleLocks } from './locks.js';
import { resolveSampleN } from './symmetric-n.js';
import { validateRunbook } from './cli-validate.js';
import { bumpRunbook } from './cli-bump.js';
import { scaffoldRunbook } from './cli-new-runbook.js';
import { compareVariants } from './cli-compare.js';
import { addEval } from './cli-add-eval.js';
import { archiveExperiment } from './cli-archive.js';
import { updateForge } from './cli-update.js';
import { checkRunArtifact } from './run-artifact-check.js';
import { loadForgeRegistry, listRunbooks as listRegisteredRunbooks, findRunbook } from './module-registry.js';
import { buildSchema, buildUsageText } from './command-catalog.js';
import { emit, envelope, emitError, ForgeError } from './envelope.js';
import { readExperimentConfig } from './experiment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks');
const EXPERIMENTS_DIR = path.join(REPO_ROOT, 'experiments');

// Canonical command path for the failure envelope. main() refines this as it
// dispatches so a thrown error reports the same command string the success
// envelope would have used (e.g. `config add-module`, not `config`). Module
// commands refine it through the setCommand context hook.
let activeCommand = 'forge';

async function usage(exit = 0) {
  process.stdout.write(buildUsageText(await packageInfo()));
  process.exit(exit);
}

async function packageInfo() {
  const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return {
    version: pkg.version || '0.0.0',
    description: pkg.description || 'experiment harness',
  };
}

async function packageVersion() {
  return (await packageInfo()).version;
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
  return readExperimentConfig({ experimentsDir: EXPERIMENTS_DIR, name });
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
    throw new ForgeError(`no such step: ${path.join(runbookDir, `${step}.js`)}`, { code: 'NOT_FOUND', hint: `Runbook does not implement the '${step}' step. Expected a ${step}.js script in the runbook directory.` }); 
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
  activeCommand = cmd || 'forge';
  if (cmd === '--version') {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  if (!cmd || cmd === '--help' || cmd === '-h') {
    await usage(0);
  }
  const registry = await loadForgeRegistry({ repoRoot: REPO_ROOT });

  if (cmd === 'schema') {
    const { args: sargs, flags: sflags } = parseArgs(rest);
    const schema = buildSchema({
      version: await packageVersion(),
      registry,
      commandPrefix: sargs,
      summary: !!sflags.summary,
    });
    process.stdout.write(JSON.stringify(schema) + '\n');
    return;
  }

  if (cmd === 'config') {
    const sub = rest[0];
    activeCommand = sub ? `config ${sub}` : 'config';
    const configPath = path.join(REPO_ROOT, 'forge.config.json');
    if (sub === 'init') {
      let created = false;
      try {
        await fs.access(configPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
        await fs.writeFile(configPath, JSON.stringify({ modules: [] }, null, 2) + '\n');
        created = true;
      }
      emit('config init', created ? { configPath, created: true } : { configPath });
      return;
    }
    if (sub === 'add-module') {
      const { args: cargs, flags: cflags } = parseArgs(rest.slice(1));
      const modulePath = cflags.path && cflags.path !== true ? String(cflags.path) : cargs[0];
      if (!modulePath) {
        throw new ForgeError('config add-module: --path <path> required', { code: 'USAGE', hint: 'forge config add-module --path C:\\path\\to\\module [--name <name>]' });
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
      const name = cflags.name && cflags.name !== true ? String(cflags.name) : path.basename(resolved);
      let added = false;
      if (!config.modules.some(m => path.resolve(REPO_ROOT, m.path || m) === resolved)) {
        config.modules.push({ name, path: resolved });
        added = true;
      }
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
      emit('config add-module', added
        ? { configPath, module: { name, path: resolved }, added: true }
        : { configPath, module: { name, path: resolved } });
      return;
    }
    throw new ForgeError('config: unknown subcommand (init|add-module)', { code: 'USAGE', hint: 'forge config init | forge config add-module --path <path>' });
  }

  if (cmd === 'list') {
    const rbs = await listRunbooks(registry);
    emit('list', {
      runbooks: rbs.map(r => ({
        id: r.id,
        description: r.manifest?.description ?? null,
        version: r.manifest?.version ?? null,
      })),
    });
    return;
  }

  if (cmd === 'experiments') {
    const exps = await listExperiments();
    emit('experiments', {
      experiments: exps.map(e => ({
        id: e.id,
        runbook: e.experiment?.runbook ?? null,
        notes: e.experiment?.notes ?? null,
      })),
    });
    return;
  }

  if (cmd === 'doctor') {
    const { flags: dflags } = parseArgs(rest);
    if (dflags.fix) {
      const swept = await sweepStaleLocks();
      if (swept.length) {
        process.stderr.write(`forge doctor: swept ${swept.length} stale resource lock(s)\n`);
      }
    }
    if (dflags.wait) {
      const timeoutMs = Number(dflags.timeout) > 0 ? Number(dflags.timeout) : 240_000;
      const intervalMs = Number(dflags.interval) > 0 ? Number(dflags.interval) : 5_000;
      const wait = await waitForDoctorOk({
        timeoutMs, intervalMs, fix: !!dflags.fix, extraChecks: registry.doctorChecks(),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      process.stdout.write(JSON.stringify(wait.result) + '\n');
      process.exit(wait.ok ? 0 : 1);
    }
    const result = await runDoctor({ fix: !!dflags.fix, extraChecks: registry.doctorChecks() });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'update') {
    const result = await updateForge();
    envelope('update', result, result.ok);
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'artifact-check') {
    const { args: cargs } = parseArgs(rest);
    const runDir = cargs[0] ? path.resolve(cargs[0]) : null;
    if (!runDir) {
      throw new ForgeError('artifact-check: <runDir> required', { code: 'USAGE', hint: 'forge artifact-check <runDir>' });
    }
    const result = await checkRunArtifact({ runDir });
    envelope('artifact-check', result, result.ok);
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'validate') {
    const { args: vargs } = parseArgs(rest);
    const target = vargs[0];
    const targets = target
      ? [target]
      : (await listRunbooks(registry)).map(r => r.id);
    let anyFail = false;
    const all = [];
    for (const id of targets) {
      const runbook = await findRunbook(registry, id);
      if (!runbook) {
        throw new ForgeError(`no such runbook: ${id}`, { code: 'NOT_FOUND', hint: 'Run `forge list` to see available runbooks.' });
      }
      const result = await validateRunbook({ runbookDir: runbook.dir, runbookId: id });
      all.push({ id, ...result });
      if (!result.ok) {
        anyFail = true;
      }
    }
    envelope('validate', { results: all }, !anyFail);
    process.exit(anyFail ? 1 : 0);
  }

  if (cmd === 'bump') {
    const { args: bargs, flags: bflags } = parseArgs(rest);
    const id = bargs[0];
    const level = bargs[1] || 'patch';
    if (!id) {
      throw new ForgeError('bump: <runbook> required', { code: 'USAGE', hint: 'forge bump <runbook> [patch|minor|major] [--changelog "..."]' });
    }
    const runbook = await findRunbook(registry, id);
    if (!runbook) {
      throw new ForgeError(`no such runbook: ${id}`, { code: 'NOT_FOUND', hint: 'Run `forge list` to see available runbooks.' });
    }
    const runbookDir = runbook.dir;
    const changelog = bflags.changelog && bflags.changelog !== true ? String(bflags.changelog) : null;
    const result = await bumpRunbook({ runbookDir, level, changelog });
    emit('bump', { runbook: id, ...result });
    return;
  }

  if (cmd === 'new-runbook') {
    const { args: nargs, flags: nflags } = parseArgs(rest);
    const id = nargs[0];
    if (!id) {
      throw new ForgeError('new-runbook: <id> required', { code: 'USAGE', hint: 'forge new-runbook <id> [--description "..."]' });
    }
    const result = await scaffoldRunbook({
      runbookId: id,
      runbooksDir: RUNBOOKS_DIR,
      description: nflags.description && nflags.description !== true ? String(nflags.description) : null,
    });
    emit('new-runbook', {
      runbook: id, dir: result.dir,
      catalog: result.catalog,
      nextSteps: [
        `1. Edit runbooks/${id}/manifest.json (fixturePrefix, description, and module-specific fields).`,
        `2. Add real evals via: node lib/cli.js add-eval ${id} --file <path-to-eval.json>`,
        `3. Implement runbooks/${id}/run.js (sample loop) and score.js (deterministic scoring).`,
        `4. Run: node lib/cli.js validate ${id}`,
      ],
    });
    return;
  }

  if (cmd === 'add-eval') {
    const { args: aargs, flags: aflags } = parseArgs(rest);
    const id = aargs[0];
    if (!id) {
      throw new ForgeError('add-eval: <runbook> required', { code: 'USAGE', hint: 'forge add-eval <runbook> --file <path>' });
    }
    const file = aflags.file && aflags.file !== true ? String(aflags.file) : null;
    if (!file) {
      throw new ForgeError('add-eval: --file <path> required', { code: 'USAGE', hint: 'forge add-eval <runbook> --file <path>' });
    }
    const runbook = await findRunbook(registry, id);
    if (!runbook) {
      throw new ForgeError(`no such runbook: ${id}`, { code: 'NOT_FOUND', hint: 'Run `forge list` to see available runbooks.' });
    }
    const runbookDir = runbook.dir;
    const result = await addEval({ runbookDir, sourceFile: path.resolve(file) });
    emit('add-eval', { runbook: id, ...result });
    return;
  }

  const { args, flags } = parseArgs(rest);

  if (cmd === 'new-experiment') {
    const name = args[0];
    if (!name) {
      throw new ForgeError('new-experiment: <experiment-name> required', { code: 'USAGE', hint: 'forge new-experiment <name> --runbook <runbook>' });
    }
    if (!flags.runbook) {
      throw new ForgeError('new-experiment: --runbook <runbook> required', { code: 'USAGE', hint: 'forge new-experiment <name> --runbook <runbook>' });
    }
    const runbook = String(flags.runbook);
    const runbookInfo = await findRunbook(registry, runbook);
    if (!runbookInfo) {
      throw new ForgeError(`no such runbook: ${runbook}`, { code: 'NOT_FOUND', hint: 'Run `forge list` to see available runbooks.' });
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
      throw new ForgeError(`experiment already exists: experiments/${name}/`, { code: 'CONFLICT', hint: 'Pick a new name or run `forge teardown` / `forge archive` on the existing experiment.' });
    }
    // Validate --control-from before any mutation. A bad path must not leave a
    // half-created experiment that the retry then rejects as CONFLICT.
    let controlFromSrc = null;
    if (flags['control-from'] && flags['control-from'] !== true) {
      controlFromSrc = path.resolve(String(flags['control-from']));
      let stat;
      try {
        stat = await fs.stat(controlFromSrc); 
      } catch {
        throw new ForgeError(`--control-from: no such path: ${controlFromSrc}`, { code: 'NOT_FOUND', hint: 'Pass an existing directory of control artifacts to seed the control variant.' }); 
      }
      if (!stat.isDirectory()) {
        throw new ForgeError(`--control-from: must be a directory (got ${controlFromSrc})`, { code: 'USAGE', hint: 'Pass a directory of control artifacts, not a file.' });
      }
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
    if (controlFromSrc) {
      await copyDirRec(controlFromSrc, path.join(expDir, 'variants', 'control', 'artifacts'));
    }
    emit('new-experiment', {
      experiment: name, runbook, dir: expDir,
      controlFrom: flags['control-from'] && flags['control-from'] !== true ? String(flags['control-from']) : null,
      treatmentUrlParams: expJson.urlParams ? expJson.urlParams.treatment : null,
    });
    return;
  }

  const registeredCommand = registry.commands().get(cmd);
  if (registeredCommand) {
    await registeredCommand({
      argv: rest, args, flags, registry, repoRoot: REPO_ROOT, experimentsDir: EXPERIMENTS_DIR, parseArgs,
      setCommand: (c) => {
        activeCommand = c;
      },
    });
    return;
  }

  const experiment = args[0];
  if (!experiment) {
    throw new ForgeError(`unknown command: ${cmd}`, { code: 'USAGE', hint: 'Run `forge --help` or `forge schema` to list commands.' });
  }

  if (cmd === 'runs') {
    const runs = await listRuns(experiment);
    emit('runs', { experiment, runs });
    return;
  }

  if (cmd === 'compare') {
    const a = args[1], b = args[2];
    if (!a || !b) {
      throw new ForgeError('compare: <variantA> and <variantB> required (e.g. mark-1 mark-2)', { code: 'USAGE', hint: 'forge compare <experiment> <variantA> <variantB>' });
    }
    const expDir = path.join(EXPERIMENTS_DIR, experiment);
    const result = await compareVariants({ expDir, specA: a, specB: b });
    emit('compare', result);
    return;
  }

  if (cmd === 'present') {
    const { buildPresentation } = await import('./cli-present.js');
    const pair = (typeof flags.pair === 'string') ? flags.pair : 'latest';
    const out = await buildPresentation({ experiment, pair, repoRoot: REPO_ROOT });
    emit('present', { markdown: out });
    return;
  }

  if (cmd === 'resample') {
    // Forwards to the runbook's run.js with --resample-only=<evalId>:<sample>.
    // The runbook must honor this by reusing the latest run dir for <variant>
    // and rewriting only the matching sample's bundle entries (append-only
    // for new files; overwrite-allowed for the targeted sample).
    const variant = args[1];
    if (!variant) {
      throw new ForgeError('resample: <variant> required', { code: 'USAGE', hint: 'forge resample <exp> <variant> --eval <id> --sample <N>' });
    }
    const evalId = flags.eval && flags.eval !== true ? String(flags.eval) : null;
    const sample = flags.sample && flags.sample !== true ? String(flags.sample) : null;
    if (!evalId || !sample) {
      throw new ForgeError('resample: --eval <id> and --sample <N> required', { code: 'USAGE', hint: 'forge resample <exp> <variant> --eval <id> --sample <N>' });
    }
    if (!/^\d+$/.test(sample)) {
      throw new ForgeError('resample: --sample must be a positive integer', { code: 'USAGE', hint: 'Pass a 1-based sample index, e.g. --sample 3.' });
    }
    const { json: expJsonObj } = await readExperiment(experiment);
    const runbookInfo = await findRunbook(registry, expJsonObj.runbook);
    if (!runbookInfo) {
      throw new ForgeError(`no such runbook: ${expJsonObj.runbook}`, { code: 'NOT_FOUND', hint: 'Run `forge list` to see available runbooks.' });
    }
    const passthrough = ['--variant', variant, '--resample-only', `${evalId}:${sample}`];
    // Forward the remaining run flags (e.g. --spfx-dev-server, --capture) so a
    // runbook's hard requirements still hold on a resample. The same generic
    // loop the `run` path uses (see below). --eval/--sample are already encoded
    // in --resample-only, and --variant/--forge-root are supplied explicitly, so
    // they are skipped to avoid duplicate flags reaching the runbook.
    const resampleOwned = new Set(['eval', 'sample', 'variant', 'forge-root', 'resample-only']);
    for (const [k, v] of Object.entries(flags)) {
      if (resampleOwned.has(k)) {
        continue;
      }
      passthrough.push(`--${k}`);
      if (v !== true) {
        passthrough.push(String(v));
      }
    }
    passthrough.push('--forge-root', REPO_ROOT);
    await runStep({
      registry, runbook: expJsonObj.runbook, runbookDir: runbookInfo.dir, experiment, step: 'run', args: passthrough,
    });
    emit('resample', { experiment, variant, eval: evalId, sample });
    return;
  }

  if (cmd === 'propose') {
    const { dir: expDir } = await readExperiment(experiment);
    const marks = await listMarks(expDir);
    let targetMark;
    if (flags.mark) {
      targetMark = String(flags.mark);
      if (!/^mark-\d+$/.test(targetMark)) {
        throw new ForgeError(`--mark must look like mark-<N>`, { code: 'USAGE', hint: 'Pass a mark id such as --mark mark-2.' });
      }
    } else {
      const next = (marks.length ? marks[marks.length - 1].n : 0) + 1;
      targetMark = `mark-${next}`;
    }
    // Validate user-supplied sources before creating the mark dir. A bad
    // --from/--iterate must fail atomically without leaving an empty
    // variants/<mark>/ behind or burning the next mark number on retry.
    let fromSrc = null;
    let fromStat = null;
    if (flags.from) {
      fromSrc = path.resolve(String(flags.from));
      try {
        fromStat = await fs.stat(fromSrc); 
      } catch {
        throw new ForgeError(`--from: no such path: ${fromSrc}`, { code: 'NOT_FOUND', hint: 'Pass an existing skill file or directory to import as this mark.' }); 
      }
    }
    if (flags.iterate) {
      const iterSrc = path.join(expDir, 'variants', String(flags.iterate), 'artifacts');
      try {
        await fs.access(iterSrc); 
      } catch {
        throw new ForgeError(`--iterate: no such mark: ${flags.iterate}`, { code: 'NOT_FOUND', hint: 'Run `forge runs <exp>` or check variants/ for existing mark ids.' }); 
      }
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
        throw new ForgeError(`--iterate: no such mark: ${flags.iterate}`, { code: 'NOT_FOUND', hint: 'Run `forge runs <exp>` or check variants/ for existing mark ids.' }); 
      }
      await fs.rm(artifactsDir, { recursive: true, force: true });
      await copyDirRec(src, artifactsDir);
      await fs.writeFile(
        path.join(markDir, 'NOTES.md'),
        `# ${targetMark}\n\nIterating from ${flags.iterate}.\n\n## Hypothesis\n\n(fill in: what changed, and why)\n`
      );
    } else if (flags.from) {
      const src = fromSrc;
      const stat = fromStat;
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

    emit('propose', {
      experiment, mark: targetMark, markDir, artifactsDir,
      previousMarks: marks.map(m => m.name),
    });
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
    emit('archive', result);
    return;
  }

  const stepMap = { setup: 'setup', run: 'run', score: 'score', judge: 'judge', report: 'report', teardown: 'teardown' };
  if (!stepMap[cmd]) {
    throw new ForgeError(`unknown command: ${cmd}`, { code: 'USAGE', hint: 'Run `forge --help` or `forge schema` to list commands.' });
  }

  const { json: expJson } = await readExperiment(experiment);
  const runbook = expJson.runbook;
  const runbookInfo = await findRunbook(registry, runbook);
  if (!runbookInfo) {
    throw new ForgeError(`no such runbook: ${runbook}`, { code: 'NOT_FOUND', hint: 'Run `forge list` to see available runbooks.' });
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
      throw new ForgeError(`run: <variant> required (control or mark-N)`, { code: 'USAGE', hint: 'forge run <exp> control|mark-N [--samples N]' });
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
      throw new ForgeError('run --append-control: only valid with variant=control', { code: 'USAGE', hint: 'Use --append-control only with `forge run <exp> control`.' });
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
  emit(cmd, { experiment, ...(cmd === 'run' ? { variant: args[1] } : {}) });
}

main().catch(err => {
  emitError(activeCommand, err, err && err.hint ? err.hint : null);
  process.stderr.write(`forge: ${err.message}\n`);
  process.exit(1);
});
