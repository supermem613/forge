// tests/metrics.test.js — metrics catalog, profiles, savings, direction, provenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_VERSION,
  METRIC_CATALOG,
  METRIC_PROFILES,
  resolveMetric,
  profileKeys,
  savings,
  buildEfficiency,
  fmtChange,
  humanizeMetric,
  declareMetrics,
  compareScoredProfiles,
  isKnownMetric,
} from '../lib/metrics.js';

test('catalog version is a positive integer', () => {
  assert.equal(typeof CATALOG_VERSION, 'number');
  assert.ok(CATALOG_VERSION >= 1);
});

test('every profile key exists in the catalog', () => {
  for (const [name, keys] of Object.entries(METRIC_PROFILES)) {
    assert.ok(keys.length > 0, name);
    for (const key of keys) {
      assert.ok(isKnownMetric(key), `${name} -> ${key}`);
      const m = resolveMetric(key);
      assert.equal(m.key, key);
      assert.ok(['lower-is-better', 'higher-is-better', 'neutral'].includes(m.direction));
      assert.ok(['decision', 'diagnostic'].includes(m.role));
      assert.ok(m.unit);
    }
  }
});

test('profiles nest: core is contained in efficiency, efficiency in capacity', () => {
  const core = new Set(profileKeys('core'));
  const efficiency = new Set(profileKeys('efficiency'));
  const capacity = new Set(profileKeys('capacity'));
  for (const k of core) {
    assert.ok(efficiency.has(k), k);
  }
  for (const k of efficiency) {
    assert.ok(capacity.has(k), k);
  }
});

test('savings: lower-is-better pctSaved positive when variant spends less', () => {
  const s = savings(1000, 800);
  assert.equal(s.control, 1000);
  assert.equal(s.variant, 800);
  assert.equal(s.delta, 200);
  assert.equal(s.pctSaved, 20);
});

test('savings: null sides stay null, never fabricated zero', () => {
  assert.deepEqual(savings(null, 10), {
    control: null, variant: 10, delta: null, pctSaved: null,
  });
  assert.deepEqual(savings(10, null), {
    control: 10, variant: null, delta: null, pctSaved: null,
  });
  assert.deepEqual(savings(0, 5), {
    control: 0, variant: 5, delta: null, pctSaved: null,
  });
});

test('buildEfficiency filters to scored profile keys and skips unknown', () => {
  const eff = buildEfficiency(
    { latencyMs: 1000, totalTokens: 5000, secretSauce: 1 },
    { latencyMs: 800, totalTokens: 4000, secretSauce: 2 },
    'core',
  );
  assert.ok(eff.latencyMs);
  assert.equal(eff.latencyMs.pctSaved, 20);
  assert.equal(eff.totalTokens, undefined);
  assert.equal(eff.secretSauce, undefined);
});

test('fmtChange: time metrics use faster/slower', () => {
  assert.equal(fmtChange('latencyMs', 20), '20% faster');
  assert.equal(fmtChange('modelMs', -10), '10% slower');
});

test('fmtChange: count/token metrics use fewer/more', () => {
  assert.equal(fmtChange('totalTokens', 15), '15% fewer');
  assert.equal(fmtChange('modelCalls', -5), '5% more');
});

test('fmtChange: higher-is-better metrics invert wording', () => {
  assert.equal(fmtChange('contextHeadroomRatio', 20), '20% less');
  assert.equal(fmtChange('contextHeadroomRatio', -10), '10% more');
});

test('fmtChange: neutral metrics use lower/higher not better/worse', () => {
  assert.equal(fmtChange('contextWindowTokens', 5), '5% lower');
  assert.equal(fmtChange('contextWindowTokens', -5), '5% higher');
});

test('fmtChange: null and zero', () => {
  assert.equal(fmtChange('latencyMs', null), 'n/a');
  assert.equal(fmtChange('latencyMs', 0), 'no change');
});

test('unknown metric falls back to lower-is-better count wording', () => {
  const m = resolveMetric('customWidgetCount');
  assert.equal(m.direction, 'lower-is-better');
  assert.equal(m.known, false);
  assert.equal(fmtChange('customWidgetCount', 10), '10% fewer');
});

test('humanizeMetric prefers catalog label', () => {
  assert.equal(humanizeMetric('ttfcMs'), METRIC_CATALOG.ttfcMs.label);
  assert.equal(humanizeMetric('weirdThingMs'), 'weird thing ms');
});

test('declareMetrics records requested/captured/scored/reported and provenance', () => {
  const d = declareMetrics({
    requested: 'capacity',
    captured: 'capacity',
    scored: 'efficiency',
    reported: 'efficiency',
    kashVersion: '1.9.0',
    model: 'gpt-test',
  });
  assert.equal(d.catalogVersion, CATALOG_VERSION);
  assert.equal(d.requested, 'capacity');
  assert.equal(d.captured, 'capacity');
  assert.equal(d.scored, 'efficiency');
  assert.equal(d.reported, 'efficiency');
  assert.equal(d.kashVersion, '1.9.0');
  assert.equal(d.model, 'gpt-test');
  assert.deepEqual(d.scoredKeys, profileKeys('efficiency'));
  assert.ok(d.declaredAt);
});

test('compareScoredProfiles: same scored profile is comparable', () => {
  const a = declareMetrics({ scored: 'efficiency', captured: 'capacity' });
  const b = declareMetrics({ scored: 'efficiency', captured: 'efficiency' });
  const c = compareScoredProfiles(a, b);
  assert.equal(c.comparable, true);
  assert.equal(c.reason, null);
});

test('compareScoredProfiles: different scored profiles are not comparable', () => {
  const a = declareMetrics({ scored: 'core' });
  const b = declareMetrics({ scored: 'efficiency' });
  const c = compareScoredProfiles(a, b);
  assert.equal(c.comparable, false);
  assert.match(c.reason, /scored profile/i);
});

test('compareScoredProfiles: missing metrics block is legacy-compatible', () => {
  const c = compareScoredProfiles(null, null);
  assert.equal(c.comparable, true);
  assert.equal(c.legacy, true);
});

test('compareScoredProfiles: catalog version mismatch is not comparable', () => {
  const a = declareMetrics({ scored: 'efficiency' });
  const b = { ...declareMetrics({ scored: 'efficiency' }), catalogVersion: CATALOG_VERSION + 1 };
  const c = compareScoredProfiles(a, b);
  assert.equal(c.comparable, false);
  assert.match(c.reason, /catalog/i);
});
