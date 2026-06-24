import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRecommendation } from '../lib/cli-recommend.js';

async function makeExp(repoRoot, expName, { overall = 10.0, suggestions = ['Increase samples to 5 before promoting.'], withReport = true } = {}) {
  const expDir = path.join(repoRoot, 'experiments', expName);
  const ctlRunDir = path.join(expDir, 'variants', 'control', 'runs', '2026-01-01T00-00-00-000');
  const txRunDir  = path.join(expDir, 'variants', 'mark-1', 'runs', '2026-01-01T00-00-00-001');
  await fs.mkdir(ctlRunDir, { recursive: true });
  await fs.mkdir(txRunDir, { recursive: true });
  await fs.writeFile(path.join(ctlRunDir, 'score.json'), JSON.stringify({ overallPct: 60 }));
  await fs.writeFile(path.join(txRunDir, 'score.json'), JSON.stringify({ overallPct: 70 }));
  if (withReport) {
    const report = {
      experiment: expName, variant: 'mark-1',
      controlRun: ctlRunDir, variantRun: txRunDir,
      headline: { overall, tiers: {} },
      insights: { breakthroughs: [], pitfalls: [], suggestions },
    };
    await fs.writeFile(path.join(txRunDir, 'REPORT.json'), JSON.stringify(report));
  }
  return { expDir, ctlRunDir, txRunDir };
}

test('buildRecommendation: surfaces suggestions and a promote next-step when winning', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recommend-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'demo', { overall: 10.0 });
  const out = await buildRecommendation({ experiment: 'demo', repoRoot: tmp });
  assert.match(out.markdown, /Recommendations — demo/);
  assert.match(out.markdown, /Increase samples to 5 before promoting/);
  assert.match(out.markdown, /Promote it to the next mark/);
  assert.equal(out.suggestionCount, 1);
});

test('buildRecommendation: regression headline directs to criterion movements', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recommend-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'regress', { overall: -8.0 });
  const out = await buildRecommendation({ experiment: 'regress', repoRoot: tmp });
  assert.match(out.markdown, /regressing by -8\.0pp/);
  assert.match(out.markdown, /top criterion movements/);
});

test('buildRecommendation: flat headline recommends more samples or a pivot', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recommend-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'flat', { overall: 1.0, suggestions: [] });
  const out = await buildRecommendation({ experiment: 'flat', repoRoot: tmp });
  assert.match(out.markdown, /roughly flat/);
  assert.match(out.markdown, /No additional variant-level suggestions/);
  assert.equal(out.suggestionCount, 0);
});

test('buildRecommendation: errors clearly when REPORT.json missing', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recommend-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await makeExp(tmp, 'demo', { withReport: false });
  await assert.rejects(
    buildRecommendation({ experiment: 'demo', repoRoot: tmp }),
    /REPORT\.json missing.*forge report demo/s,
  );
});
