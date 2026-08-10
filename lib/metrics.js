// lib/metrics.js — Forge metrics catalog, profiles, and pair helpers.
//
// Metric keys in pair.json efficiency maps stay free-form for backward
// compatibility, but known keys carry unit/direction/role metadata so report
// wording and comparability do not depend on name regexes alone.
//
// Profiles name ordered sets of keys a run may capture, score, or report.
// Capture, score, and report are independent planes — a run can capture
// capacity telemetry while scoring only the efficiency profile.
//
// Sign convention (unchanged from report D2):
//   delta = control − variant
//   pctSaved > 0 means the variant value is lower than control

export const CATALOG_VERSION = 1;

/** @typedef {'lower-is-better' | 'higher-is-better' | 'neutral'} MetricDirection */
/** @typedef {'decision' | 'diagnostic'} MetricRole */

/**
 * @typedef {object} MetricDef
 * @property {string} unit
 * @property {MetricDirection} direction
 * @property {'mean' | 'sum' | 'last'} aggregation
 * @property {MetricRole} role
 * @property {string} label
 */

/** @type {Record<string, MetricDef>} */
export const METRIC_CATALOG = {
  latencyMs: {
    unit: 'ms',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'decision',
    label: 'latency ms',
  },
  modelMs: {
    unit: 'ms',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'model ms',
  },
  ttfcMs: {
    unit: 'ms',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'ttfc ms',
  },
  totalTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'decision',
    label: 'total tokens',
  },
  inputTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'input tokens',
  },
  outputTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'output tokens',
  },
  cachedInputTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'cached input tokens',
  },
  freshInputTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'fresh input tokens',
  },
  reasoningTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'reasoning tokens',
  },
  reasoningSegments: {
    unit: 'count',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'reasoning segments',
  },
  reasoningChars: {
    unit: 'chars',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'reasoning chars',
  },
  estimatedCostUsd: {
    unit: 'usd',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'estimated cost usd',
  },
  modelCalls: {
    unit: 'count',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'model calls',
  },
  modelCallsPerSolve: {
    unit: 'count',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'model calls per solve',
  },
  toolCalls: {
    unit: 'count',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'tool calls',
  },
  // Capacity / fill. Headroom is remaining fraction (1 − fill); higher is safer.
  // Fill itself is reported as diagnostic risk context, not a savings target.
  contextFillRatio: {
    unit: 'ratio',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'context fill ratio',
  },
  contextHeadroomRatio: {
    unit: 'ratio',
    direction: 'higher-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'context headroom ratio',
  },
  contextWindowTokens: {
    unit: 'tokens',
    direction: 'neutral',
    aggregation: 'last',
    role: 'diagnostic',
    label: 'context window tokens',
  },
  contextInputTokens: {
    unit: 'tokens',
    direction: 'lower-is-better',
    aggregation: 'mean',
    role: 'diagnostic',
    label: 'context input tokens',
  },
  // streamCalls capacity can disagree with inputSnapshots; keep separate.
  streamContextWindowTokens: {
    unit: 'tokens',
    direction: 'neutral',
    aggregation: 'last',
    role: 'diagnostic',
    label: 'stream context window tokens',
  },
};

/**
 * Ordered metric profiles. Each level includes the previous level's keys.
 * forensic is a capture/report detail plane, not an automatic score set —
 * it reuses capacity keys and leaves raw envelopes/logs out of pair math.
 */
export const METRIC_PROFILES = {
  core: ['latencyMs', 'toolCalls'],
  efficiency: [
    'latencyMs',
    'modelMs',
    'ttfcMs',
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'freshInputTokens',
    'reasoningTokens',
    'reasoningSegments',
    'reasoningChars',
    'estimatedCostUsd',
    'modelCalls',
    'modelCallsPerSolve',
    'toolCalls',
  ],
  capacity: [
    'latencyMs',
    'modelMs',
    'ttfcMs',
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'freshInputTokens',
    'reasoningTokens',
    'reasoningSegments',
    'reasoningChars',
    'estimatedCostUsd',
    'modelCalls',
    'modelCallsPerSolve',
    'toolCalls',
    'contextFillRatio',
    'contextHeadroomRatio',
    'contextWindowTokens',
    'contextInputTokens',
    'streamContextWindowTokens',
  ],
  forensic: [
    'latencyMs',
    'modelMs',
    'ttfcMs',
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'freshInputTokens',
    'reasoningTokens',
    'reasoningSegments',
    'reasoningChars',
    'estimatedCostUsd',
    'modelCalls',
    'modelCallsPerSolve',
    'toolCalls',
    'contextFillRatio',
    'contextHeadroomRatio',
    'contextWindowTokens',
    'contextInputTokens',
    'streamContextWindowTokens',
  ],
};

export function isKnownMetric(key) {
  return Object.prototype.hasOwnProperty.call(METRIC_CATALOG, key);
}

export function profileKeys(profile) {
  const keys = METRIC_PROFILES[profile];
  if (!keys) {
    throw new Error(`metrics: unknown profile "${profile}" (expected ${Object.keys(METRIC_PROFILES).join('|')})`);
  }
  return keys.slice();
}

/**
 * Resolve catalog metadata for a key. Unknown keys stay valid for backward
 * compatibility and default to lower-is-better count wording (report D2).
 */
export function resolveMetric(key) {
  const def = METRIC_CATALOG[key];
  if (def) {
    return { key, known: true, ...def };
  }
  const isTime = /ms$|latency|ttfc|time/i.test(key);
  return {
    key,
    known: false,
    unit: isTime ? 'ms' : 'count',
    direction: /** @type {MetricDirection} */ ('lower-is-better'),
    aggregation: /** @type {'mean'} */ ('mean'),
    role: /** @type {MetricRole} */ ('diagnostic'),
    label: humanizeFallback(key),
  };
}

function humanizeFallback(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

export function humanizeMetric(key) {
  const def = METRIC_CATALOG[key];
  return def ? def.label : humanizeFallback(key);
}

/**
 * Pair savings entry. delta = control − variant. pctSaved is percent of control.
 * Missing or zero control yields null delta/pctSaved (never fabricate).
 */
export function savings(controlMean, variantMean) {
  const control = typeof controlMean === 'number' && !Number.isNaN(controlMean) ? controlMean : null;
  const variant = typeof variantMean === 'number' && !Number.isNaN(variantMean) ? variantMean : null;
  if (control == null || variant == null || control === 0) {
    return {
      control,
      variant,
      delta: null,
      pctSaved: null,
    };
  }
  const delta = control - variant;
  return {
    control: round2(control),
    variant: round2(variant),
    delta: round2(delta),
    pctSaved: round2((delta / control) * 100),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Build an efficiency map for a scored profile from flat mean maps.
 * Only known profile keys present on either side are included.
 */
export function buildEfficiency(controlMeans, variantMeans, scoredProfile = 'efficiency') {
  const keys = profileKeys(scoredProfile);
  /** @type {Record<string, ReturnType<typeof savings>>} */
  const out = {};
  for (const key of keys) {
    const c = controlMeans?.[key];
    const v = variantMeans?.[key];
    if (c == null && v == null) {
      continue;
    }
    out[key] = savings(c, v);
  }
  return out;
}

/**
 * Direction-aware change wording. pctSaved > 0 means variant value is lower.
 * - lower-is-better time → faster/slower
 * - lower-is-better other → fewer/more
 * - higher-is-better → more/less (of the good quantity)
 * - neutral → lower/higher
 */
export function fmtChange(key, pctSaved) {
  if (pctSaved == null || Number.isNaN(pctSaved)) {
    return 'n/a';
  }
  if (pctSaved === 0) {
    return 'no change';
  }
  const abs = Math.abs(pctSaved);
  const variantLower = pctSaved > 0;
  const { direction, unit } = resolveMetric(key);

  if (direction === 'neutral') {
    return `${abs}% ${variantLower ? 'lower' : 'higher'}`;
  }
  if (direction === 'higher-is-better') {
    // variantLower means less of the good thing.
    return `${abs}% ${variantLower ? 'less' : 'more'}`;
  }
  // lower-is-better
  const isTime = unit === 'ms' || /ms$|latency|ttfc|time/i.test(key);
  if (isTime) {
    return `${abs}% ${variantLower ? 'faster' : 'slower'}`;
  }
  return `${abs}% ${variantLower ? 'fewer' : 'more'}`;
}

/**
 * Provenance block for pair.json / bundle manifest / REPORT.json.
 * requested/captured/scored/reported are independent profile names.
 */
export function declareMetrics({
  requested = 'efficiency',
  captured = requested,
  scored = 'efficiency',
  reported = scored,
  kashVersion = null,
  model = null,
  pricingEpoch = null,
  extra = null,
} = {}) {
  // Validate profiles early so bad names fail at declaration, not at report.
  profileKeys(requested);
  profileKeys(captured);
  profileKeys(scored);
  profileKeys(reported);
  return {
    catalogVersion: CATALOG_VERSION,
    requested,
    captured,
    scored,
    reported,
    scoredKeys: profileKeys(scored),
    kashVersion,
    model,
    pricingEpoch,
    declaredAt: new Date().toISOString(),
    ...(extra && typeof extra === 'object' ? { extra } : {}),
  };
}

/**
 * Honest pair comparability: scored profile + catalog version must match.
 * Legacy pair.json without a metrics block remains comparable to other legacy.
 */
export function compareScoredProfiles(a, b) {
  if (a == null && b == null) {
    return { comparable: true, legacy: true, reason: null };
  }
  if (a == null || b == null) {
    return {
      comparable: false,
      legacy: false,
      reason: 'one side lacks metrics provenance; refuse mixed legacy/catalog pairs',
    };
  }
  if (a.catalogVersion !== b.catalogVersion) {
    return {
      comparable: false,
      legacy: false,
      reason: `catalog version mismatch (${a.catalogVersion} vs ${b.catalogVersion})`,
    };
  }
  if (a.scored !== b.scored) {
    return {
      comparable: false,
      legacy: false,
      reason: `scored profile mismatch (${a.scored} vs ${b.scored})`,
    };
  }
  return { comparable: true, legacy: false, reason: null };
}
