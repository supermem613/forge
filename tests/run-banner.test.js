import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRunBanner } from '../lib/run-context.js';

const FAKE_CTX = {
  experiment: 'demo',
  variant: 'mark-2',
  isControl: false,
  samples: 5,
  evals: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  manifest: {
    id: 'create-skill',
    version: '1.2.3',
    description: 'Author a skill',
  },
  experimentJson: { description: 'Mark-2: tighter rubric' },
  urlParams: { active: 'foo=bar' },
};

test('formatRunBanner: includes runbook id+version+description', () => {
  const out = formatRunBanner(FAKE_CTX);
  assert.match(out, /create-skill@1\.2\.3/);
  assert.match(out, /Author a skill/);
});

test('formatRunBanner: includes experiment description and variant', () => {
  const out = formatRunBanner(FAKE_CTX);
  assert.match(out, /Mark-2: tighter rubric/);
  assert.match(out, /variant:\s+mark-2/);
});

test('formatRunBanner: lists eval ids inline', () => {
  const out = formatRunBanner(FAKE_CTX);
  assert.match(out, /evals:\s+3\s+\[a, b, c\]/);
});

test('formatRunBanner: marks control runs explicitly', () => {
  const out = formatRunBanner({ ...FAKE_CTX, variant: 'control', isControl: true });
  assert.match(out, /variant:\s+control \(control\)/);
  assert.match(out, /\(control\)/);
});

test('formatRunBanner: handles missing optional fields', () => {
  const minimal = {
    experiment: 'x', variant: 'control', isControl: true, samples: 1,
    evals: [],
    manifest: { id: 'rb', version: '0.1.0' },
    experimentJson: {},
    urlParams: { active: '' },
  };
  const out = formatRunBanner(minimal);
  assert.match(out, /urlParams:\s+<none>/);
  assert.match(out, /evals:\s+0/);
});
