// tests/run-context.test.js — shared run-context loader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRunContext } from '../lib/run-context.js';

async function scaffold(t, { experimentJson = {}, manifest, evalDocs = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-runctx-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rb = path.join(root, 'runbooks', 'demo-rb');
  await fs.mkdir(path.join(rb, 'evals'), { recursive: true });
  await fs.writeFile(path.join(rb, 'manifest.json'), JSON.stringify(manifest || {
    defaults: { samples: 2 }, evals: ['evals/01.json', 'evals/02.json'],
  }));
  for (const e of (evalDocs.length ? evalDocs : [{ id: 'e1' }, { id: 'e2' }])) {
    await fs.writeFile(path.join(rb, 'evals', `${e.id === 'e1' ? '01' : '02'}.json`), JSON.stringify(e));
  }
  const expDir = path.join(root, 'experiments', 'demo');
  await fs.mkdir(expDir, { recursive: true });
  await fs.writeFile(path.join(expDir, 'experiment.json'), JSON.stringify(experimentJson));
  return { root, rb, expDir };
}

test('loadRunContext: happy path control variant', async (t) => {
  const { root, rb, expDir } = await scaffold(t);
  const ctx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'control'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.equal(ctx.experiment, 'demo');
  assert.equal(ctx.variant, 'control');
  assert.equal(ctx.isControl, true);
  assert.equal(ctx.samples, 2); // from manifest.defaults
  assert.equal(ctx.expDir, expDir);
  assert.equal(ctx.variantDir, path.join(expDir, 'variants', 'control'));
  assert.equal(ctx.artifactsDir, path.join(expDir, 'variants', 'control', 'artifacts'));
  assert.equal(ctx.runsDir, path.join(expDir, 'variants', 'control', 'runs'));
  assert.equal(ctx.evals.length, 2);
  assert.equal('profile' in ctx, false);
});

test('loadRunContext: --samples overrides manifest default', async (t) => {
  const { root, rb } = await scaffold(t);
  const ctx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'mark-1', '--samples', '7'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.equal(ctx.samples, 7);
  assert.equal(ctx.isControl, false);
  assert.equal('profile' in ctx, false);
});

test('loadRunContext: --evalIds filters and rejects unknown', async (t) => {
  const { root, rb } = await scaffold(t);
  const ctx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'control', '--evalIds', 'e2'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.equal(ctx.evals.length, 1);
  assert.equal(ctx.evals[0].id, 'e2');

  await assert.rejects(
    () => loadRunContext({
      argv: ['--experiment', 'demo', '--variant', 'control', '--evalIds', 'e2,nope'],
      runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
    }),
    /unknown id\(s\): nope/,
  );
});

test('loadRunContext: urlParams strips leading ? and routes by variant', async (t) => {
  const { root, rb } = await scaffold(t, {
    experimentJson: { urlParams: { control: '?a=1', treatment: '?b=2&c=3' } },
  });
  const ctlCtx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'control'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.equal(ctlCtx.urlParams.active, 'a=1');
  assert.equal(ctlCtx.urlParams.treatment, 'b=2&c=3');

  const txCtx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'mark-1'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.equal(txCtx.urlParams.active, 'b=2&c=3');
});

test('loadRunContext: extras captures unknown flags', async (t) => {
  const { root, rb } = await scaffold(t);
  const ctx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'control', '--keep-skills', '--something', 'value'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.equal(ctx.extras['keep-skills'], true);
  assert.equal(ctx.extras['something'], 'value');
});

test('loadRunContext: missing --experiment throws', async (t) => {
  const { root, rb } = await scaffold(t);
  await assert.rejects(
    () => loadRunContext({ argv: ['--variant', 'control'], runbookId: 'demo-rb', runbookDir: rb, repoRoot: root }),
    /--experiment <name> required/,
  );
});

test('loadRunContext: missing --variant throws', async (t) => {
  const { root, rb } = await scaffold(t);
  await assert.rejects(
    () => loadRunContext({ argv: ['--experiment', 'demo'], runbookId: 'demo-rb', runbookDir: rb, repoRoot: root }),
    /--variant <control\|mark-N> required/,
  );
});

test('loadRunContext: bad variant rejected', async (t) => {
  const { root, rb } = await scaffold(t);
  await assert.rejects(
    () => loadRunContext({ argv: ['--experiment', 'demo', '--variant', 'bogus'], runbookId: 'demo-rb', runbookDir: rb, repoRoot: root }),
    /must be 'control' or 'mark-N'/,
  );
});

test('loadRunContext: unknown experiment throws', async (t) => {
  const { root, rb } = await scaffold(t);
  await assert.rejects(
    () => loadRunContext({ argv: ['--experiment', 'ghost', '--variant', 'control'], runbookId: 'demo-rb', runbookDir: rb, repoRoot: root }),
    /no such experiment: ghost/,
  );
});

test('loadRunContext: returned context is frozen', async (t) => {
  const { root, rb } = await scaffold(t);
  const ctx = await loadRunContext({
    argv: ['--experiment', 'demo', '--variant', 'control'],
    runbookId: 'demo-rb', runbookDir: rb, repoRoot: root,
  });
  assert.throws(() => {
    ctx.experiment = 'other'; 
  }, TypeError);
});
