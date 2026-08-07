// tests/cli-pack-analysis.test.js — pack-analysis + verify-analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from '../lib/zip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'lib', 'cli.js');

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => {
      out += d;
    });
    proc.stderr.on('data', d => {
      err += d;
    });
    proc.on('exit', code => resolve({ code, out, err }));
  });
}

async function write(p, body) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
}

async function makeRunbook(id) {
  const dir = path.join(REPO_ROOT, 'runbooks', id);
  await write(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    version: '0.0.1',
    description: 'fixture runbook for pack-analysis tests',
    evals: ['evals/sample.json'],
  }, null, 2));
  await write(path.join(dir, 'README.md'), `# ${id}\n`);
  await write(path.join(dir, 'evals', 'sample.json'), JSON.stringify({
    id: 'sample',
    criteria: { must: ['does the thing'], should: [], could: [] },
  }, null, 2));
  return dir;
}

async function makeExperiment(name, runbookId) {
  const dir = path.join(REPO_ROOT, 'experiments', name);
  await write(path.join(dir, 'experiment.json'), JSON.stringify({
    runbook: runbookId,
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: 'pack fixture',
  }, null, 2));
  await write(path.join(dir, 'variants', 'control', 'artifacts', '.keep'), '');
  await write(path.join(dir, 'variants', 'mark-1', 'HYPOTHESIS.md'), '# h\n');
  await write(path.join(dir, 'variants', 'mark-1', 'NOTES.md'), 'n\n');

  const ctlRun = path.join(dir, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000');
  const txRun = path.join(dir, 'variants', 'mark-1', 'runs', '2026-01-01T00-00-00-000');
  for (const run of [ctlRun, txRun]) {
    await write(path.join(run, 'manifest.json'), JSON.stringify({ experiment: name, ts: 't' }));
    await write(path.join(run, 'transcript.json'), JSON.stringify({ entries: [] }));
    await write(path.join(run, 'results.json'), JSON.stringify({ samples: 2 }));
    await write(path.join(run, 'score.json'), JSON.stringify({ overallPct: 50 }));
    await write(path.join(run, 'REPORT.json'), JSON.stringify({ headline: { overall: 0 } }));
    await write(path.join(run, 'REPORT.md'), '# report\n');
    await write(path.join(run, 'judge-verdicts', 'sample-sample1.json'), JSON.stringify({ pass: true }));
    // Bulk that must be excluded from audit packs.
    await write(path.join(run, 'captures', 'big.json'), 'x'.repeat(50_000));
    await write(path.join(run, 'turn1', 'sample-sample1.json'), 'y'.repeat(20_000));
    await write(path.join(run, 'judge-prompts', 'sample-sample1.md'), '# prompt\n'.repeat(100));
  }
  // Variant artifact bulk.
  await write(path.join(dir, 'variants', 'mark-1', 'artifacts', 'blob.bin'), Buffer.alloc(10_000, 7));
  return dir;
}

async function cleanup(name, runbookId, zipPath) {
  await fs.rm(path.join(REPO_ROOT, 'experiments', name), { recursive: true, force: true });
  if (runbookId) {
    await fs.rm(path.join(REPO_ROOT, 'runbooks', runbookId), { recursive: true, force: true });
  }
  if (zipPath) {
    await fs.rm(zipPath, { force: true });
  }
}

test('pack-analysis is non-destructive, excludes bulk, and verify-analysis passes', async () => {
  const rb = `_t_pack_rb_${Date.now()}`;
  const name = `_t_pack_${Date.now()}`;
  const zipPath = path.join(os.tmpdir(), `${name}-audit.zip`);
  await makeRunbook(rb);
  const expDir = await makeExperiment(name, rb);
  try {
    const r = await runCli(['pack-analysis', name, '--to', zipPath]);
    assert.equal(r.code, 0, r.err + r.out);
    const env = JSON.parse(r.out);
    assert.equal(env.ok, true);
    assert.equal(env.command, 'pack-analysis');
    assert.equal(env.data.experiment, name);
    assert.equal(env.data.claimClass, 'audit');
    assert.ok(env.data.includedFiles > 0);
    assert.ok(env.data.excludedBytes > env.data.includedBytes, 'excluded bulk dominates');
    assert.ok(env.data.zipBytes > 0);

    // Source still present.
    await fs.access(path.join(expDir, 'experiment.json'));
    await fs.access(path.join(expDir, 'variants', 'mark-1', 'runs', '2026-01-01T00-00-00-000', 'captures', 'big.json'));

    const buf = await fs.readFile(zipPath);
    const entries = readZipEntries(buf);
    assert.ok(entries.has('ANALYSIS.json'));
    assert.ok(entries.has('experiment/experiment.json'));
    assert.ok(entries.has('runbook/manifest.json'));
    assert.ok(entries.has('experiment/variants/mark-1/HYPOTHESIS.md'));
    assert.ok(entries.has('experiment/variants/mark-1/runs/2026-01-01T00-00-00-000/score.json'));
    assert.ok(entries.has('experiment/variants/mark-1/runs/2026-01-01T00-00-00-000/judge-verdicts/sample-sample1.json'));

    // Forbidden bulk absent.
    for (const key of entries.keys()) {
      assert.equal(key.includes('/captures/'), false, `no captures: ${key}`);
      assert.equal(/\/turn\d+\//i.test(key), false, `no turns: ${key}`);
      assert.equal(key.includes('/judge-prompts/'), false, `no prompts: ${key}`);
      assert.equal(key.includes('/artifacts/'), false, `no artifacts: ${key}`);
    }

    const analysis = JSON.parse(entries.get('ANALYSIS.json').toString('utf8'));
    assert.equal(analysis.schemaVersion, 1);
    assert.equal(analysis.claimClass, 'audit');
    assert.equal(analysis.selectionPolicy, 'audit-v1');
    assert.ok(analysis.runbook.contentHash);
    assert.ok(analysis.excluded.some(e => e.reason === 'captures-excluded-by-default'));

    const v = await runCli(['verify-analysis', zipPath]);
    assert.equal(v.code, 0, v.err + v.out);
    const venv = JSON.parse(v.out);
    assert.equal(venv.ok, true);
    assert.equal(venv.data.ok, true);
    assert.equal(venv.data.experiment, name);
  } finally {
    await cleanup(name, rb, zipPath);
  }
});

test('pack-analysis --dry-run does not write zip or touch source', async () => {
  const rb = `_t_pack_dry_rb_${Date.now()}`;
  const name = `_t_pack_dry_${Date.now()}`;
  const zipPath = path.join(os.tmpdir(), `${name}-audit.zip`);
  await makeRunbook(rb);
  const expDir = await makeExperiment(name, rb);
  try {
    const r = await runCli(['pack-analysis', name, '--to', zipPath, '--dry-run']);
    assert.equal(r.code, 0, r.err + r.out);
    const env = JSON.parse(r.out);
    assert.equal(env.data.dryRun, true);
    await assert.rejects(fs.access(zipPath));
    await fs.access(path.join(expDir, 'experiment.json'));
  } finally {
    await cleanup(name, rb, zipPath);
  }
});

test('pack-analysis rejects unsupported claim class', async () => {
  const rb = `_t_pack_cls_rb_${Date.now()}`;
  const name = `_t_pack_cls_${Date.now()}`;
  const zipPath = path.join(os.tmpdir(), `${name}-audit.zip`);
  await makeRunbook(rb);
  await makeExperiment(name, rb);
  try {
    const r = await runCli(['pack-analysis', name, '--to', zipPath, '--depth', 'full']);
    assert.notEqual(r.code, 0);
    assert.match(r.out + r.err, /not supported|deferred|audit/i);
  } finally {
    await cleanup(name, rb, zipPath);
  }
});

test('pack-analysis leaves source when destination exists (conflict)', async () => {
  const rb = `_t_pack_cf_rb_${Date.now()}`;
  const name = `_t_pack_cf_${Date.now()}`;
  const zipPath = path.join(os.tmpdir(), `${name}-audit.zip`);
  await makeRunbook(rb);
  const expDir = await makeExperiment(name, rb);
  await fs.writeFile(zipPath, 'occupied');
  try {
    const r = await runCli(['pack-analysis', name, '--to', zipPath]);
    assert.notEqual(r.code, 0);
    await fs.access(path.join(expDir, 'experiment.json'));
  } finally {
    await cleanup(name, rb, zipPath);
  }
});

test('verify-analysis fails on tampered zip', async () => {
  const rb = `_t_pack_tam_rb_${Date.now()}`;
  const name = `_t_pack_tam_${Date.now()}`;
  const zipPath = path.join(os.tmpdir(), `${name}-audit.zip`);
  await makeRunbook(rb);
  await makeExperiment(name, rb);
  try {
    const r = await runCli(['pack-analysis', name, '--to', zipPath]);
    assert.equal(r.code, 0, r.err + r.out);
    // Corrupt trailing bytes enough to break EOCD scan or crc.
    const fh = await fs.open(zipPath, 'r+');
    try {
      const st = await fh.stat();
      await fh.write(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, Math.max(0, st.size - 8));
    } finally {
      await fh.close();
    }
    const v = await runCli(['verify-analysis', zipPath]);
    assert.notEqual(v.code, 0);
  } finally {
    await cleanup(name, rb, zipPath);
  }
});
