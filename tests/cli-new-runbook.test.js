// tests/cli-new-runbook.test.js — `forge new-runbook <id>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldRunbook } from '../lib/cli-new-runbook.js';
import { validateRunbook } from '../lib/cli-validate.js';

async function tmpRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'forge-newrb-'));
}

test('scaffoldRunbook: creates manifest, evals, shims', async () => {
  const root = await tmpRoot();
  const r = await scaffoldRunbook({ runbookId: 'demo', runbooksDir: root });
  assert.match(r.dir, /demo$/);
  for (const f of ['manifest.json', 'README.md', 'setup.js', 'run.js', 'score.js', 'judge.js', 'report.js', 'teardown.js', 'evals/01-example.json']) {
    await fs.access(path.join(r.dir, f));
  }
});

test('scaffoldRunbook: result passes validate (with warnings)', async () => {
  const root = await tmpRoot();
  const r = await scaffoldRunbook({ runbookId: 'demo', runbooksDir: root });
  const v = await validateRunbook({ runbookDir: r.dir });
  // Scaffolded runbook must pass validate. May have warnings (e.g., no fixtures).
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('scaffoldRunbook: rejects non-kebab id', async () => {
  const root = await tmpRoot();
  await assert.rejects(scaffoldRunbook({ runbookId: 'BadID', runbooksDir: root }), /kebab-case/);
  await assert.rejects(scaffoldRunbook({ runbookId: '1abc', runbooksDir: root }), /kebab-case/);
  await assert.rejects(scaffoldRunbook({ runbookId: 'has spaces', runbooksDir: root }), /kebab-case/);
});

test('scaffoldRunbook: refuses to overwrite existing dir', async () => {
  const root = await tmpRoot();
  await scaffoldRunbook({ runbookId: 'demo', runbooksDir: root });
  await assert.rejects(scaffoldRunbook({ runbookId: 'demo', runbooksDir: root }), /already exists/);
});

test('scaffoldRunbook: applies description override', async () => {
  const root = await tmpRoot();
  const r = await scaffoldRunbook({
    runbookId: 'demo', runbooksDir: root,
    description: 'Custom desc',
  });
  const m = JSON.parse(await fs.readFile(path.join(r.dir, 'manifest.json'), 'utf8'));
  assert.equal(m.description, 'Custom desc');
  assert.equal(m.fixturePrefix, '_ForgeTest_demo_');
});

test('scaffoldRunbook: requires id and runbooksDir', async () => {
  await assert.rejects(scaffoldRunbook({ runbooksDir: '/tmp/x' }), /runbookId required/);
  await assert.rejects(scaffoldRunbook({ runbookId: 'demo' }), /runbooksDir required/);
});
