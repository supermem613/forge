// tests/bundle-schema.test.js — bundle schema versioning.
//
// Contract:
//   * Every NEW bundle written via openBundle() carries
//     `manifest.bundleSchemaVersion = BUNDLE_SCHEMA_VERSION` (currently 1).
//   * `readBundleManifest()` normalizes legacy v0 bundles (field absent) to
//     `bundleSchemaVersion = 0` so callers can branch without null-checks.
//
// Bump BUNDLE_SCHEMA_VERSION when bundle layout / manifest contract changes
// in a way that breaks downstream tools (score/judge/report).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openBundle,
  readBundleManifest,
  BUNDLE_SCHEMA_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from '../lib/run-bundle.js';

async function freshRunsDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bundle-schema-'));
}

test('BUNDLE_SCHEMA_VERSION is the current version', () => {
  assert.equal(typeof BUNDLE_SCHEMA_VERSION, 'number');
  assert.equal(BUNDLE_SCHEMA_VERSION, 1);
  assert.equal(RUN_ARTIFACT_SCHEMA_VERSION, 1);
});

test('openBundle writes schema versions in manifest.json', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const b = await openBundle({
    experiment: 'schema-test',
    variant: 'control',
    runsDir,
    ts: '2026-04-30T00-00-00',
  });

  const onDisk = JSON.parse(await fs.readFile(path.join(b.dir, 'manifest.json'), 'utf8'));
  assert.equal(onDisk.bundleSchemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(onDisk.runArtifactSchemaVersion, RUN_ARTIFACT_SCHEMA_VERSION);
});

test('readBundleManifest preserves schema versions on round-trip', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const b = await openBundle({
    experiment: 'schema-test',
    variant: 'mark-1',
    runsDir,
    ts: '2026-04-30T00-00-01',
  });
  const m = await readBundleManifest(b.dir);
  assert.equal(m.bundleSchemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(m.runArtifactSchemaVersion, RUN_ARTIFACT_SCHEMA_VERSION);
});

test('readBundleManifest normalizes legacy v0 bundles to schemaVersion=0', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  // Hand-craft a legacy bundle (no schema field) the way pre-Phase-0 forge wrote them.
  const dir = path.join(runsDir, '2025-12-01T00-00-00');
  await fs.mkdir(dir, { recursive: true });
  const legacyManifest = {
    experiment: 'legacy',
    variant: 'control',
    ts: '2025-12-01T00-00-00',
    startedAt: '2025-12-01T00:00:00Z',
    finalizedAt: '2025-12-01T00:05:00Z',
    pairedControl: null,
    summary: { pass: 5, fail: 0 },
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(legacyManifest, null, 2));

  const m = await readBundleManifest(dir);
  assert.equal(m.bundleSchemaVersion, 0, 'legacy bundles surface as v0 without crashing');
  assert.equal(m.runArtifactSchemaVersion, 0, 'legacy artifact schemas surface as v0 without crashing');
  assert.equal(m.experiment, 'legacy');
  assert.deepEqual(m.summary, { pass: 5, fail: 0 });
});

test('finalize and pairWith preserve bundleSchemaVersion', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const ctrl = await openBundle({ experiment: 'schema-test', variant: 'control', runsDir, ts: '2026-04-30T00-01-00' });
  const trt = await openBundle({ experiment: 'schema-test', variant: 'mark-1', runsDir, ts: '2026-04-30T00-01-01' });
  await trt.pairWith(ctrl.dir);
  await trt.finalize({ summary: { pass: 1, fail: 0 } });

  const m = await readBundleManifest(trt.dir);
  assert.equal(m.bundleSchemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.ok(m.finalizedAt);
  assert.ok(m.pairedControl, 'pairedControl recorded');
  assert.ok(m.pairedControl.includes('2026-04-30T00-01-00'));
});

test('openBundle creates transcript index and writeTurn appends summaries', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const b = await openBundle({
    experiment: 'schema-test',
    variant: 'mark-1',
    runsDir,
    ts: '2026-04-30T00-02-00',
    loadedSkills: response => response.capabilitiesLoaded || [],
  });

  const empty = JSON.parse(await fs.readFile(path.join(b.dir, 'transcript.json'), 'utf8'));
  assert.equal(empty.schemaVersion, RUN_ARTIFACT_SCHEMA_VERSION);
  assert.deepEqual(empty.entries, []);

  await b.writeTurn('eval-a', 2, 1, {
    prompt: 'Create a document',
    response: {
      text: 'Done',
      toolDetails: [{ toolName: 'create_document', input: { name: 'demo-doc' } }],
      capabilitiesLoaded: ['document-writer'],
    },
    generated: { name: 'demo-doc', body: '# Demo' },
    ms: 123,
  });

  const transcript = JSON.parse(await fs.readFile(path.join(b.dir, 'transcript.json'), 'utf8'));
  assert.equal(transcript.entries.length, 1);
  assert.deepEqual(transcript.entries[0], {
    evalId: 'eval-a',
    sample: 2,
    turn: 1,
    path: 'turn1/eval-a-sample2.json',
    writtenAt: transcript.entries[0].writtenAt,
    ms: 123,
    promptChars: 'Create a document'.length,
    responseChars: 'Done'.length,
    toolCalls: 1,
    capabilitiesLoaded: ['document-writer'],
    error: null,
    generatedArtifactName: 'demo-doc',
    childArtifactName: null,
  });
  assert.match(transcript.entries[0].writtenAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('writeTurn replaces transcript entry for same turn path', async (t) => {
  const runsDir = await freshRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const b = await openBundle({
    experiment: 'schema-test',
    variant: 'control',
    runsDir,
    ts: '2026-04-30T00-03-00',
  });

  await b.writeTurn('eval-a', 1, 1, { prompt: 'first', error: 'old' });
  await b.writeTurn('eval-a', 1, 1, { prompt: 'second', error: 'new' });

  const transcript = JSON.parse(await fs.readFile(path.join(b.dir, 'transcript.json'), 'utf8'));
  assert.equal(transcript.entries.length, 1);
  assert.equal(transcript.entries[0].promptChars, 'second'.length);
  assert.equal(transcript.entries[0].error, 'new');
});
