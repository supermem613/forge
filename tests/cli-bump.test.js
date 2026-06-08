// tests/cli-bump.test.js — `forge bump <runbook> [patch|minor|major]`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpVersion, bumpRunbook } from '../lib/cli-bump.js';

test('bumpVersion: patch bumps third digit', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
});

test('bumpVersion: minor bumps second, resets patch', () => {
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
});

test('bumpVersion: major bumps first, resets others', () => {
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
});

test('bumpVersion: default is patch', () => {
  assert.equal(bumpVersion('0.5.7'), '0.5.8');
});

test('bumpVersion: rejects non-semver', () => {
  assert.throws(() => bumpVersion('1.2'), /semver/);
});

test('bumpVersion: rejects bad level', () => {
  assert.throws(() => bumpVersion('1.0.0', 'huge'), /level must be/);
});

test('bumpRunbook: rewrites manifest.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bump-'));
  const manifest = { id: 'x', version: '0.1.0', other: 'preserved' };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const r = await bumpRunbook({ runbookDir: dir, level: 'minor' });
  assert.equal(r.from, '0.1.0');
  assert.equal(r.to, '0.2.0');
  assert.equal(r.level, 'minor');
  assert.equal(r.changelog, null);
  const after = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(after.version, '0.2.0');
  assert.equal(after.other, 'preserved');
});

test('bumpRunbook: --changelog appends README line', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bump-cl-'));
  await fs.writeFile(path.join(dir, 'manifest.json'),
    JSON.stringify({ id: 'x', version: '1.0.0' }));
  await fs.writeFile(path.join(dir, 'README.md'), '# x\n\nbody.\n');
  const r = await bumpRunbook({
    runbookDir: dir, level: 'patch', changelog: 'Tweaked thing.', date: '2026-04-27',
  });
  assert.equal(r.to, '1.0.1');
  assert.equal(r.changelog.changed, true);
  assert.equal(r.changelog.line, '- v1.0.1 (2026-04-27): Tweaked thing.');
  const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /## Changelog\n\n- v1\.0\.1 \(2026-04-27\): Tweaked thing\./);
});
