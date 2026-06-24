// lib/cli-update.js — `forge update`.
//
// Self-update: in the forge repo root, run
//   1. git pull --ff-only
//   2. npm install --no-audit --no-fund
//   3. npm run build (if a build script is present)
//   4. npm link
// Then for every git submodule under lib/vendor/*, run
//   1. git checkout main && git pull --ff-only
//   2. npm install --no-audit --no-fund
//   3. npm run build (if present)
//
// Modeled after rotunda's `update` command. Halts on first failure.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'lib', 'vendor');

// Invoke without shell: true. Passing an args array together with shell: true
// is deprecated under Node DEP0190 and unsafe. On Windows we still need cmd.exe to
// resolve PATH and .cmd/.bat shims such as git and npm, so wrap the command in
// an explicit `cmd.exe /d /s /c` argv. Elsewhere the binary is launched directly.
function winInvocation(cmd, args) {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] };
  }
  return { command: cmd, args };
}

function run(cmd, args, cwd, { timeoutMs = 600_000 } = {}) {
  const { command, args: invokeArgs } = winInvocation(cmd, args);
  const r = spawnSync(command, invokeArgs, {
    cwd, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8',
  });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

async function hasScript(pkgDir, scriptName) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts && pkg.scripts[scriptName]);
  } catch {
    return false; 
  }
}

async function listSubmodules() {
  // Trust .gitmodules if present, else fall back to scanning lib/vendor/*.
  const gm = path.join(REPO_ROOT, '.gitmodules');
  try {
    const txt = await fs.readFile(gm, 'utf8');
    const paths = [];
    for (const m of txt.matchAll(/^\s*path\s*=\s*(\S+)\s*$/gm)) {
      paths.push(m[1]);
    }
    if (paths.length) {
      return paths.map(p => path.resolve(REPO_ROOT, p));
    }
  } catch { /* fall through */ }
  try {
    const ents = await fs.readdir(VENDOR_ROOT, { withFileTypes: true });
    return ents.filter(e => e.isDirectory()).map(e => path.join(VENDOR_ROOT, e.name));
  } catch {
    return []; 
  }
}

export function gitPullMadeNoChanges(output) {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

function step({ title, cmd, args, cwd, log, optional = false, runCommand = run }) {
  log(`  → ${title}`);
  const r = runCommand(cmd, args, cwd);
  if (!r.ok) {
    if (optional) {
      log(`    (skipped: ${r.err.split('\n')[0] || `exit ${r.code}`})`);
      return { ok: true, skipped: true };
    }
    log(`    ✗ FAILED (exit ${r.code})`);
    if (r.out) {
      log(`    stdout: ${r.out.split('\n').slice(-5).join('\n            ')}`);
    }
    if (r.err) {
      log(`    stderr: ${r.err.split('\n').slice(-5).join('\n            ')}`);
    }
    return { ok: false, error: r.err || `exit ${r.code}` };
  }
  // Trim noisy npm install / git output to the last meaningful line.
  const tail = (r.out || r.err).split('\n').filter(Boolean).slice(-1)[0];
  if (tail) {
    log(`    ${tail.slice(0, 100)}`);
  }
  return { ok: true, noChanges: title.startsWith('git pull') && gitPullMadeNoChanges(`${r.out}\n${r.err}`) };
}

export async function updateForge({
  log = (m) => process.stderr.write(`${m}\n`),
  runCommand = run,
  getSubmodules = listSubmodules,
} = {}) {
  log(`forge update — repo: ${REPO_ROOT}`);

  // 1. Forge itself.
  log(`\n[1/2] forge`);
  const pullStep = { title: 'git pull --ff-only', cmd: 'git', args: ['pull', '--ff-only'], cwd: REPO_ROOT };
  const pullResult = step({ ...pullStep, log, runCommand });
  if (!pullResult.ok) {
    return { ok: false, where: 'forge', step: pullStep.title, error: pullResult.error };
  }
  if (pullResult.noChanges) {
    log('    Already up to date; skipping install, build, and link.');
  } else {
    const forgeSteps = [
      { title: 'npm install', cmd: 'npm', args: ['install', '--no-audit', '--no-fund'], cwd: REPO_ROOT },
    ];
    if (await hasScript(REPO_ROOT, 'build')) {
      forgeSteps.push({ title: 'npm run build', cmd: 'npm', args: ['run', 'build'], cwd: REPO_ROOT });
    }
    forgeSteps.push({ title: 'npm link', cmd: 'npm', args: ['link'], cwd: REPO_ROOT });
    for (const s of forgeSteps) {
      const r = step({ ...s, log, runCommand });
      if (!r.ok) {
        return { ok: false, where: 'forge', step: s.title, error: r.error };
      }
    }
  }

  // 2. Every submodule under lib/vendor.
  const submodules = await getSubmodules();
  log(`\n[2/2] submodules (${submodules.length})`);
  // Make sure init+sync runs before per-module pulls so a fresh clone or a
  // submodule URL change doesn't trip per-submodule git pulls.
  step({ title: 'git submodule sync --recursive', cmd: 'git', args: ['submodule', 'sync', '--recursive'], cwd: REPO_ROOT, log, optional: true, runCommand });
  step({ title: 'git submodule update --init --recursive', cmd: 'git', args: ['submodule', 'update', '--init', '--recursive'], cwd: REPO_ROOT, log, runCommand });

  const subResults = [];
  for (const subDir of submodules) {
    const name = path.relative(REPO_ROOT, subDir).replace(/\\/g, '/');
    log(`\n  ◆ ${name}`);
    let subOk = true;
    const checkoutStep = { title: 'git checkout main', cmd: 'git', args: ['checkout', 'main'], cwd: subDir, optional: true };
    step({ ...checkoutStep, log, runCommand });
    const pullStep = { title: 'git pull --ff-only', cmd: 'git', args: ['pull', '--ff-only'], cwd: subDir };
    const pullResult = step({ ...pullStep, log, runCommand });
    if (!pullResult.ok) {
      subResults.push({ submodule: name, ok: false, step: pullStep.title, error: pullResult.error });
      subOk = false;
    } else if (pullResult.noChanges) {
      log('    Already up to date; skipping install and build.');
    } else {
      const subSteps = [
        { title: 'npm install', cmd: 'npm', args: ['install', '--no-audit', '--no-fund'], cwd: subDir },
      ];
      if (await hasScript(subDir, 'build')) {
        subSteps.push({ title: 'npm run build', cmd: 'npm', args: ['run', 'build'], cwd: subDir });
      }
      for (const s of subSteps) {
        const r = step({ ...s, log, runCommand });
        if (!r.ok) {
          subResults.push({ submodule: name, ok: false, step: s.title, error: r.error });
          subOk = false;
          break;
        }
      }
    }
    if (subOk) {
      subResults.push({ submodule: name, ok: true });
    }
  }

  const failed = subResults.filter(r => !r.ok);
  if (failed.length) {
    return { ok: false, where: 'submodules', failed, succeeded: subResults.filter(r => r.ok) };
  }

  log(`\n✓ forge update OK — ${submodules.length} submodule(s) refreshed`);
  return { ok: true, submodules: subResults };
}
