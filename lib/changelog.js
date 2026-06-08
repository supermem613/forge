// lib/changelog.js — append a Changelog line to a runbook README.
//
// Used by `forge bump --changelog "summary"`. Idempotent: if the exact
// version+summary line already exists, the file is left unchanged.

import { promises as fs } from 'node:fs';

const CHANGELOG_HEADER = '## Changelog';

export function todayISO(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function changelogLine(version, summary, date) {
  const cleaned = String(summary || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    throw new Error('changelogLine: summary required');
  }
  return `- v${version} (${date || todayISO()}): ${cleaned}`;
}

// Pure transform — append `line` to the README. If a "## Changelog"
// section exists, insert directly under it (newest first). If not,
// append a new section to the end of the file.
//
// Idempotent: same line already present (anywhere in the file) → no-op.
export function appendChangelog(readme, line) {
  // Strip trailing CRs to keep line comparisons simple.
  const normalized = readme.replace(/\r\n/g, '\n');
  if (normalized.includes(line)) {
    return readme;
  }
  const headerIdx = normalized.indexOf(CHANGELOG_HEADER);
  if (headerIdx === -1) {
    const trimmed = normalized.replace(/\n*$/, '\n');
    return trimmed + `\n${CHANGELOG_HEADER}\n\n${line}\n`;
  }
  // Insert after the header line + any blank lines that follow it.
  const after = normalized.slice(headerIdx + CHANGELOG_HEADER.length);
  const blanks = after.match(/^\n+/)?.[0] || '\n';
  const insertAt = headerIdx + CHANGELOG_HEADER.length + blanks.length;
  // Force exactly one blank line between header and the newest entry.
  return normalized.slice(0, headerIdx + CHANGELOG_HEADER.length) +
    '\n\n' +
    line + '\n' +
    normalized.slice(insertAt);
}

export async function appendChangelogToFile({ readmePath, version, summary, date } = {}) {
  if (!readmePath) {
    throw new Error('appendChangelogToFile: readmePath required');
  }
  if (!version) {
    throw new Error('appendChangelogToFile: version required');
  }
  if (!summary) {
    throw new Error('appendChangelogToFile: summary required');
  }
  const line = changelogLine(version, summary, date);
  const readme = await fs.readFile(readmePath, 'utf8');
  const updated = appendChangelog(readme, line);
  if (updated === readme) {
    return { changed: false, line, path: readmePath };
  }
  await fs.writeFile(readmePath, updated);
  return { changed: true, line, path: readmePath };
}
