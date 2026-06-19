// tests/cli.test.js — spawn the CLI and verify subcommand behavior.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'lib', 'cli.js');
const RUNBOOK_ID = 'cli-list-runbook';
const TEST_RUNBOOK_DIR = path.join(REPO_ROOT, 'runbooks', RUNBOOK_ID);

before(async () => {
  await fs.mkdir(TEST_RUNBOOK_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_RUNBOOK_DIR, 'manifest.json'), JSON.stringify({
    id: RUNBOOK_ID,
    version: '0.1.0',
    description: 'CLI list test runbook',
    fixturePrefix: '_ForgeTest_cli_list_',
    evals: [],
    defaults: { samples: 1 },
  }, null, 2) + '\n');
});

after(async () => {
  await fs.rm(TEST_RUNBOOK_DIR, { recursive: true, force: true });
});

function run(args, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString('utf8'));
    proc.stderr.on('data', d => stderr += d.toString('utf8'));
    proc.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI: no args prints usage and exits 0', async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /forge 0\.7\.0 - Local-first CLI harness for paired control\/variant experiments/);
  assert.match(r.stdout, /Commands:/);
  assert.match(r.stdout, /propose/);
  assert.match(r.stdout, /artifact-check/);
  assert.match(r.stdout, /schema/);
});

test('CLI: --help exits 0 with usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Commands:/);
});

test('CLI: --version prints package version', async () => {
  const r = await run(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '0.7.0');
});

test('CLI: schema emits JSON command catalog', async () => {
  const r = await run(['schema']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const schema = JSON.parse(r.stdout);
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.cliVersion, '0.7.0');
  assert.deepEqual(schema.envelope.successEnvelope, ['ok', 'command', 'data']);
  assert.deepEqual(schema.envelope.errorEnvelope, ['ok', 'command', 'error', 'code', 'hint']);
  assert.ok(schema.errorCodes.some(e => e.code === 'CONFLICT'), 'CONFLICT documented in errorCodes');
  assert.ok(schema.commands.some(command => command.path.join(' ') === 'schema'));
  assert.ok(schema.commands.some(command => command.path.join(' ') === 'doctor'));
  assert.ok(schema.commands.every(command => command.effect));
});

test('CLI: schema --summary can filter by command prefix', async () => {
  const r = await run(['schema', 'run', '--summary']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.schemaVersion, 1);
  assert.deepEqual(summary.commandPaths, ['run']);
  assert.equal(summary.commandCount, 1);
});

test('CLI: list emits a JSON envelope listing runbooks', async () => {
  const r = await run(['list']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'list');
  assert.ok(Array.isArray(parsed.data.runbooks));
  assert.ok(parsed.data.runbooks.some(rb => rb.id === RUNBOOK_ID));
});

test('CLI: errors emit a failure envelope on stdout and a human line on stderr', async () => {
  const r = await run(['bogus', 'x']);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'bogus');
  assert.match(parsed.error, /unknown command/);
  assert.equal(parsed.code, 'USAGE', 'error envelope carries a machine-branchable code');
  assert.ok(parsed.hint, 'error envelope carries a remediation hint');
  assert.match(r.stderr, /forge: unknown command/);
});

test('CLI: propose for unknown experiment errors', async () => {
  const r = await run(['propose', '_nope']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no such experiment/);
});

test('CLI: command-helper failures carry a machine-branchable code and hint', async () => {
  // cli-compare.js throws inside the dispatcher; the envelope must surface its
  // ForgeError code/hint, not degrade to code:"ERROR" / hint:null.
  const r = await run(['compare', '_nope_exp', 'mark-1', 'mark-2']);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'compare');
  assert.equal(parsed.code, 'NOT_FOUND');
  assert.ok(parsed.hint, 'helper-path error envelope carries a remediation hint');
});

test('CLI: unknown subcommand exits non-zero with usage', async () => {
  const r = await run(['bogus', 'x']);
  assert.equal(r.code, 1);
});

test('CLI: setup for unknown experiment exits non-zero', async () => {
  const r = await run(['setup', '_no-such-exp']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no such experiment/);
});
