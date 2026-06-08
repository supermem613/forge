// tests/cli-validate.test.js — `forge validate <runbook>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRunbook, formatValidateResult } from '../lib/cli-validate.js';

async function tmpRunbook(name, manifestPatch = {}, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-validate-'));
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'evals'), { recursive: true });
  await fs.mkdir(path.join(dir, 'fixtures'), { recursive: true });
  const manifest = {
    id: name,
    version: '0.1.0',
    description: 'test',
    fixturePrefix: '_ForgeTest_x_',
    evals: ['evals/01.json'],
    defaults: { samples: 1 },
    ...manifestPatch,
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (opts.readme !== null) {
    await fs.writeFile(path.join(dir, 'README.md'), opts.readme || '# Test runbook\n');
  }
  if (opts.evalContent !== null) {
    const ev = opts.evalContent || {
      id: 'e1', criteria: { must: [{ text: 'produces a useful answer' }], should: [], could: [] },
    };
    await fs.writeFile(path.join(dir, 'evals', '01.json'), JSON.stringify(ev, null, 2));
  }
  for (const step of ['setup.js', 'run.js', 'score.js', 'judge.js', 'report.js', 'teardown.js']) {
    if (!(opts.skipShims || []).includes(step)) {
      await fs.writeFile(path.join(dir, step), opts.stepContent?.[step] || '// shim\n');
    }
  }
  return { root, dir };
}

test('validate: clean runbook returns ok', async () => {
  const { dir } = await tmpRunbook('valid');
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('validate: id mismatch flagged', async () => {
  const { dir } = await tmpRunbook('mismatch', { id: 'wrong' });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /manifest\.id="wrong"/);
});

test('validate: bad semver flagged', async () => {
  const { dir } = await tmpRunbook('badver', { version: '1.0' });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /semver/);
});

test('validate: bad fixturePrefix flagged', async () => {
  const { dir } = await tmpRunbook('badfix', { fixturePrefix: 'OtherPrefix_' });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /fixturePrefix/);
});

test('validate: missing eval file flagged', async () => {
  const { dir } = await tmpRunbook('missingeval', {}, { evalContent: null });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /01\.json/);
});

test('validate: missing must tier flagged', async () => {
  const { dir } = await tmpRunbook('badeval', {}, {
    evalContent: { id: 'e1', criteria: { should: [], could: [] } },
  });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /criteria\.must/);
});

test('validate: empty must tier is a warning', async () => {
  const { dir } = await tmpRunbook('warn', {}, {
    evalContent: { id: 'e1', criteria: { must: [], should: [], could: [] } },
  });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('validate: missing README flagged', async () => {
  const { dir } = await tmpRunbook('noreadme', {}, { readme: null });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /README\.md/);
});

test('validate: vague and duplicate criteria are warnings', async () => {
  const { dir } = await tmpRunbook('vague', {}, {
    evalContent: {
      id: 'e1',
      criteria: {
        must: [{ text: 'ok' }, { text: 'ok' }],
        should: [{ note: 'missing text' }],
        could: [],
      },
    },
  });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.warnings.join('\n'), /very short/);
  assert.match(r.warnings.join('\n'), /duplicate/);
  assert.match(r.warnings.join('\n'), /no text field/);
});

test('validate: missing step shim flagged', async () => {
  const { dir } = await tmpRunbook('noshim', {}, { skipShims: ['judge.js'] });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /judge\.js/);
});

test('validate: bulky step shim is a warning', async () => {
  const lines = Array.from({ length: 121 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const { dir } = await tmpRunbook('fatshim', {}, {
    stepContent: { 'judge.js': lines },
  });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.warnings.join('\n'), /judge\.js has 121 meaningful lines/);
});

test('validate: missing fixture file flagged', async () => {
  const { dir } = await tmpRunbook('nofix', {
    fixtures: { docLib: { name: 'x', files: ['fixtures/missing.docx'] } },
  });
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /missing\.docx/);
});

test('validate: large fixture file is a warning', async () => {
  const { dir } = await tmpRunbook('bigfix', {
    fixtures: { docLib: { name: 'x', files: ['fixtures/big.bin'] } },
  });
  await fs.writeFile(path.join(dir, 'fixtures', 'big.bin'), Buffer.alloc(5 * 1024 * 1024));
  const r = await validateRunbook({ runbookDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.warnings.join('\n'), /large fixtures slow setup/);
});

test('formatValidateResult: ok with no warnings', () => {
  const out = formatValidateResult({ ok: true, errors: [], warnings: [] }, { runbookId: 'rb' });
  assert.match(out, /\[rb\] OK/);
});

test('formatValidateResult: failure prints errors', () => {
  const out = formatValidateResult({ ok: false, errors: ['bad'], warnings: ['warn'] }, { runbookId: 'rb' });
  assert.match(out, /FAIL/);
  assert.match(out, /bad/);
  assert.match(out, /warn/);
});
