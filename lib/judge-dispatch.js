// lib/judge-dispatch.js — paste-ready sub-agent dispatch helpers + per-file
// verdict validator.
//
// `forge judge --dispatch-prompt` writes the exact prompt to stdout for the
// orchestrator agent to hand to a sub-agent. The prompt embeds:
//   - the required model (see REQUIRED_JUDGE_MODEL)
//   - the EXACT verdict JSON schema (criteria_results, NOT criteria)
//   - the absolute paths the sub-agent must read and write
//   - a worked example showing the array-length contract
//
// `forge judge --mode validate` walks the verdict directory and validates
// every existing file against its rubric — catching wrong-schema verdicts
// the moment they land instead of at the end of `--mode collect`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  classifyVerdict, REQUIRED_JUDGE_MODEL, JUDGE_PROMPT_VERSION, verdictDirRel,
} from './judge.js';

export function buildDispatchPrompt({ controlRun, variantRun, variantName, refitStale }) {
  const verdictRel = verdictDirRel(refitStale ? '<criteriaHash>' : null);
  const lines = [];
  lines.push('# Judge sub-agent prompt — DISPATCH WITH `model: gpt-5.4`');
  lines.push('');
  lines.push(`Required model: \`${REQUIRED_JUDGE_MODEL}\` (do NOT substitute; mixing models within a control/variant pair contaminates the comparison).`);
  lines.push(`Required promptVersion: \`${JUDGE_PROMPT_VERSION}\` (copy verbatim from each prompt's response-format example).`);
  lines.push('');
  lines.push('## Your task');
  lines.push('');
  lines.push('Read every prompt file under each of these directories, then for EACH prompt write a JSON sibling under the matching `judge-verdicts/` directory:');
  lines.push('');
  lines.push('```');
  if (controlRun) {
    lines.push(`control prompts:  ${path.join(controlRun, 'judge-prompts')}`);
    lines.push(`control verdicts: ${path.join(controlRun, ...verdictRel.split('/'))}`);
  }
  if (variantRun) {
    lines.push(`${variantName} prompts:  ${path.join(variantRun, 'judge-prompts')}`);
    lines.push(`${variantName} verdicts: ${path.join(variantRun, ...verdictRel.split('/'))}`);
  }
  lines.push('```');
  lines.push('');
  lines.push('Each verdict file must have the SAME basename as its prompt but with `.json` extension. Per prompt, read the criteria block (### MUST, ### SHOULD, ### COULD), grade each criterion against the artifact, and write the verdict in the schema below.');
  lines.push('');
  lines.push('## REQUIRED verdict schema');
  lines.push('');
  lines.push('Top-level key is `criteria_results` (snake-case, with the underscore). It is NOT `criteria`. Length and ORDER of each tier array MUST exactly match the rubric in the prompt.');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "evalId": "<from prompt>",');
  lines.push('  "sample": <number from prompt>,');
  lines.push(`  "model": "${REQUIRED_JUDGE_MODEL}",`);
  lines.push(`  "promptVersion": ${JUDGE_PROMPT_VERSION},`);
  lines.push('  "criteriaHash": "<copy verbatim from prompt response-format>",');
  lines.push('  "criteria_results": {');
  lines.push('    "must": [');
  lines.push('      { "criterion": "<exact text from prompt>", "pass": true, "reasoning": "<1-2 sentences>", "evidence": ["turn1/<file>"] }');
  lines.push('    ],');
  lines.push('    "should": [ /* same shape, length === should-tier count in prompt */ ],');
  lines.push('    "could":   [ /* same shape, length === could-tier count in prompt */ ]');
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## Common mistakes that will be REJECTED at collect time');
  lines.push('');
  lines.push('- Top-level key `"criteria"` instead of `"criteria_results"`.');
  lines.push('- Per-criterion `{id, verdict, rationale}` instead of `{criterion, pass, reasoning, evidence}`.');
  lines.push('- `verdict: "PASS"` (string) instead of `pass: true` (boolean).');
  lines.push('- Tier array length != rubric tier length.');
  lines.push('- Missing `model`, `promptVersion`, or `criteriaHash`.');
  lines.push('- Wrong `model` value (anything other than `gpt-5.4` or the auto-fail sentinel).');
  lines.push('');
  lines.push('## Tool semantics (do NOT penalize)');
  lines.push('');
  lines.push('- Treat read-only discovery calls as informational unless the runbook criteria say otherwise.');
  lines.push('');
  lines.push('## When done');
  lines.push('');
  lines.push('Reply with a one-line summary: `wrote N verdicts under <runDir>/judge-verdicts/`. The orchestrator will run `forge judge <experiment> --mode collect` to validate every file. Any wrong-shape verdict will be rejected with a precise per-file error.');
  return lines.join('\n');
}

// Walk the verdict directory and validate every existing file against the
// rubric. Returns per-file classification + path. Used by `--mode validate`
// for a fast feedback loop after the sub-agent claims to be done.
export async function validateVerdictDir({ runDir, evals, refitHash }) {
  const verdictDir = path.join(runDir, ...verdictDirRel(refitHash).split('/'));
  let entries;
  try {
    entries = await fs.readdir(verdictDir); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { dir: verdictDir, files: [] };
    }
    throw e;
  }
  const files = [];
  for (const fname of entries.sort()) {
    if (!fname.endsWith('.json')) {
      continue;
    }
    const full = path.join(verdictDir, fname);
    let raw, json, parseError;
    try {
      raw = await fs.readFile(full, 'utf8'); 
    } catch (e) {
      files.push({ file: fname, classification: 'missing', errors: [e.message] });
      continue;
    }
    try {
      json = JSON.parse(raw); 
    } catch (e) {
      parseError = e.message; 
    }
    // Find the matching eval to get the rubric. Match by basename
    // <evalId>-sample<N>.json (sanitizeId in judge.js may have replaced
    // characters; we compare against the literal stem prefix).
    const stem = fname.replace(/\.json$/, '');
    const m = /^(.+)-sample(\d+)$/.exec(stem);
    let evalEntry = null;
    if (m) {
      const id = m[1];
      evalEntry = evals.find(e => sanitizeId(e.id) === id) || null;
    }
    const criteria = evalEntry?.criteria || { must: [], should: [], could: [] };
    const cls = classifyVerdict({ json, criteria, parseError });
    files.push({ file: fname, classification: cls.classification, errors: cls.errors });
  }
  return { dir: verdictDir, files };
}

function sanitizeId(s) {
  return String(s || 'eval').replace(/[^A-Za-z0-9_-]/g, '_'); 
}

export function summarizeValidation(files) {
  const counts = {};
  for (const f of files) {
    counts[f.classification] = (counts[f.classification] || 0) + 1;
  }
  const ok = (counts.valid || 0) + (counts.legacy || 0);
  const bad = files.length - ok;
  return { total: files.length, ok, bad, counts };
}
