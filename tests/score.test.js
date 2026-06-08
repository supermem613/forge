// tests/score.test.js — pure scoring function contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolParamsMatch,
  valueExtraction,
  contentEquivalence,
  entityPreservation,
  structuralChecks,
  aggregate,
  parseFrontmatter,
} from '../lib/score.js';

test('toolParamsMatch: missing actual returns pass=false', () => {
  const r = toolParamsMatch(null, { name: 'create_document' });
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
  assert.equal(r.details.reason, 'no tool call');
});

test('toolParamsMatch: exact name match', () => {
  const r = toolParamsMatch(
    { toolName: 'create_document', input: { name: 'FooDoc' } },
    { name: 'create_document', params: { name: 'FooDoc' } },
  );
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('toolParamsMatch: regex name matcher', () => {
  const r = toolParamsMatch(
    { toolName: 'create_document_v2', input: {} },
    { name: /^create_document/ },
  );
  assert.equal(r.pass, true);
});

test('toolParamsMatch: name mismatch surfaces in mismatches', () => {
  const r = toolParamsMatch(
    { toolName: 'other_tool', input: {} },
    { name: 'create_document' },
  );
  assert.equal(r.pass, false);
  assert.equal(r.details.mismatches[0].field, 'toolName');
});

test('toolParamsMatch: param regex matcher', () => {
  const r = toolParamsMatch(
    { toolName: 't', input: { body: 'hello world 123' } },
    { params: { body: { regex: '\\d+' } } },
  );
  assert.equal(r.pass, true);
});

test('toolParamsMatch: param minBytes violation', () => {
  const r = toolParamsMatch(
    { toolName: 't', input: { body: 'hi' } },
    { params: { body: { minBytes: 10 } } },
  );
  assert.equal(r.pass, false);
  assert.equal(r.details.mismatches[0].field, 'body');
});

test('toolParamsMatch: requireOutput flag', () => {
  const r = toolParamsMatch(
    { toolName: 't', input: {}, output: null },
    { requireOutput: true },
  );
  assert.equal(r.pass, false);
});

test('valueExtraction: all mustInclude present', () => {
  const r = valueExtraction('Alice and Bob went to Paris', { mustInclude: ['Alice', 'Bob'] });
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('valueExtraction: missing substring', () => {
  const r = valueExtraction('only alice here', { mustInclude: ['Bob'] });
  assert.equal(r.pass, false);
  assert.deepEqual(r.details.missing, ['Bob']);
});

test('valueExtraction: regex match', () => {
  const r = valueExtraction('order 42 shipped', { mustIncludeRegex: ['order \\d+'] });
  assert.equal(r.pass, true);
});

test('valueExtraction: minBullets counts markdown bullets', () => {
  const text = '- first\n- second\n* third\n';
  const r = valueExtraction(text, { minBullets: 3 });
  assert.equal(r.pass, true);
  assert.equal(r.details.bullets, 3);
});

test('valueExtraction: minBullets not met', () => {
  const r = valueExtraction('- one', { minBullets: 2 });
  assert.equal(r.pass, false);
});

test('valueExtraction: partial score on some includes missing', () => {
  const r = valueExtraction('only one', { mustInclude: ['only', 'missing'] });
  assert.equal(r.pass, false);
  assert.ok(r.score > 0 && r.score < 1);
});

test('contentEquivalence: identical text jaccard 1', () => {
  const r = contentEquivalence('hello world', 'hello world');
  assert.equal(r.score, 1);
  assert.equal(r.pass, true);
});

test('contentEquivalence: disjoint fails default threshold', () => {
  const r = contentEquivalence('apple banana', 'zebra xylophone');
  assert.equal(r.score, 0);
  assert.equal(r.pass, false);
});

test('contentEquivalence: both empty returns score 1', () => {
  const r = contentEquivalence('', '');
  assert.equal(r.score, 1);
});

test('contentEquivalence: custom threshold', () => {
  const r = contentEquivalence('a b c', 'a b d', { threshold: 0.4 });
  assert.equal(r.pass, true);
  assert.equal(r.score, 0.5);
});

test('entityPreservation: all present case-insensitive', () => {
  const r = entityPreservation('The Paris Accord mentions Alice.', ['paris', 'ALICE']);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('entityPreservation: missing entity', () => {
  const r = entityPreservation('only paris', ['Paris', 'Rome']);
  assert.equal(r.pass, false);
  assert.deepEqual(r.details.missing, ['Rome']);
});

test('entityPreservation: empty entity list returns pass=true score=1', () => {
  const r = entityPreservation('anything', []);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('structuralChecks: frontmatter_has missing', () => {
  const r = structuralChecks({ frontmatter: {} }, [{ type: 'frontmatter_has', field: 'name' }]);
  assert.equal(r.pass, false);
});

test('structuralChecks: frontmatter_field_max_chars violation', () => {
  const r = structuralChecks(
    { frontmatter: { description: 'x'.repeat(200) } },
    [{ type: 'frontmatter_field_max_chars', field: 'description', max: 150 }],
  );
  assert.equal(r.pass, false);
  assert.match(r.details.failures[0].reason, /too long/);
});

test('structuralChecks: body_size_bytes enforces min and max', () => {
  const small = structuralChecks({ body: 'hi' }, [{ type: 'body_size_bytes', min: 100 }]);
  assert.equal(small.pass, false);
  const big = structuralChecks({ body: 'x'.repeat(2000) }, [{ type: 'body_size_bytes', max: 1000 }]);
  assert.equal(big.pass, false);
});

test('structuralChecks: body_includes present', () => {
  const r = structuralChecks({ body: 'contains SENTINEL string' }, [{ type: 'body_includes', value: 'SENTINEL' }]);
  assert.equal(r.pass, true);
});

test('structuralChecks: unknown check type fails', () => {
  const r = structuralChecks({ body: '' }, [{ type: 'bogus' }]);
  assert.equal(r.pass, false);
});

test('structuralChecks: partial score when 1 of 2 fails', () => {
  const r = structuralChecks(
    { body: 'x'.repeat(500) },
    [
      { type: 'body_size_bytes', min: 100 },
      { type: 'body_includes', value: 'MISSING' },
    ],
  );
  assert.equal(r.pass, false);
  assert.equal(r.score, 0.5);
});

test('aggregate: stats on small sample', () => {
  const r = aggregate([1, 2, 3, 4, 5]);
  assert.equal(r.n, 5);
  assert.equal(r.mean, 3);
  assert.equal(r.min, 1);
  assert.equal(r.max, 5);
  assert.ok(r.stddev > 0);
});

test('aggregate: empty returns n=0', () => {
  const r = aggregate([]);
  assert.equal(r.n, 0);
});

test('aggregate: constant series has stddev 0', () => {
  const r = aggregate([7, 7, 7, 7]);
  assert.equal(r.stddev, 0);
  assert.equal(r.cv, 0);
});

test('parseFrontmatter: basic frontmatter + body', () => {
  const md = '---\nname: foo\ndescription: "hello world"\n---\nbody text\n';
  const r = parseFrontmatter(md);
  assert.equal(r.frontmatter.name, 'foo');
  assert.equal(r.frontmatter.description, 'hello world');
  assert.match(r.body, /body text/);
});

test('parseFrontmatter: single-quoted value', () => {
  const md = "---\nname: 'foo'\n---\n";
  const r = parseFrontmatter(md);
  assert.equal(r.frontmatter.name, 'foo');
});

test('parseFrontmatter: no frontmatter returns null+body', () => {
  const r = parseFrontmatter('just a body with no frontmatter');
  assert.equal(r.frontmatter, null);
  assert.match(r.body, /just a body/);
});

test('parseFrontmatter: CRLF line endings', () => {
  const md = '---\r\nname: foo\r\n---\r\nbody\r\n';
  const r = parseFrontmatter(md);
  assert.equal(r.frontmatter.name, 'foo');
});

test('parseFrontmatter: empty input', () => {
  const r = parseFrontmatter('');
  assert.equal(r.frontmatter, null);
  assert.equal(r.body, '');
});
