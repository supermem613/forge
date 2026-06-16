// tests/cli-archive.test.js — `forge archive <exp> --to <path>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'lib', 'cli.js');

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    proc.stdout.on('data', d => {
      out += d; 
    });
    proc.stderr.on('data', d => {
      err += d; 
    });
    proc.on('exit', code => resolve({ code, out, err }));
  });
}

async function makeExperiment(name) {
  const dir = path.join(REPO_ROOT, 'experiments', name);
  await fs.mkdir(path.join(dir, 'variants', 'control', 'artifacts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'variants', 'control', 'runs'), { recursive: true });
  await fs.mkdir(path.join(dir, 'variants', 'mark-1', 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'experiment.json'),
    JSON.stringify({ runbook: 'create-skill', createdAt: '2026-01-01T00:00:00.000Z', notes: 'fixture' }, null, 2));
  await fs.writeFile(path.join(dir, 'variants', 'mark-1', 'HYPOTHESIS.md'), '# h\n');
  return dir;
}

test('archive moves experiment into <to>/experiments/<exp>/<ts>/ and removes source', async () => {
  const name = `_t_arch_${Date.now()}`;
  const expDir = await makeExperiment(name);
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-archive-'));
  try {
    const r = await runCli(['archive', name, '--to', archiveRoot, '--reason', 'test', '--no-zip']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out).data;
    assert.equal(out.action, 'archive');
    assert.equal(out.experiment, name);
    assert.equal(out.runbook, 'create-skill');
    assert.equal(out.keepShell, false);
    assert.equal(out.zipRuns, false);
    assert.equal(out.reason, 'test');
    // Source gone.
    await assert.rejects(fs.access(expDir));
    // Archive populated.
    const expJson = JSON.parse(await fs.readFile(path.join(out.archiveDirAbsPath, 'experiment.json'), 'utf8'));
    assert.equal(expJson.runbook, 'create-skill');
    const manifest = JSON.parse(await fs.readFile(path.join(out.archiveDirAbsPath, 'ARCHIVE.json'), 'utf8'));
    assert.equal(manifest.experiment, name);
    assert.equal(manifest.runbook, 'create-skill');
    assert.equal(manifest.reason, 'test');
    // mark-1 moved too.
    await fs.access(path.join(out.archiveDirAbsPath, 'variants', 'mark-1', 'HYPOTHESIS.md'));
  } finally {
    await fs.rm(expDir, { recursive: true, force: true });
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('archive --keep-shell re-stages experiment.json and bare control dirs', async () => {
  const name = `_t_arch_keep_${Date.now()}`;
  const expDir = await makeExperiment(name);
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-archive-'));
  try {
    const r = await runCli(['archive', name, '--to', archiveRoot, '--keep-shell', '--no-zip']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out).data;
    assert.equal(out.keepShell, true);
    // Source restored as ready-to-run shell.
    const restored = JSON.parse(await fs.readFile(path.join(expDir, 'experiment.json'), 'utf8'));
    assert.equal(restored.runbook, 'create-skill');
    await fs.access(path.join(expDir, 'variants', 'control', 'artifacts'));
    await fs.access(path.join(expDir, 'variants', 'control', 'runs'));
    // mark-1 NOT restored.
    await assert.rejects(fs.access(path.join(expDir, 'variants', 'mark-1')));
  } finally {
    await fs.rm(expDir, { recursive: true, force: true });
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('archive --dry-run does not touch source or archive', async () => {
  const name = `_t_arch_dry_${Date.now()}`;
  const expDir = await makeExperiment(name);
  const archiveRoot = path.join(os.tmpdir(), `forge-archive-dry-${Date.now()}`); // does NOT exist
  try {
    const r = await runCli(['archive', name, '--to', archiveRoot, '--dry-run', '--no-zip']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out).data;
    assert.equal(out.dryRun, true);
    assert.ok(out.archiveDirAbsPath.startsWith(path.resolve(archiveRoot)));
    // Source still intact.
    await fs.access(path.join(expDir, 'experiment.json'));
    // Archive root NOT created.
    await assert.rejects(fs.access(archiveRoot));
  } finally {
    await fs.rm(expDir, { recursive: true, force: true });
  }
});

test('archive without --to and without env var fails', async () => {
  const name = `_t_arch_noto_${Date.now()}`;
  const expDir = await makeExperiment(name);
  try {
    const r = await runCli(['archive', name, '--no-zip'], { FORGE_ARCHIVE_ROOT: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--to/);
  } finally {
    await fs.rm(expDir, { recursive: true, force: true }); 
  }
});

test('archive uses FORGE_ARCHIVE_ROOT env when --to omitted', async () => {
  const name = `_t_arch_env_${Date.now()}`;
  const expDir = await makeExperiment(name);
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-archive-env-'));
  try {
    const r = await runCli(['archive', name, '--no-zip'], { FORGE_ARCHIVE_ROOT: archiveRoot });
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out).data;
    assert.ok(out.archiveDirAbsPath.startsWith(path.resolve(archiveRoot)));
  } finally {
    await fs.rm(expDir, { recursive: true, force: true });
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('archive rejects nonexistent experiment', async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-archive-'));
  try {
    const r = await runCli(['archive', `_t_nope_${Date.now()}`, '--to', archiveRoot, '--no-zip']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no such experiment/);
  } finally {
    await fs.rm(archiveRoot, { recursive: true, force: true }); 
  }
});

test('archive rejects path-traversal experiment names', async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-archive-'));
  try {
    const r = await runCli(['archive', '../etc', '--to', archiveRoot, '--no-zip']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /invalid experiment name/);
  } finally {
    await fs.rm(archiveRoot, { recursive: true, force: true }); 
  }
});

test('archive rejects --to inside the source experiment dir', async () => {
  const name = `_t_arch_nest_${Date.now()}`;
  const expDir = await makeExperiment(name);
  try {
    const r = await runCli(['archive', name, '--to', path.join(expDir, 'archive'), '--no-zip']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /inside the source/);
  } finally {
    await fs.rm(expDir, { recursive: true, force: true }); 
  }
});

test('archive zips per-run dirs by default', async () => {
  const name = `_t_arch_zip_${Date.now()}`;
  const expDir = await makeExperiment(name);
  // Add a run dir with content so zipping has something to do.
  const runDir = path.join(expDir, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'sample-1.json'), JSON.stringify({ x: 1 }));
  await fs.writeFile(path.join(runDir, 'sample-2.json'), JSON.stringify({ x: 2 }));
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-archive-zip-'));
  try {
    const r = await runCli(['archive', name, '--to', archiveRoot]);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out).data;
    assert.equal(out.zipRuns, true);
    assert.ok(Array.isArray(out.zippedRuns), 'zippedRuns array present');
    assert.ok(out.zippedRuns.length >= 1, 'at least one run zipped');
    // The zip exists, the source run dir does not.
    const zipPath = path.join(out.archiveDirAbsPath, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000.zip');
    await fs.access(zipPath);
    await assert.rejects(fs.access(path.join(out.archiveDirAbsPath, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000')));
    const zipStat = await fs.stat(zipPath);
    assert.ok(zipStat.size > 0);
  } finally {
    await fs.rm(expDir, { recursive: true, force: true });
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});
