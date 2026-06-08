// lib/cli-bump.js — `forge bump <runbook> [patch|minor|major]`.
//
// Bumps the semver in runbooks/<id>/manifest.json. Default level is patch.
// Returns { from, to, level } so the CLI can log it.
//
// Refuses to bump if manifest.version is not semver (run validate first).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendChangelogToFile } from './changelog.js';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VALID_LEVELS = new Set(['patch', 'minor', 'major']);

export function bumpVersion(version, level = 'patch') {
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`bumpVersion: level must be patch|minor|major (got "${level}")`);
  }
  const m = SEMVER_RE.exec(version);
  if (!m) {
    throw new Error(`bumpVersion: not semver: "${version}"`);
  }
  let maj = Number(m[1]);
  let min = Number(m[2]);
  let pat = Number(m[3]);
  if (level === 'major') {
    maj++; min = 0; pat = 0; 
  } else if (level === 'minor') {
    min++; pat = 0; 
  } else {
    pat++; 
  }
  return `${maj}.${min}.${pat}`;
}

export async function bumpRunbook({ runbookDir, level = 'patch', changelog, date } = {}) {
  if (!runbookDir) {
    throw new Error('bumpRunbook: runbookDir required');
  }
  const manifestPath = path.join(runbookDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const from = manifest.version;
  const to = bumpVersion(from, level);
  manifest.version = to;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  let changelogResult = null;
  if (changelog) {
    changelogResult = await appendChangelogToFile({
      readmePath: path.join(runbookDir, 'README.md'),
      version: to,
      summary: changelog,
      date,
    });
  }
  return { from, to, level, changelog: changelogResult };
}
