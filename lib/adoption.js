// lib/adoption.js — generic code-mode tool-adoption metric.
//
// Three marks (mark-9..mark-11) of the spark-scenario-efficiency experiment
// were lost diagnosing adoption AFTER a full build+run+judge cycle, twice on a
// hand-harvested field read from the wrong path. This module turns adoption
// into a first-class, automatic, runbook-agnostic metric so a dead verb is
// caught from the run artifacts instead of from a multi-hour failed mark.
//
// For each turn1 sample it derives the adoption funnel:
//   REQUESTED — verb paths the model passed to describe_tools (input.tools).
//   SURFACED  — verbs whose signature came back (output.result.signatures).
//   CALLED    — verbs actually invoked in the executed programs (input.code).
//   HAND-REDUCE — the program fell back to raw JS reduction (.reduce/Map/Set)
//                 instead of a host verb. A verb that stays CALLED=0 while
//                 HAND-REDUCE stays high is the wrong primitive for the corpus.
//
// Verbs are auto-discovered from the artifacts (union of requested + called),
// so no per-runbook verb list is required. All functions are pure except
// readRunAdoption, which reads a run dir's turn1/ artifacts.

import { promises as fs } from 'node:fs';
import path from 'node:path';

// tools.<ns>.<verb>( in an executed program. Captures namespace + verb so the
// metric works for any host surface, not just files.*/lists.*.
const VERB_CALL_RE = /tools\.([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g;

// Raw-JS reduction the model writes when it bypasses a host reduce/aggregate
// verb. INVARIANT: keep this conservative — false positives here would mask a
// real adoption win by overstating hand-reduce.
const HAND_REDUCE_RE = /\.reduce\s*\(|new\s+Map\b|new\s+Set\b|\.groupBy\b|\bgroupBy\s*\(/;

export function programsFromSample(sample) {
  const tds = (sample && sample.response && sample.response.toolDetails) || [];
  return tds
    .filter((t) => t && t.input && typeof t.input.code === 'string')
    .map((t) => t.input.code);
}

export function describeCallsFromSample(sample) {
  const tds = (sample && sample.response && sample.response.toolDetails) || [];
  return tds
    .filter((t) => t && t.input && Array.isArray(t.input.tools))
    .map((t) => ({
      requested: t.input.tools.map((p) => String(p).replace(/^tools\./, '')),
      result: (t.output && t.output.result) || {},
    }));
}

// Verb-call counts (not just presence) across a program string. Returns a Map
// of `ns.verb` -> invocation count.
export function verbCallCounts(code) {
  const counts = new Map();
  if (typeof code !== 'string') {
    return counts;
  }
  VERB_CALL_RE.lastIndex = 0;
  let m;
  while ((m = VERB_CALL_RE.exec(code)) !== null) {
    const key = `${m[1]}.${m[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Best-effort: is `ns.verb` present in a nested-TS signatures block? The block
// shape is `ns: { /** ... */ verb(input: {...} ) }`, so a dotted "ns.verb"
// never appears literally. We require both the namespace header and a
// `verb(` member declaration. Cross-namespace collision is possible but rare;
// SURFACED is diagnostic, while CALLED/HAND-REDUCE are the authoritative gates.
export function verbInSignatures(signatures, verb) {
  if (typeof signatures !== 'string' || !signatures) {
    return false;
  }
  const dot = verb.indexOf('.');
  const ns = dot >= 0 ? verb.slice(0, dot) : '';
  const name = dot >= 0 ? verb.slice(dot + 1) : verb;
  if (!ns || !name) {
    return false;
  }
  const nsRe = new RegExp(`\\b${ns}\\s*:\\s*\\{`);
  const nameRe = new RegExp(`\\b${name}\\s*\\(`);
  return nsRe.test(signatures) && nameRe.test(signatures);
}

// Per-sample funnel. sample = the parsed turn1 JSON object.
export function sampleAdoption(sample, { handReduceRe = HAND_REDUCE_RE } = {}) {
  const code = programsFromSample(sample).join('\n/*--*/\n');
  const callCounts = verbCallCounts(code);
  const dcalls = describeCallsFromSample(sample);
  const requested = new Set();
  let signatures = '';
  for (const d of dcalls) {
    for (const r of d.requested) {
      requested.add(r);
    }
    if (typeof d.result.signatures === 'string') {
      signatures += `\n${d.result.signatures}`;
    }
  }
  const called = new Set(callCounts.keys());
  return {
    called,
    callCounts,
    requested,
    signatures,
    handReduce: handReduceRe.test(code),
    programChars: code.length,
    describeCalls: dcalls.length,
  };
}

// Aggregate adoption across many samples. samples = [{ evalId, sample, data }].
// `knownVerbs` lets a runbook declare its full host-verb catalog so a verb that
// is SURFACED but never requested or called still gets a perVerb entry and can
// be flagged dead. Generic TS parsing of signatures is intentionally avoided
// (nested `input: {` blocks collide with namespace headers); surfaced is
// instead computed precisely per known verb name via verbInSignatures.
export function adoptionFromSamples(samples, opts = {}) {
  const { knownVerbs = [] } = opts;
  const per = [];
  const verbSet = new Set(knownVerbs);
  for (const s of samples) {
    const a = sampleAdoption(s.data, opts);
    for (const v of a.called) {
      verbSet.add(v);
    }
    for (const v of a.requested) {
      verbSet.add(v);
    }
    per.push({ evalId: s.evalId, sample: s.sample, ...a });
  }
  const verbs = [...verbSet].sort();
  const n = per.length;
  const perVerb = {};
  for (const v of verbs) {
    let requested = 0;
    let surfaced = 0;
    let called = 0;
    let callTotal = 0;
    for (const p of per) {
      if (p.requested.has(v)) {
        requested++;
      }
      if (verbInSignatures(p.signatures, v)) {
        surfaced++;
      }
      if (p.called.has(v)) {
        called++;
        callTotal += p.callCounts.get(v) || 0;
      }
    }
    perVerb[v] = {
      surfaced,
      requested,
      called,
      callsPerSolveMean: n ? callTotal / n : 0,
      // A primitive the model is shown (surfaced) but never calls is dead
      // weight for this corpus. Surfaced-but-never-called is the fit signal.
      deadInCorpus: surfaced > 0 && called === 0,
    };
  }
  const handReduceCount = per.filter((p) => p.handReduce).length;
  return {
    n,
    verbs,
    perVerb,
    handReduce: { count: handReduceCount, rate: n ? handReduceCount / n : 0 },
    deadVerbs: verbs.filter((v) => perVerb[v].deadInCorpus),
    bySample: per.map((p) => ({
      evalId: p.evalId,
      sample: p.sample,
      called: [...p.called].sort(),
      requested: [...p.requested].sort(),
      handReduce: p.handReduce,
      programChars: p.programChars,
    })),
  };
}

const TURN_FILE_RE = /^(.*)-sample(\d+)\.json$/;

// Read a run dir's turn1/ artifacts and compute adoption. evalId + sample are
// parsed from the filename so this needs no results.json.
export async function readRunAdoption(runDir, opts = {}) {
  const turnDir = path.join(runDir, 'turn1');
  let entries;
  try {
    entries = await fs.readdir(turnDir);
  } catch (e) {
    const empty = adoptionFromSamples([], opts);
    empty.source = { turnDir, sampleFiles: 0, readError: e.code || 'EREAD' };
    return empty;
  }
  const samples = [];
  for (const f of entries.sort()) {
    const m = TURN_FILE_RE.exec(f);
    if (!m) {
      continue;
    }
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(turnDir, f), 'utf8'));
    } catch {
      continue;
    }
    samples.push({ evalId: m[1], sample: Number(m[2]), data });
  }
  const result = adoptionFromSamples(samples, opts);
  // Distinguish "no artifacts on disk" from "a real run with zero turn1 files"
  // so the pre-build probe cannot false-green on a bad --run path.
  result.source = { turnDir, sampleFiles: samples.length, readError: null };
  return result;
}

// Gate a run's adoption against an expectation. Used by the pre-build probe so
// a build that doesn't move adoption fails in minutes, not after a full run.
//   expectVerb   — verb path that must be CALLED (e.g. 'files.select')
//   minCalledRate— minimum fraction of samples that must call it (default 0.5)
//   maxHandReduceRate — optional ceiling on hand-reduce fallback
//   forbidDeadVerbs   — fail if any surfaced verb is never called
export function checkAdoptionGate(adoption, gate = {}) {
  const failures = [];
  const { expectVerb, minCalledRate = 0.5, maxHandReduceRate, forbidDeadVerbs } = gate;
  if (expectVerb) {
    const pv = adoption.perVerb[expectVerb];
    const rate = pv && adoption.n ? pv.called / adoption.n : 0;
    if (rate < minCalledRate) {
      failures.push(
        `verb ${expectVerb} called in ${pv ? pv.called : 0}/${adoption.n} samples ` +
        `(rate ${rate.toFixed(2)} < required ${minCalledRate})`,
      );
    }
  }
  if (maxHandReduceRate != null && adoption.handReduce.rate > maxHandReduceRate) {
    failures.push(
      `hand-reduce rate ${adoption.handReduce.rate.toFixed(2)} > max ${maxHandReduceRate}`,
    );
  }
  if (forbidDeadVerbs && adoption.deadVerbs.length) {
    failures.push(`surfaced-but-never-called verbs: ${adoption.deadVerbs.join(', ')}`);
  }
  return { pass: failures.length === 0, failures };
}
