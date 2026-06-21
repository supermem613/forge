import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openBundle, readBundleManifest } from '../lib/run-bundle.js';

async function mkSource(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-src-'));
  for (const { name, body, mtimeMs } of files) {
    const p = path.join(dir, name);
    await fs.writeFile(p, body);
    const when = new Date(mtimeMs);
    await fs.utimes(p, when, when);
  }
  return dir;
}

test('bundle.archiveCaptures copies the window into <dir>/captures and records it in the manifest', async () => {
  const base = Date.parse('2026-06-21T00:00:00.000Z');
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-runs-'));
  const sourceDir = await mkSource([
    { name: 'before.json', body: 'x', mtimeMs: base - 60_000 },
    { name: 'in.json', body: 'keep', mtimeMs: base + 1000 },
  ]);

  const bundle = await openBundle({ experiment: 'cap-exp', variant: 'mark-1', runsDir });
  const result = await bundle.archiveCaptures({
    sourceDir,
    since: base,
    until: base + 2000,
    slackMs: 0,
  });

  assert.equal(result.fileCount, 1);
  const archived = await fs.readdir(path.join(bundle.dir, 'captures'));
  assert.deepEqual(archived.sort(), ['in.json']);

  const manifest = await readBundleManifest(bundle.dir);
  assert.equal(manifest.captures.fileCount, 1);
  assert.equal(manifest.captures.bytes, 'keep'.length);
});
