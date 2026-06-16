// tests/module-schema.test.js — module commands surface full schema metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForgeRegistry } from '../lib/module-registry.js';
import { moduleCommandsForSchema, buildSchema } from '../lib/command-catalog.js';

test('module command without meta degrades to a documented stub', () => {
  const registry = createForgeRegistry({ repoRoot: process.cwd() });
  registry.registerCommand('legacy', async () => {});
  const [entry] = moduleCommandsForSchema(registry);
  assert.deepEqual(entry.path, ['legacy']);
  assert.equal(entry.summary, 'Module-registered command.');
  assert.equal(entry.effect, 'mutate-local');
  assert.equal(entry.output.documented, false);
  assert.equal(entry.moduleCommand, true);
});

test('flat module command meta drives summary, effect, and input', () => {
  const registry = createForgeRegistry({ repoRoot: process.cwd() });
  registry.registerCommand('sweep-site', async () => {}, {
    summary: 'Delete stray test folders.',
    effect: 'mutate-remote',
    input: { positionals: [], flags: [{ name: 'lib', type: 'string' }] },
  });
  const [entry] = moduleCommandsForSchema(registry);
  assert.deepEqual(entry.path, ['sweep-site']);
  assert.equal(entry.summary, 'Delete stray test folders.');
  assert.equal(entry.effect, 'mutate-remote');
  assert.deepEqual(entry.input.flags, [{ name: 'lib', type: 'string' }]);
  assert.equal(entry.moduleCommand, true);
});

test('subcommand meta expands into one schema entry per subcommand', () => {
  const registry = createForgeRegistry({ repoRoot: process.cwd() });
  registry.registerCommand('overlay', async () => {}, {
    summary: 'Manage source overlays.',
    effect: 'mutate-local',
    subcommands: [
      { name: 'apply', summary: 'Apply an overlay.', effect: 'mutate-local', input: { positionals: [{ name: 'exp', required: true }], flags: [] } },
      { name: 'status', summary: 'List overlay locks.', effect: 'read', input: { positionals: [], flags: [] } },
    ],
  });
  const entries = moduleCommandsForSchema(registry);
  assert.deepEqual(entries.map(e => e.path), [['overlay', 'apply'], ['overlay', 'status']]);
  assert.equal(entries[0].effect, 'mutate-local');
  assert.equal(entries[1].effect, 'read');
  assert.deepEqual(entries[0].input.positionals, [{ name: 'exp', required: true }]);
});

test('buildSchema includes expanded module subcommand paths', () => {
  const registry = createForgeRegistry({ repoRoot: process.cwd() });
  registry.registerCommand('sp-auth', async () => {}, {
    summary: 'Manage auth.',
    subcommands: [
      { name: 'login', summary: 'Sign in.', effect: 'mutate-local', input: { positionals: [], flags: [{ name: 'site', type: 'string', required: true }] } },
      { name: 'status', summary: 'Report session.', effect: 'read', input: { positionals: [], flags: [] } },
    ],
  });
  const schema = buildSchema({ version: '0.5.0', registry, summary: true });
  assert.ok(schema.commandPaths.includes('sp-auth login'));
  assert.ok(schema.commandPaths.includes('sp-auth status'));
});
