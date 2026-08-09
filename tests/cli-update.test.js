import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gitPullMadeNoChanges,
  hasSodaWorkspaceMarkers,
  interpretSodaPull,
  isSodaGitInterlockError,
  isSodaManaged,
  probeSodaStatus,
  updateForge,
} from '../lib/cli-update.js';

function ok(out = '') {
  return { ok: true, code: 0, out, err: '' };
}

function sodaStatus(initialized) {
  return ok(JSON.stringify({ ok: true, command: 'status', data: { summary: { initialized } } }));
}

function sodaPull(outcomes) {
  return ok(JSON.stringify({ ok: true, command: 'pull', data: outcomes }));
}

const noMarkers = () => false;

test('updateForge skips root install and link when root git pull made no changes', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
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
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return ok('Fast-forward' + '\n' + ' package.json | 2 +-');
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
      hasMarkers: noMarkers,
      runCommand: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
          return cwd === submoduleDir
            ? ok('Already up-to-date.')
            : ok('Fast-forward' + '\n' + ' package.json | 2 +-');
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
  assert.equal(gitPullMadeNoChanges('Updating abc..def' + '\n' + 'Fast-forward'), false);
});

test('updateForge pulls with sd and runs install, build, and link in a soda-managed repo', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return sodaStatus(true);
      }
      if (cmd === 'sd' && args.join(' ') === 'pull') {
        return sodaPull([{ status: 'integrated', worktreeUpdated: true }]);
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'sd').map((c) => c.args.join(' ')),
    ['status', 'pull'],
  );
  assert.deepEqual(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'pull'), []);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' ')),
    ['install --no-audit --no-fund', 'run build', 'link'],
  );
});

test('updateForge skips install, build, and link when sd pull left the worktree untouched', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return sodaStatus(true);
      }
      if (cmd === 'sd' && args.join(' ') === 'pull') {
        return sodaPull([{ status: 'up-to-date', worktreeUpdated: false }]);
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'sd').map((c) => c.args.join(' ')),
    ['status', 'pull'],
  );
  assert.deepEqual(calls.filter((c) => c.cmd === 'npm'), []);
});

test('updateForge falls back to git pull when the repo is a plain git checkout', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return sodaStatus(false);
      }
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return ok('Fast-forward' + '\n' + ' package.json | 2 +-');
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'git' && c.args[0] === 'pull').map((c) => c.args.join(' ')),
    ['pull --ff-only'],
  );
  assert.deepEqual(calls.filter((c) => c.cmd === 'sd' && c.args.join(' ') === 'pull'), []);
});

test('updateForge falls back to git pull when sd is not installed', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd') {
        return { ok: false, code: 1, out: '', err: "'sd' is not recognized" };
      }
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return ok('Fast-forward' + '\n' + ' package.json | 2 +-');
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'git' && c.args[0] === 'pull').map((c) => c.args.join(' ')),
    ['pull --ff-only'],
  );
});

test('updateForge falls back to git pull when sd status output is unparseable', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return ok('not json at all');
      }
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return ok('Fast-forward' + '\n' + ' package.json | 2 +-');
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'git' && c.args[0] === 'pull').map((c) => c.args.join(' ')),
    ['pull --ff-only'],
  );
});

test('updateForge fails with the sd envelope error when sd pull fails', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return sodaStatus(true);
      }
      if (cmd === 'sd' && args.join(' ') === 'pull') {
        return {
          ok: false,
          code: 1,
          out: JSON.stringify({ ok: false, command: 'pull', error: 'diverged from origin/main' }),
          err: '',
        };
      }
      return ok();
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.where, 'forge');
  assert.equal(result.step, 'sd pull');
  assert.equal(result.error, 'diverged from origin/main');
  assert.deepEqual(calls.filter((c) => c.cmd === 'npm'), []);
});

test('interpretSodaPull reports a change only when some outcome updated the worktree', () => {
  assert.deepEqual(
    interpretSodaPull({ out: JSON.stringify({ ok: true, data: [{ status: 'up-to-date', worktreeUpdated: false }, { status: 'integrated', worktreeUpdated: true }] }) }),
    { ok: true, noChanges: false },
  );
  assert.deepEqual(
    interpretSodaPull({ out: JSON.stringify({ ok: true, data: [{ status: 'ahead', worktreeUpdated: false }] }) }),
    { ok: true, noChanges: true },
  );
  assert.deepEqual(
    interpretSodaPull({ out: JSON.stringify({ ok: false, error: 'not a soda workspace' }) }),
    { ok: false, error: 'not a soda workspace' },
  );
});

test('isSodaManaged is true only for an initialized soda workspace', () => {
  assert.equal(isSodaManaged('/repo', () => sodaStatus(true), noMarkers), true);
  assert.equal(isSodaManaged('/repo', () => sodaStatus(false), noMarkers), false);
  assert.equal(isSodaManaged('/repo', () => ok('{}'), noMarkers), false);
  assert.equal(isSodaManaged('/repo', () => ({ ok: false, code: 1, out: '', err: 'missing' }), noMarkers), false);
  assert.equal(isSodaManaged('/repo', () => ({ ok: false, code: 1, out: '', err: 'missing' }), () => true), true);
});

test('hasSodaWorkspaceMarkers detects local soda workspace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-markers-'));
  try {
    assert.equal(hasSodaWorkspaceMarkers(dir), false);
    mkdirSync(path.join(dir, '.sd'));
    writeFileSync(path.join(dir, '.sd', 'meta.json'), '{}');
    writeFileSync(path.join(dir, '.sd', 'repo-id'), 'repo-1\n');
    assert.equal(hasSodaWorkspaceMarkers(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeSodaStatus stays false on unparseable output', () => {
  assert.equal(probeSodaStatus('/repo', () => ok('not-json')), false);
  assert.equal(probeSodaStatus('/repo', () => sodaStatus(true)), true);
});

test('recognizes soda interlock errors', () => {
  assert.equal(isSodaGitInterlockError('soda: raw git commit blocked in this sd-powered repo'), true);
  assert.equal(isSodaGitInterlockError('network failed'), false);
});

test('updateForge uses sd pull when markers are present even if status fails', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: () => true,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return { ok: false, code: 1, out: '', err: 'missing' };
      }
      if (cmd === 'sd' && args.join(' ') === 'pull') {
        return sodaPull([{ status: 'integrated', worktreeUpdated: true }]);
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'sd').map((c) => c.args.join(' ')),
    ['status', 'pull'],
  );
  assert.deepEqual(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'pull'), []);
});

test('updateForge hard-fails when markers say soda but sd pull fails', async () => {
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: () => true,
    runCommand: (cmd, args) => {
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return { ok: false, code: 1, out: '', err: 'missing' };
      }
      if (cmd === 'sd' && args.join(' ') === 'pull') {
        return { ok: false, code: 1, out: '', err: 'sd missing' };
      }
      return ok();
    },
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error || ''), /soda-managed.*sd pull failed/i);
});

test('updateForge retries with sd pull after soda interlock blocks git', async () => {
  const calls = [];
  const result = await updateForge({
    log: () => {},
    getSubmodules: async () => [],
    hasMarkers: noMarkers,
    runCommand: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'sd' && args.join(' ') === 'status') {
        return sodaStatus(false);
      }
      if (cmd === 'git' && args.join(' ') === 'pull --ff-only') {
        return {
          ok: false,
          code: 1,
          out: '',
          err: 'soda: raw git commit blocked in this sd-powered repo',
        };
      }
      if (cmd === 'sd' && args.join(' ') === 'pull') {
        return sodaPull([{ status: 'integrated', worktreeUpdated: true }]);
      }
      return ok();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((c) => c.cmd === 'sd').map((c) => c.args.join(' ')),
    ['status', 'pull'],
  );
  assert.equal(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'pull').length, 1);
});
