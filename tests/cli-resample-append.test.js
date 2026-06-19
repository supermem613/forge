// tests/cli-resample-append.test.js — `forge resample` and `forge run --append-control` dispatcher behavior.
// Validates flag forwarding + arg validation; runbook-side honoring is
// implemented in the runbook sample-loop refactor.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'lib', 'cli.js');
const RUNBOOK_ID = 'cli-resample-runbook';
const TEST_RUNBOOK_DIR = path.join(REPO_ROOT, 'runbooks', RUNBOOK_ID);

before(async () => {
  await fs.mkdir(TEST_RUNBOOK_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_RUNBOOK_DIR, 'manifest.json'), JSON.stringify({
    id: RUNBOOK_ID,
    version: '0.1.0',
    description: 'CLI resample test runbook',
    fixturePrefix: '_ForgeTest_cli_resample_',
    evals: [],
    defaults: { samples: 1 },
  }, null, 2) + '\n');
  // A minimal run.js that records the argv it was spawned with, so a test can
  // assert exactly which flags `forge resample` forwarded to the runbook.
  await fs.writeFile(path.join(TEST_RUNBOOK_DIR, 'run.js'),
    `import { promises as fs } from 'node:fs';\n` +
    `import path from 'node:path';\n` +
    `const expIdx = process.argv.indexOf('--experiment');\n` +
    `const exp = process.argv[expIdx + 1];\n` +
    `const out = path.join(process.cwd(), 'experiments', exp, 'argv.json');\n` +
    `await fs.writeFile(out, JSON.stringify(process.argv.slice(2)));\n`);
});

after(async () => {
  await fs.rm(TEST_RUNBOOK_DIR, { recursive: true, force: true });
});

function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function tmpExperimentsSnapshot(name) {
  const expDir = path.join(REPO_ROOT, 'experiments');
  await fs.mkdir(expDir, { recursive: true });
  return {
    cleanup: async () => {
      if (name) {
        await fs.rm(path.join(expDir, name), { recursive: true, force: true });
      }
    },
  };
}

test('resample: requires --eval and --sample', async () => {
  const name = `_t_resample_${Date.now()}`; const { cleanup } = await tmpExperimentsSnapshot(name); try {
    let r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    assert.equal(r.code, 0, r.err);
    r = await runCli(['resample', name, 'mark-1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--eval.*--sample/);
  } finally {
    await cleanup(); 
  }
});

test('resample: --sample must be a positive integer', async () => {
  const name = `_t_resamp2_${Date.now()}`; const { cleanup } = await tmpExperimentsSnapshot(name); try {
    await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    const r = await runCli(['resample', name, 'mark-1', '--eval', 'e1', '--sample', 'abc']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /positive integer/);
  } finally {
    await cleanup(); 
  }
});

test('resample: missing variant errors', async () => {
  const name = `_t_resamp3_${Date.now()}`; const { cleanup } = await tmpExperimentsSnapshot(name); try {
    await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    const r = await runCli(['resample', name, '--eval', 'e1', '--sample', '1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /<variant> required/);
  } finally {
    await cleanup(); 
  }
});

test('resample: forwards run flags but not --eval/--sample', async () => {
  const name = `_t_resampfwd_${Date.now()}`; const { cleanup } = await tmpExperimentsSnapshot(name); try {
    let r = await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    assert.equal(r.code, 0, r.err);
    r = await runCli(['resample', name, 'mark-1', '--eval', 'e1', '--sample', '3',
      '--spfx-dev-server', 'https://localhost:46435/', '--capture']);
    assert.equal(r.code, 0, r.err);
    const argv = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, 'experiments', name, 'argv.json'), 'utf8'));
    // The single-sample contract rides in --resample-only; --eval/--sample are
    // NOT forwarded as run flags.
    assert.ok(argv.includes('--resample-only'), 'forwards --resample-only');
    assert.equal(argv[argv.indexOf('--resample-only') + 1], 'e1:3');
    assert.ok(!argv.includes('--eval'), '--eval is not forwarded');
    assert.ok(!argv.includes('--sample'), '--sample is not forwarded');
    // Remaining run flags (the runbook may hard-require them) ARE forwarded.
    assert.ok(argv.includes('--spfx-dev-server'), 'forwards --spfx-dev-server');
    assert.equal(argv[argv.indexOf('--spfx-dev-server') + 1], 'https://localhost:46435/');
    assert.ok(argv.includes('--capture'), 'forwards --capture');
    assert.ok(argv.includes('--variant'), 'forwards --variant');
    assert.equal(argv[argv.indexOf('--variant') + 1], 'mark-1');
  } finally {
    await cleanup();
  }
});

test('run --append-control: rejects non-control variant', async () => {
  const name = `_t_appendctl_${Date.now()}`; const { cleanup } = await tmpExperimentsSnapshot(name); try {
    await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    const r = await runCli(['run', name, 'mark-1', '--append-control', '--samples', '1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /only valid with variant=control/);
  } finally {
    await cleanup(); 
  }
});

test('compare: requires two variant specs', async () => {
  const name = `_t_cmpargs_${Date.now()}`; const { cleanup } = await tmpExperimentsSnapshot(name); try {
    await runCli(['new-experiment', name, '--runbook', RUNBOOK_ID]);
    const r = await runCli(['compare', name, 'mark-1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /<variantA> and <variantB> required/);
  } finally {
    await cleanup(); 
  }
});

