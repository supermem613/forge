// lib/catalog.js — manage the runbooks/README.md catalog table.
//
// The catalog is a markdown table under "## Catalog" with columns
// (Runbook, What it evaluates). `addCatalogEntry` is idempotent: it
// appends a row only if the runbook id isn't already listed. Used by
// `forge new-runbook` so the runbook-create skill no longer has to
// hand-edit this file.

import { promises as fs } from 'node:fs';

const CATALOG_HEADER_RE = /(^##\s+Catalog[ \t]*\n+)\|[ \t]*Runbook[ \t]*\|[ \t]*What it evaluates[ \t]*\|[ \t]*\n\|[-\t |]+\|[ \t]*\n/m;

export function rowFor(runbookId, description) {
  const desc = (description || `Runbook ${runbookId}.`).replace(/\s+/g, ' ').trim();
  return `| [\`${runbookId}\`](./${runbookId}/README.md) | ${desc} |\n`;
}

export function hasEntry(readme, runbookId) {
  // Match the start of a table row referencing `<id>`. Anchored so a
  // substring match (e.g., a description that mentions another runbook)
  // doesn't trip the check.
  const re = new RegExp(`^\\|\\s*\\[\`${runbookId.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\``, 'm');
  return re.test(readme);
}

// Pure transform — given the existing README text, return updated text
// with the new row appended at the end of the catalog table. If the
// runbook is already listed, returns the input unchanged.
export function appendCatalogRow(readme, runbookId, description) {
  if (hasEntry(readme, runbookId)) {
    return readme;
  }
  const m = CATALOG_HEADER_RE.exec(readme);
  if (!m) {
    throw new Error('catalog: cannot find "## Catalog" table header in README');
  }
  // Walk forward from the end of the header+divider, consuming any
  // existing `|...|` rows. Insert immediately after the last one (or
  // immediately after the divider if the table is empty).
  const headerEnd = m.index + m[0].length;
  const tail = readme.slice(headerEnd);
  const lines = tail.split('\n');
  let consumed = 0;
  for (const ln of lines) {
    if (/^\s*\|/.test(ln)) {
      consumed += ln.length + 1;
    } else {
      break;
    }
  }
  const insertAt = headerEnd + consumed;
  return readme.slice(0, insertAt) + rowFor(runbookId, description) + readme.slice(insertAt);
}

export async function addCatalogEntry({ catalogPath, runbookId, description } = {}) {
  if (!catalogPath) {
    throw new Error('addCatalogEntry: catalogPath required');
  }
  if (!runbookId) {
    throw new Error('addCatalogEntry: runbookId required');
  }
  const readme = await fs.readFile(catalogPath, 'utf8');
  const updated = appendCatalogRow(readme, runbookId, description);
  if (updated === readme) {
    return { changed: false, path: catalogPath };
  }
  await fs.writeFile(catalogPath, updated);
  return { changed: true, path: catalogPath };
}
