// tests/cli-compare.test.js — `forge compare <exp> <a> <b>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVariants, formatCompare } from '../lib/cli-compare.js';

async function tmpExp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cmp-'));
  await fs.mkdir(path.join(root, 'variants'), { recursive: true });
  return root;
}

async function writeRun(expDir, variant, ts, report) {
  const runDir = path.join(expDir, 'variants', variant, 'runs', ts);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'REPORT.json'), JSON.stringify(report, null, 2));
  return runDir;
}

test('compareVariants: latest runs of two marks', async () => {
  const expDir = await tmpExp();
  await writeRun(expDir, 'mark-1', '2026-01-01', { headline: { overall: 50, tiers: { must: 60, should: 40, could: 20 } } });
  await writeRun(expDir, 'mark-2', '2026-01-02', { headline: { overall: 65, tiers: { must: 80, should: 50, could: 25 } } });
  const r = await compareVariants({ expDir, specA: 'mark-1', specB: 'mark-2' });
  assert.equal(r.headline.overall.a, 50);
  assert.equal(r.headline.overall.b, 65);
  assert.equal(r.headline.overall.delta, 15);
  assert.equal(r.headline.tiers.must.delta, 20);
});

test('compareVariants: explicit timestamp', async () => {
  const expDir = await tmpExp();
  await writeRun(expDir, 'mark-1', '2026-01-01', { headline: { overall: 30, tiers: {} } });
  await writeRun(expDir, 'mark-1', '2026-01-02', { headline: { overall: 70, tiers: {} } });
  const r = await compareVariants({ expDir, specA: 'mark-1:2026-01-01', specB: 'mark-1' });
  assert.equal(r.headline.overall.a, 30);
  assert.equal(r.headline.overall.b, 70);
});

test('compareVariants: picks last ts when multiple runs', async () => {
  const expDir = await tmpExp();
  await writeRun(expDir, 'mark-1', '2026-01-01', { headline: { overall: 10, tiers: {} } });
  await writeRun(expDir, 'mark-1', '2026-02-01', { headline: { overall: 90, tiers: {} } });
  const r = await compareVariants({ expDir, specA: 'mark-1', specB: 'mark-1' });
  assert.equal(r.headline.overall.a, 90);
  assert.equal(r.headline.overall.b, 90);
});

test('compareVariants: missing variant errors clearly', async () => {
  const expDir = await tmpExp();
  await assert.rejects(
    compareVariants({ expDir, specA: 'mark-1', specB: 'mark-2' }),
    /no runs for variant "mark-1"/
  );
});

test('compareVariants: missing REPORT.json errors clearly', async () => {
  const expDir = await tmpExp();
  await fs.mkdir(path.join(expDir, 'variants', 'mark-1', 'runs', '2026-01-01'), { recursive: true });
  await fs.mkdir(path.join(expDir, 'variants', 'mark-2', 'runs', '2026-01-01'), { recursive: true });
  await assert.rejects(
    compareVariants({ expDir, specA: 'mark-1', specB: 'mark-2' }),
    /no REPORT\.json/
  );
});

test('compareVariants: handles null headline values', async () => {
  const expDir = await tmpExp();
  await writeRun(expDir, 'mark-1', '2026-01-01', { headline: { overall: null, tiers: {} } });
  await writeRun(expDir, 'mark-2', '2026-01-01', { headline: { overall: 50, tiers: {} } });
  const r = await compareVariants({ expDir, specA: 'mark-1', specB: 'mark-2' });
  assert.equal(r.headline.overall.a, null);
  assert.equal(r.headline.overall.delta, null);
});

test('formatCompare: includes A, B, delta columns', async () => {
  const expDir = await tmpExp();
  await writeRun(expDir, 'mark-1', '2026-01-01', { headline: { overall: 50, tiers: { must: 60, should: 40, could: 20 } } });
  await writeRun(expDir, 'mark-2', '2026-01-01', { headline: { overall: 65, tiers: { must: 80, should: 50, could: 25 } } });
  const r = await compareVariants({ expDir, specA: 'mark-1', specB: 'mark-2' });
  const out = formatCompare(r);
  assert.match(out, /Compare: mark-1 vs mark-2/);
  assert.match(out, /Overall/);
  assert.match(out, /\+15\.0pp/);
});

test('compareVariants: requires both specs', async () => {
  await assert.rejects(compareVariants({ expDir: '/tmp/x', specA: 'a' }), /specA and specB required/);
  await assert.rejects(compareVariants({ expDir: '/tmp/x' }), /specA and specB required/);
});
