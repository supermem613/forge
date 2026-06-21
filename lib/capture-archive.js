// lib/capture-archive.js — generic capture-window archival.
//
// A run bundle should carry its own raw capture so a run stays mineable after
// the fact, instead of depending on a profile-global capture directory that
// accumulates across runs and is matched only by a fragile mtime guess.
//
// This module is deliberately generic. It knows nothing about kash, augloop, or
// any specific capture producer. It copies the files in `sourceDir` whose
// modification time falls inside a run window into `destDir`. The caller (a
// runbook) owns the producer-specific knowledge of where `sourceDir` is and what
// the run window was.

import { promises as fs } from 'node:fs';
import path from 'node:path';

// Copy every file in `sourceDir` whose mtime falls in [since - slack, until +
// slack] into `destDir`. Returns a summary. Files outside the window and the
// rest of the producer's history are left untouched. `since`/`until` are epoch
// milliseconds.
export async function archiveCaptures({ sourceDir, destDir, since, until, slackMs = 0 } = {}) {
  if (!sourceDir) {
    throw new Error('archiveCaptures: sourceDir is required');
  }
  if (!destDir) {
    throw new Error('archiveCaptures: destDir is required');
  }
  if (!Number.isFinite(since) || !Number.isFinite(until)) {
    throw new Error('archiveCaptures: since and until must be epoch milliseconds');
  }
  const lo = since - slackMs;
  const hi = until + slackMs;

  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { fileCount: 0, bytes: 0, files: [], missingSource: true };
    }
    throw err;
  }

  await fs.mkdir(destDir, { recursive: true });

  const files = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const src = path.join(sourceDir, entry.name);
    const stat = await fs.stat(src);
    if (stat.mtimeMs < lo || stat.mtimeMs > hi) {
      continue;
    }
    await fs.copyFile(src, path.join(destDir, entry.name));
    files.push(entry.name);
    bytes += stat.size;
  }

  files.sort();
  return { fileCount: files.length, bytes, files };
}
