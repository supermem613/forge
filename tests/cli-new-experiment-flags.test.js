// tests/cli-new-experiment-flags.test.js — `--control-from`, `--treatment-url-params`, `--copy-prev`.
// Exercises new flags by spawning `node lib/cli.js`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'lib', 'cli.js');
const RUNBOOK_ID = 'cli-flags-runbook';
const TEST_RUNBOOK_DIR = path.join(REPO_ROOT, 'runbooks', RUNBOOK_ID);

before(async () => {
  await fs.mkdir(TEST_RUNBOOK_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_RUNBOOK_DIR, 'manifest.json'), JSON.stringify({
    id: RUNBOOK_ID,
    version: '0.1.0',
    description: 'CLI flag test runbook',
    fixturePrefix: '_ForgeTest_cli_flags_',
    evals: [],
    defaults: { samples: 1 },
  }, null, 2) + '\n');
});

after(async () => {
  await fs.rm(TEST_RUNBOOK_DIR, { recursive: true, force: true });
});

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

async function tmpExperimentsDir(name) {
  if (!name) {
    throw new Error('tmpExperimentsDir: name is required (callers must pass the experiment name so cleanup can target it)');
  }
  const expDir = path.join(REPO_ROOT, 'experiments');
  await fs.mkdir(expDir, { recursive: true });
  return {
    cleanup: async () => {
      await fs.rm(path.join(expDir, name), { recursive: true, force: true });
    },
  };
}

test('new-experiment --treatment-url-params writes urlParams.treatment', async () => {
  const name = `_t_urlparams_${Date.now()}`; const { cleanup } = await tmpExperimentsDir(name); try {
    const r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID, '--treatment-url-params', '?fixedhubview=on']);
    assert.equal(r.code, 0, r.err);
    const expJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'experiments', name, 'experiment.json'), 'utf8'));
    assert.equal(expJson.urlParams.treatment, '?fixedhubview=on');
    assert.equal(expJson.urlParams.control, '');
  } finally {
    await cleanup(); 
  }
});

test('new-experiment --control-from copies artifacts', async () => {
  const name = `_t_controlfrom_${Date.now()}`;
  const { cleanup } = await tmpExperimentsDir(name);
  const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-controlfrom-'));
  await fs.mkdir(path.join(srcRoot, 'demo-artifact'), { recursive: true });
  await fs.writeFile(path.join(srcRoot, 'demo-artifact', 'artifact.md'), '# test\n');
  try {
    const r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID, '--control-from', srcRoot]);
    assert.equal(r.code, 0, r.err);
    const copied = await fs.readFile(
      path.join(REPO_ROOT, 'experiments', name, 'variants', 'control', 'artifacts', 'demo-artifact', 'artifact.md'),
      'utf8'
    );
    assert.match(copied, /test/);
  } finally {
    await cleanup();
    await fs.rm(srcRoot, { recursive: true, force: true });
  }
});

test('new-experiment --control-from rejects missing path', async () => {
  const name = `_t_missing_${Date.now()}`; const { cleanup } = await tmpExperimentsDir(name); try {
    const r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID, '--control-from', 'C:/no/such/path/forge-test']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /control-from/);
  } finally {
    await cleanup(); 
  }
});

test('propose --copy-prev with no marks falls back to copying control', async () => {
  const name = `_t_copyprev_${Date.now()}`; const { cleanup } = await tmpExperimentsDir(name); try {
    // First create an experiment with a control artifact.
    const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cp-'));
    await fs.mkdir(path.join(srcRoot, 'demo-artifact'), { recursive: true });
    await fs.writeFile(path.join(srcRoot, 'demo-artifact', 'artifact.md'), '# baseline\n');
    let r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID, '--control-from', srcRoot]);
    assert.equal(r.code, 0, r.err);
    r = await runCli(['propose', name, '--copy-prev']);
    assert.equal(r.code, 0, r.err);
    const copied = await fs.readFile(
      path.join(REPO_ROOT, 'experiments', name, 'variants', 'mark-1', 'artifacts', 'demo-artifact', 'artifact.md'),
      'utf8'
    );
    assert.match(copied, /baseline/);
    await fs.rm(srcRoot, { recursive: true, force: true });
  } finally {
    await cleanup(); 
  }
});

test('propose --copy-prev with prior mark copies from latest mark', async () => {
  const name = `_t_copyprev2_${Date.now()}`; const { cleanup } = await tmpExperimentsDir(name); try {
    let r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    assert.equal(r.code, 0, r.err);
    // Create mark-1 with content.
    const expRoot = path.join(REPO_ROOT, 'experiments', name);
    const m1 = path.join(expRoot, 'variants', 'mark-1', 'artifacts', 'demo-artifact');
    await fs.mkdir(m1, { recursive: true });
    await fs.writeFile(path.join(m1, 'artifact.md'), '# mark1\n');
    r = await runCli(['propose', name, '--copy-prev']);
    assert.equal(r.code, 0, r.err);
    const copied = await fs.readFile(
      path.join(expRoot, 'variants', 'mark-2', 'artifacts', 'demo-artifact', 'artifact.md'),
      'utf8'
    );
    assert.match(copied, /mark1/);
  } finally {
    await cleanup(); 
  }
});

test('runs --json emits JSON array', async () => {
  const name = `_t_runsjson_${Date.now()}`; const { cleanup } = await tmpExperimentsDir(name); try {
    let r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    assert.equal(r.code, 0, r.err);
    r = await runCli(['runs', name, '--json']);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out);
    assert.ok(Array.isArray(parsed));
  } finally {
    await cleanup(); 
  }
});

