// lib/score.js — pure deterministic scoring functions.
//
// Each function takes (actual, expected, opts?) and returns
//   { pass: boolean, score: number in [0,1], details: object }
//
// No I/O, no randomness. Used by experiment score.js scripts.

export function toolParamsMatch(actual, expected) {
  // actual: tool invocation object
  // expected: { name?: string|RegExp, params: { key: matcher }, requireOutput?: bool }
  const details = { mismatches: [] };
  if (!actual) {
    return { pass: false, score: 0, details: { reason: 'no tool call' } };
  }
  if (expected.name) {
    const ok = expected.name instanceof RegExp
      ? expected.name.test(actual.toolName)
      : actual.toolName === expected.name;
    if (!ok) {
      details.mismatches.push({ field: 'toolName', expected: String(expected.name), actual: actual.toolName });
    }
  }
  const params = expected.params || expected.expectedToolParams || {};
  for (const [k, matcher] of Object.entries(params)) {
    const v = actual.input?.[k];
    if (matcher && typeof matcher === 'object') {
      if (matcher.regex) {
        const re = new RegExp(matcher.regex);
        if (!re.test(String(v ?? ''))) {
          details.mismatches.push({ field: k, expected: matcher.regex, actual: v });
        }
      }
      if (matcher.maxLength != null && String(v ?? '').length > matcher.maxLength) {
        details.mismatches.push({ field: k, expected: `<=${matcher.maxLength} chars`, actual: String(v ?? '').length });
      }
      if (matcher.minBytes != null && Buffer.byteLength(String(v ?? ''), 'utf8') < matcher.minBytes) {
        details.mismatches.push({ field: k, expected: `>=${matcher.minBytes} bytes`, actual: Buffer.byteLength(String(v ?? ''), 'utf8') });
      }
      if (matcher.maxBytes != null && Buffer.byteLength(String(v ?? ''), 'utf8') > matcher.maxBytes) {
        details.mismatches.push({ field: k, expected: `<=${matcher.maxBytes} bytes`, actual: Buffer.byteLength(String(v ?? ''), 'utf8') });
      }
      if (matcher.equals !== undefined && v !== matcher.equals) {
        details.mismatches.push({ field: k, expected: matcher.equals, actual: v });
      }
    } else if (typeof matcher === 'string' || typeof matcher === 'number') {
      if (v !== matcher) {
        details.mismatches.push({ field: k, expected: matcher, actual: v });
      }
    }
  }
  if (expected.requireOutput && !actual.output) {
    details.mismatches.push({ field: 'output', expected: 'non-empty', actual: actual.output });
  }
  const pass = details.mismatches.length === 0;
  return { pass, score: pass ? 1 : 0, details };
}

export function valueExtraction(responseText, expected) {
  // expected: { mustInclude?: string[], mustIncludeRegex?: string[], minBullets?: number }
  const text = String(responseText || '');
  const details = { missing: [], present: [] };
  for (const s of expected.mustInclude || []) {
    if (text.includes(s)) {
      details.present.push(s);
    } else {
      details.missing.push(s);
    }
  }
  for (const r of expected.mustIncludeRegex || []) {
    const re = new RegExp(r);
    if (re.test(text)) {
      details.present.push(r);
    } else {
      details.missing.push(r);
    }
  }
  let bulletPass = true;
  if (expected.minBullets != null) {
    const bullets = (text.match(/^[\s]*[-*•]\s+/gm) || []).length;
    details.bullets = bullets;
    bulletPass = bullets >= expected.minBullets;
  }
  const pass = details.missing.length === 0 && bulletPass;
  const totalChecks =
    (expected.mustInclude?.length || 0) +
    (expected.mustIncludeRegex?.length || 0) +
    (expected.minBullets != null ? 1 : 0);
  const passed = (details.present.length) + (bulletPass && expected.minBullets != null ? 1 : 0);
  return {
    pass,
    score: totalChecks > 0 ? passed / totalChecks : (pass ? 1 : 0),
    details,
  };
}

export function contentEquivalence(actualText, expectedText, opts = {}) {
  // Cheap jaccard on whitespace-tokenized lowercased content.
  const tok = s => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const a = tok(actualText);
  const b = tok(expectedText);
  if (a.size === 0 && b.size === 0) {
    return { pass: true, score: 1, details: { jaccard: 1, reason: 'both empty' } };
  }
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) {
      intersect++;
    }
  }
  const union = a.size + b.size - intersect;
  const jaccard = union === 0 ? 0 : intersect / union;
  const threshold = opts.threshold ?? 0.4;
  return { pass: jaccard >= threshold, score: jaccard, details: { jaccard, threshold, aSize: a.size, bSize: b.size } };
}

export function entityPreservation(actualText, expectedEntities) {
  // expectedEntities: string[] — each must appear in actualText (case-insensitive)
  const text = String(actualText || '').toLowerCase();
  const present = expectedEntities.filter(e => text.includes(String(e).toLowerCase()));
  const missing = expectedEntities.filter(e => !text.includes(String(e).toLowerCase()));
  return {
    pass: missing.length === 0,
    score: expectedEntities.length === 0 ? 1 : present.length / expectedEntities.length,
    details: { present, missing },
  };
}

export function structuralChecks(actual, checks) {
  // actual: { frontmatter?: object, body?: string, raw?: string }
  // checks: array of { type, ... }
  const failures = [];
  for (const c of checks) {
    switch (c.type) {
      case 'frontmatter_has': {
        if (!actual.frontmatter || actual.frontmatter[c.field] == null) {
          failures.push({ check: c, reason: 'missing frontmatter field' });
        }
        break;
      }
      case 'frontmatter_field_max_chars': {
        const v = actual.frontmatter?.[c.field];
        if (v != null && String(v).length > c.max) {
          failures.push({ check: c, reason: `field too long: ${String(v).length} > ${c.max}` });
        }
        break;
      }
      case 'body_size_bytes': {
        const len = Buffer.byteLength(String(actual.body || actual.raw || ''), 'utf8');
        if (c.min != null && len < c.min) {
          failures.push({ check: c, reason: `body too small: ${len} < ${c.min}` });
        }
        if (c.max != null && len > c.max) {
          failures.push({ check: c, reason: `body too large: ${len} > ${c.max}` });
        }
        break;
      }
      case 'body_includes': {
        if (!String(actual.body || actual.raw || '').includes(c.value)) {
          failures.push({ check: c, reason: `body missing required substring: ${c.value}` });
        }
        break;
      }
      default:
        failures.push({ check: c, reason: `unknown check type: ${c.type}` });
    }
  }
  const pass = failures.length === 0;
  return { pass, score: pass ? 1 : Math.max(0, 1 - failures.length / checks.length), details: { failures } };
}

export function aggregate(rows) {
  // rows: number[] -> { n, mean, stddev, min, p50, p95, p99, max, cv }
  if (!rows || rows.length === 0) {
    return { n: 0 };
  }
  const sorted = [...rows].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const at = q => sorted[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    mean,
    stddev,
    cv: mean === 0 ? 0 : stddev / mean,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[n - 1],
  };
}

export function parseFrontmatter(markdownText) {
  // Very small YAML-frontmatter parser: parses k: v lines until --- terminator.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdownText || '');
  if (!m) {
    return { frontmatter: null, body: markdownText || '' };
  }
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!km) {
      continue;
    }
    let v = km[2].trim();
    // strip quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[km[1]] = v;
  }
  return { frontmatter: fm, body: m[2] };
}
