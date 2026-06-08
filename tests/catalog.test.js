// tests/catalog.test.js — runbook catalog table maintenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCatalogRow, hasEntry, rowFor, addCatalogEntry } from '../lib/catalog.js';

const HEADER = `# Forge runbooks

Lots of prose.

## Catalog

| Runbook | What it evaluates |
|---|---|
| [\`create-skill\`](./create-skill/README.md) | The thing. |

## Anatomy

More prose.
`;

test('rowFor formats a catalog row', () => {
  const row = rowFor('foo', 'A test runbook.');
  assert.equal(row, '| [`foo`](./foo/README.md) | A test runbook. |\n');
});

test('rowFor collapses whitespace in description', () => {
  const row = rowFor('foo', '  Multi\n  line\tdesc.  ');
  assert.equal(row, '| [`foo`](./foo/README.md) | Multi line desc. |\n');
});

test('rowFor falls back to default description', () => {
  const row = rowFor('foo');
  assert.equal(row, '| [`foo`](./foo/README.md) | Runbook foo. |\n');
});

test('hasEntry detects existing runbook', () => {
  assert.equal(hasEntry(HEADER, 'create-skill'), true);
  assert.equal(hasEntry(HEADER, 'other'), false);
});

test('hasEntry is anchored to start of line', () => {
  // A description that mentions another runbook shouldn't trigger a match.
  const r = `## Catalog\n\n| Runbook | What it evaluates |\n|---|---|\n| [\`a\`](./a/README.md) | references b in description |\n\n`;
  assert.equal(hasEntry(r, 'a'), true);
  assert.equal(hasEntry(r, 'b'), false);
});

test('appendCatalogRow appends below existing rows and above next section', () => {
  const out = appendCatalogRow(HEADER, 'tool-selection', 'Tool routing.');
  assert.match(out, /create-skill.*\n\| \[`tool-selection`\]/);
  assert.match(out, /tool-selection`\]\(.\/tool-selection\/README\.md\) \| Tool routing\. \|\n\n## Anatomy/);
});

test('appendCatalogRow is idempotent', () => {
  const once = appendCatalogRow(HEADER, 'tool-selection', 'Tool routing.');
  const twice = appendCatalogRow(once, 'tool-selection', 'Tool routing.');
  assert.equal(once, twice);
});

test('appendCatalogRow throws when "## Catalog" header is missing', () => {
  assert.throws(() => appendCatalogRow('# README\n\nNo catalog here.\n', 'foo', 'd'), /Catalog/);
});

test('appendCatalogRow handles empty catalog (header + divider only)', () => {
  const empty = `## Catalog\n\n| Runbook | What it evaluates |\n|---|---|\n\n## Next\n`;
  const out = appendCatalogRow(empty, 'first', 'First entry.');
  assert.match(out, /\|---\|---\|\n\| \[`first`\]/);
  assert.match(out, /First entry\. \|\n\n## Next/);
});

test('addCatalogEntry writes file and reports change', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-catalog-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const p = path.join(tmp, 'README.md');
  await fs.writeFile(p, HEADER);

  const r1 = await addCatalogEntry({ catalogPath: p, runbookId: 'new', description: 'New runbook.' });
  assert.equal(r1.changed, true);
  const after1 = await fs.readFile(p, 'utf8');
  assert.match(after1, /\| \[`new`\]/);

  const r2 = await addCatalogEntry({ catalogPath: p, runbookId: 'new', description: 'New runbook.' });
  assert.equal(r2.changed, false);
  const after2 = await fs.readFile(p, 'utf8');
  assert.equal(after1, after2);
});
