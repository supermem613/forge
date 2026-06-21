import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archiveCaptures } from '../lib/capture-archive.js';

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

test('archiveCaptures copies only files whose mtime is within the window', async () => {
  const base = Date.parse('2026-06-21T00:00:00.000Z');
  const min = 60_000;
  const sourceDir = await mkSource([
    { name: 'before.json', body: 'x', mtimeMs: base - 5 * min },
    { name: 'in-1.json', body: 'hello', mtimeMs: base + 1 * min },
    { name: 'in-2.json', body: 'world!!', mtimeMs: base + 2 * min },
    { name: 'after.json', body: 'y', mtimeMs: base + 10 * min },
  ]);
  const destDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cap-dst-')), 'captures');

  const result = await archiveCaptures({
    sourceDir,
    destDir,
    since: base,
    until: base + 3 * min,
    slackMs: 0,
  });

  assert.equal(result.fileCount, 2, 'only the two in-window files are copied');
  assert.equal(result.bytes, 'hello'.length + 'world!!'.length);
  const copied = (await fs.readdir(destDir)).sort();
  assert.deepEqual(copied, ['in-1.json', 'in-2.json']);
});

test('archiveCaptures includes files within slackMs of the window edges', async () => {
  const base = Date.parse('2026-06-21T00:00:00.000Z');
  const sourceDir = await mkSource([
    { name: 'just-after.json', body: 'ab', mtimeMs: base + 5000 },
  ]);
  const destDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cap-dst-')), 'captures');

  const tight = await archiveCaptures({ sourceDir, destDir, since: base, until: base, slackMs: 0 });
  assert.equal(tight.fileCount, 0, 'excluded with no slack');

  const slack = await archiveCaptures({ sourceDir, destDir, since: base, until: base, slackMs: 8000 });
  assert.equal(slack.fileCount, 1, 'included once slack covers it');
});

test('archiveCaptures returns missingSource instead of throwing when sourceDir is absent', async () => {
  const destDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cap-dst-')), 'captures');
  const result = await archiveCaptures({
    sourceDir: path.join(os.tmpdir(), 'does-not-exist-' + Math.random().toString(36).slice(2)),
    destDir,
    since: 0,
    until: 1,
    slackMs: 0,
  });
  assert.equal(result.missingSource, true);
  assert.equal(result.fileCount, 0);
});
