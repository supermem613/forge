// tests/runbook-authoring-gaps.test.js — regressions for three defects that
// let non-conforming "runbooks" get authored and stay invisible:
//   1. the catalog header regex could not match CRLF, so catalog registration
//      silently failed on Windows checkouts;
//   2. new-runbook could only scaffold into forge's own runbooks/, so module
//      authors had no supported way to create a conforming runbook;
//   3. a loose file in a runbook root was skipped in silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCatalogRow } from '../lib/catalog.js';
import { resolveRunbooksDir } from '../lib/cli-new-runbook.js';
import { createForgeRegistry, findStrayRunbookFiles } from '../lib/module-registry.js';

const CATALOG_BODY = '# Runbooks\n\n## Catalog\n\n| Runbook | What it evaluates |\n|---|---|\n';

test('appendCatalogRow: registers a runbook in a CRLF catalog', () => {
  const crlf = CATALOG_BODY.replace(/\n/g, '\r\n');
  const out = appendCatalogRow(crlf, 'prepare', 'Measures the prepare skill.');
  assert.match(out, /\| \[`prepare`\]\(\.\/prepare\/README\.md\) \| Measures the prepare skill\. \|/);
});

test('appendCatalogRow: still registers a runbook in an LF catalog', () => {
  const out = appendCatalogRow(CATALOG_BODY, 'prepare', 'Measures the prepare skill.');
  assert.match(out, /\| \[`prepare`\]\(\.\/prepare\/README\.md\) \|/);
});

test('resolveRunbooksDir: defaults to the forge repo runbooks directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-rbdir-'));
  const dir = await resolveRunbooksDir({ repoRoot: root });
  assert.equal(dir, path.join(root, 'runbooks'));
});

test('resolveRunbooksDir: targets a configured module by name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-rbdir-'));
  const modulePath = path.join(root, 'sibling-module');
  await fs.mkdir(modulePath, { recursive: true });
  await fs.writeFile(path.join(root, 'forge.config.json'),
    JSON.stringify({ modules: [{ name: 'my-module', path: modulePath }] }));

  const dir = await resolveRunbooksDir({ repoRoot: root, moduleName: 'my-module' });
  assert.equal(dir, path.join(modulePath, 'runbooks'));
});

test('resolveRunbooksDir: names the known modules when one is not configured', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-rbdir-'));
  await fs.writeFile(path.join(root, 'forge.config.json'),
    JSON.stringify({ modules: [{ name: 'my-module', path: root }] }));
  await assert.rejects(
    resolveRunbooksDir({ repoRoot: root, moduleName: 'nope' }),
    /no such module "nope".*my-module/s,
  );
});

test('resolveRunbooksDir: an explicit directory wins over module lookup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-rbdir-'));
  const explicit = path.join(root, 'elsewhere');
  const dir = await resolveRunbooksDir({ repoRoot: root, runbooksDir: explicit });
  assert.equal(dir, path.resolve(explicit));
});

test('findStrayRunbookFiles: reports loose files that forge would skip silently', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-stray-'));
  const runbooks = path.join(root, 'runbooks');
  await fs.mkdir(path.join(runbooks, 'real-runbook'), { recursive: true });
  await fs.writeFile(path.join(runbooks, 'README.md'), '# catalog\n');
  await fs.writeFile(path.join(runbooks, 'notes.md'), '# not a runbook\n');

  const registry = createForgeRegistry({ repoRoot: root });
  const strays = await findStrayRunbookFiles(registry);
  assert.equal(strays.length, 1);
  assert.equal(strays[0].name, 'notes.md');
  assert.equal(strays[0].root, runbooks);
});

test('findStrayRunbookFiles: the catalog README is not a stray', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-stray-'));
  await fs.mkdir(path.join(root, 'runbooks', 'real-runbook'), { recursive: true });
  await fs.writeFile(path.join(root, 'runbooks', 'README.md'), '# catalog\n');

  const registry = createForgeRegistry({ repoRoot: root });
  assert.deepEqual(await findStrayRunbookFiles(registry), []);
});
