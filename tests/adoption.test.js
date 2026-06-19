// tests/adoption.test.js — generic code-mode adoption metric.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verbCallCounts, verbInSignatures, sampleAdoption, adoptionFromSamples,
  readRunAdoption, checkAdoptionGate,
} from '../lib/adoption.js';

function dtCode(code) {
  return { input: { code }, output: { result: {} } };
}
function dtDescribe(tools, signatures) {
  return { input: { tools }, output: { result: { signatures } } };
}
function sample(toolDetails) {
  return { response: { toolDetails } };
}

test('verbCallCounts counts every tools.<ns>.<verb>( invocation', () => {
  const counts = verbCallCounts('await tools.files.search({}); tools.files.search({}); tools.files.extract({})');
  assert.equal(counts.get('files.search'), 2);
  assert.equal(counts.get('files.extract'), 1);
  assert.equal(counts.has('files.aggregate'), false);
});

test('verbInSignatures detects a nested-TS member, not a dotted path', () => {
  const sig = 'declare const tools: {\n  files: {\n    aggregate(input: {}): X;\n    search(input: {}): Y;\n  }\n}';
  assert.equal(verbInSignatures(sig, 'files.aggregate'), true);
  assert.equal(verbInSignatures(sig, 'files.search'), true);
  assert.equal(verbInSignatures(sig, 'files.select'), false);
  assert.equal(verbInSignatures('', 'files.aggregate'), false);
});

test('sampleAdoption separates requested, surfaced, called, hand-reduce', () => {
  const sig = 'declare const tools: {\n  files: { search(input:{}):X; extract(input:{}):Y; aggregate(input:{}):Z; }\n}';
  const s = sample([
    dtDescribe(['tools.files.search', 'tools.files.extract'], sig),
    dtCode('const hits = await tools.files.search({}); const recs = await tools.files.extract({}); const g = recs.reduce((a,b)=>a,[]);'),
  ]);
  const a = sampleAdoption(s);
  assert.deepEqual([...a.requested].sort(), ['files.extract', 'files.search']);
  assert.equal(a.called.has('files.search'), true);
  assert.equal(a.called.has('files.extract'), true);
  assert.equal(a.called.has('files.aggregate'), false);
  assert.equal(a.handReduce, true); // .reduce(
  assert.equal(verbInSignatures(a.signatures, 'files.aggregate'), true);
});

test('adoptionFromSamples flags a surfaced-but-never-called verb as dead', () => {
  const sig = 'declare const tools: {\n  files: { search(input:{}):X; extract(input:{}):Y; aggregate(input:{}):Z; }\n}';
  const samples = Array.from({ length: 4 }, (_, i) => ({
    evalId: 'e', sample: i + 1,
    data: sample([
      dtDescribe(['tools.files.search', 'tools.files.extract'], sig),
      dtCode('await tools.files.search({}); await tools.files.extract({}); const m = new Map();'),
    ]),
  }));
  const ad = adoptionFromSamples(samples, { knownVerbs: ['files.search', 'files.extract', 'files.aggregate'] });
  assert.equal(ad.n, 4);
  assert.equal(ad.perVerb['files.search'].called, 4);
  assert.equal(ad.perVerb['files.aggregate'].surfaced, 4);
  assert.equal(ad.perVerb['files.aggregate'].called, 0);
  assert.equal(ad.perVerb['files.aggregate'].deadInCorpus, true);
  assert.deepEqual(ad.deadVerbs, ['files.aggregate']);
  assert.equal(ad.handReduce.count, 4);
  assert.equal(ad.handReduce.rate, 1);
});

test('checkAdoptionGate fails when expected verb is under-called', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({
    evalId: 'e', sample: i + 1,
    data: sample([dtCode('await tools.files.search({}); await tools.files.extract({});')]),
  }));
  const ad = adoptionFromSamples(samples);
  const g1 = checkAdoptionGate(ad, { expectVerb: 'files.aggregate', minCalledRate: 0.7 });
  assert.equal(g1.pass, false);
  assert.match(g1.failures[0], /files\.aggregate called in 0\/10/);
  const g2 = checkAdoptionGate(ad, { expectVerb: 'files.search', minCalledRate: 0.9 });
  assert.equal(g2.pass, true);
});

test('readRunAdoption reads turn1 artifacts and parses evalId/sample from filename', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-adopt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const turn1 = path.join(dir, 'turn1');
  await fs.mkdir(turn1, { recursive: true });
  await fs.writeFile(path.join(turn1, '04-policy-sample1.json'),
    JSON.stringify(sample([dtCode('await tools.files.search({}); const x = arr.reduce((a,b)=>a,0);')])));
  await fs.writeFile(path.join(turn1, '04-policy-sample2.json'),
    JSON.stringify(sample([dtCode('await tools.files.search({});')])));
  const ad = await readRunAdoption(dir);
  assert.equal(ad.n, 2);
  assert.equal(ad.perVerb['files.search'].called, 2);
  assert.equal(ad.handReduce.count, 1);
  assert.equal(ad.bySample.find((b) => b.sample === 1).handReduce, true);
  assert.equal(ad.source.readError, null);
  assert.equal(ad.source.sampleFiles, 2);
});

test('readRunAdoption marks a missing turn1 dir as a read error (no false-green)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-adopt-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ad = await readRunAdoption(dir);
  assert.equal(ad.n, 0);
  assert.ok(ad.source.readError, 'readError should be set when turn1/ is absent');
  assert.equal(ad.source.sampleFiles, 0);
});
