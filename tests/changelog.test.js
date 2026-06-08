// tests/changelog.test.js — runbook README Changelog appender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  changelogLine, appendChangelog, appendChangelogToFile, todayISO,
} from '../lib/changelog.js';

test('todayISO returns YYYY-MM-DD UTC', () => {
  const d = new Date(Date.UTC(2026, 3, 27, 23, 59, 0));
  assert.equal(todayISO(d), '2026-04-27');
});

test('changelogLine formats version + date + summary', () => {
  const l = changelogLine('1.2.3', '  Added a thing.  ', '2026-04-27');
  assert.equal(l, '- v1.2.3 (2026-04-27): Added a thing.');
});

test('changelogLine collapses whitespace in summary', () => {
  const l = changelogLine('1.2.3', 'Multi\n  line\tsummary.', '2026-04-27');
  assert.equal(l, '- v1.2.3 (2026-04-27): Multi line summary.');
});

test('changelogLine throws on empty summary', () => {
  assert.throws(() => changelogLine('1.0.0', '   ', '2026-04-27'), /summary/);
});

test('appendChangelog inserts under existing ## Changelog section, newest first', () => {
  const md = `# foo\n\nbody.\n\n## Changelog\n\n- v1.0.0 (2026-01-01): initial.\n`;
  const out = appendChangelog(md, '- v1.1.0 (2026-04-27): bump.');
  // Newest entry should appear immediately after the header, before older entries.
  const idxNew = out.indexOf('v1.1.0');
  const idxOld = out.indexOf('v1.0.0');
  assert.ok(idxNew > 0 && idxNew < idxOld, 'newest entry should be above older');
});

test('appendChangelog creates section if missing', () => {
  const md = `# foo\n\nbody.\n`;
  const out = appendChangelog(md, '- v1.0.0 (2026-04-27): first.');
  assert.match(out, /## Changelog\n\n- v1\.0\.0 \(2026-04-27\): first\.\n$/);
});

test('appendChangelog is idempotent on identical line', () => {
  const md = `# foo\n\n## Changelog\n\n- v1.0.0 (2026-04-27): first.\n`;
  const out = appendChangelog(md, '- v1.0.0 (2026-04-27): first.');
  assert.equal(out, md);
});

test('appendChangelog handles CRLF input', () => {
  const md = '# foo\r\n\r\nbody.\r\n';
  const out = appendChangelog(md, '- v1.0.0 (2026-04-27): first.');
  assert.match(out, /## Changelog\n\n- v1\.0\.0/);
});

test('appendChangelogToFile writes file and reports the line', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-changelog-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const p = path.join(tmp, 'README.md');
  await fs.writeFile(p, '# foo\n\nbody.\n');
  const r = await appendChangelogToFile({
    readmePath: p, version: '0.2.0', summary: 'Did stuff.', date: '2026-04-27',
  });
  assert.equal(r.changed, true);
  assert.equal(r.line, '- v0.2.0 (2026-04-27): Did stuff.');
  const after = await fs.readFile(p, 'utf8');
  assert.match(after, /## Changelog\n\n- v0\.2\.0 \(2026-04-27\): Did stuff\.\n/);

  const r2 = await appendChangelogToFile({
    readmePath: p, version: '0.2.0', summary: 'Did stuff.', date: '2026-04-27',
  });
  assert.equal(r2.changed, false);
});
