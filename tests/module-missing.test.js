import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadForgeRegistry } from '../lib/module-registry.js';

test('loadForgeRegistry skips a missing module path and still loads the rest', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mod-'));
  const present = path.join(tmp, 'present');
  await fs.mkdir(present);
  await fs.writeFile(
    path.join(present, 'index.js'),
    'export function register(forge) { forge.registerRunbookRoot("from-present"); }\n',
  );
  await fs.writeFile(
    path.join(tmp, 'forge.config.json'),
    `${JSON.stringify({
      modules: [
        { name: 'gone', path: path.join(tmp, 'missing-module') },
        { name: 'present', path: present },
      ],
    }, null, 2)}\n`,
  );
  const registry = await loadForgeRegistry({ repoRoot: tmp });
  assert.equal(registry.runbookRoots().includes(path.resolve('from-present')), true);
});
