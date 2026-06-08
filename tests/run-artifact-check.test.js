// tests/run-artifact-check.test.js - read-only run artifact schema checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBundle } from '../lib/run-bundle.js';
import { checkRunArtifact, formatArtifactCheck } from '../lib/run-artifact-check.js';

async function freshRunsDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'forge-run-artifact-check-'));
}

test('artifact check passes for a v1 bundle with transcript entries', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const bundle = await openBundle({
    experiment: 'schema-test',
    variant: 'control',
    runsDir,
    ts: '2026-05-11T15-45-00',
  });
  await bundle.writeTurn('eval-a', 1, 1, {
    prompt: 'hello',
    response: { text: 'world', toolDetails: [] },
    ms: 5,
  });

  const result = await checkRunArtifact({ runDir: bundle.dir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.transcriptEntries, 1);
  assert.match(formatArtifactCheck(result), /OK/);
});

test('artifact check fails when transcript points to a missing artifact', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const bundle = await openBundle({
    experiment: 'schema-test',
    variant: 'mark-1',
    runsDir,
    ts: '2026-05-11T15-46-00',
  });
  await bundle.writeTurn('eval-a', 1, 1, {
    prompt: 'hello',
    response: { text: 'world', toolDetails: [] },
  });
  const transcriptPath = path.join(bundle.dir, 'transcript.json');
  const transcript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
  transcript.entries[0].path = 'turn1/missing.json';
  await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 2) + '\n');

  const result = await checkRunArtifact({ runDir: bundle.dir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /missing artifact/);
});

test('artifact check fails on duplicate transcript keys', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const bundle = await openBundle({
    experiment: 'schema-test',
    variant: 'mark-1',
    runsDir,
    ts: '2026-05-11T15-47-00',
  });
  await bundle.writeTurn('eval-a', 1, 1, {
    prompt: 'hello',
    response: { text: 'world', toolDetails: [] },
  });
  const transcriptPath = path.join(bundle.dir, 'transcript.json');
  const transcript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
  transcript.entries.push({ ...transcript.entries[0] });
  await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 2) + '\n');

  const result = await checkRunArtifact({ runDir: bundle.dir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicates evalId\/sample\/turn\/path/);
});
