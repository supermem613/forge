import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitPullMadeNoChanges, updateForge } from '../lib/cli-update.js';

function ok(out = '') {
  return { ok: true, code: 0, out, err: '' };
}

test('updateForge skips root install and link when root git pull made no changes', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return ok('Already up to date.');
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' ')),
    [],
  );
});

test('updateForge runs root install and link when root git pull returns changes', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return ok('Fast-forward\n package.json | 2 +-');
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' ')),
    ['install --no-audit --no-fund', 'run build', 'link'],
  );
});

test('updateForge skips submodule install and build when submodule git pull made no changes', async () => {
  const submoduleDir = mkdtempSync(path.join(tmpdir(), 'forge-submodule-'));
  try {
    writeFileSync(path.join(submoduleDir, 'package.json'), JSON.stringify({
      scripts: { build: 'node build.js' },
    }));
    const calls = [];
    const result = await updateForge({
      log: () => {},
      getSubmodules: async () => [submoduleDir],
      runCommand: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
          return cwd === submoduleDir
            ? ok('Already up-to-date.')
            : ok('Fast-forward\n package.json | 2 +-');
        }
        return ok();
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      calls
        .filter((c) => c.cwd === submoduleDir && c.cmd === 'npm')
        .map((c) => c.args.join(' ')),
      [],
    );
  } finally {
    rmSync(submoduleDir, { recursive: true, force: true });
  }
});

test('gitPullMadeNoChanges recognizes current and legacy git output', () => {
  assert.equal(gitPullMadeNoChanges('Already up to date.'), true);
  assert.equal(gitPullMadeNoChanges('Already up-to-date.'), true);
  assert.equal(gitPullMadeNoChanges('Updating abc..def\nFast-forward'), false);
});
