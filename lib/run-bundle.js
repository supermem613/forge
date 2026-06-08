// lib/run-bundle.js — standard run-bundle directory shape.
//
// Bundles live under a caller-supplied directory (`runsDir`). The
// experiment script decides where that is — for forge today:
//
//   experiments/<exp>/variants/control/runs/<ts>/   (control variant)
//   experiments/<exp>/variants/mark-N/runs/<ts>/    (treatment variant)
//
// Layout inside each bundle:
//
//   manifest.json        ← { experiment, variant, ts, startedAt, finalizedAt, summary }
//   transcript.json      ← per-turn index of writeTurn artifacts
//   run.log              ← appended by writeMd("run.log", line)
//   turn1/, turn2/, ...  ← per-turn raw JSON, written via writeTurn
//   <name>.json          ← writeRaw("<name>", obj)
//   <name>.md            ← writeMd("variant-stats", "# ...")
//
// `pairWith(controlBundleDir)` records the paired control inside manifest.json
// so downstream score/judge can find it without re-globbing.
//
// `latest({ runsDir })` finds the newest <ts> directory inside `runsDir`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Bundle schema version. v0 = legacy bundles written before this field existed
// (manifest.bundleSchemaVersion absent). v1 = current. Readers must tolerate v0.
// Bump when bundle layout / manifest contract changes in a way that breaks
// downstream tools (score/judge/report).
export const BUNDLE_SCHEMA_VERSION = 1;
export const RUN_ARTIFACT_SCHEMA_VERSION = 1;

function ts() {
  // 2026-04-23T10-25-30 (filesystem-safe ISO)
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

export async function openBundle({ experiment, variant, runsDir, ts: timestamp, loadedSkills = () => [] }) {
  if (!experiment) {
    throw new Error('openBundle: experiment is required');
  }
  if (!variant || !(variant === 'control' || /^mark-\d+$/.test(variant))) {
    throw new Error(`openBundle: variant must be 'control' or 'mark-N' (got ${variant})`);
  }
  if (!runsDir) {
    throw new Error('openBundle: runsDir is required (caller decides where bundles live)');
  }
  const stamp = timestamp || ts();
  const dir = path.join(runsDir, stamp);
  await fs.mkdir(dir, { recursive: true });

  const manifest = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    runArtifactSchemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    experiment,
    variant,
    ts: stamp,
    startedAt: new Date().toISOString(),
    finalizedAt: null,
    pairedControl: null,
    summary: null,
  };
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const transcript = {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    experiment,
    variant,
    runTs: stamp,
    entries: [],
  };
  const transcriptPath = path.join(dir, 'transcript.json');
  await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 2) + '\n');

  async function writeRaw(name, obj) {
    const file = name.endsWith('.json') ? name : `${name}.json`;
    await fs.writeFile(path.join(dir, file), JSON.stringify(obj, null, 2) + '\n');
  }

  async function writeMd(name, content) {
    const file = name.endsWith('.md') || name.endsWith('.log') ? name : `${name}.md`;
    const target = path.join(dir, file);
    if (file.endsWith('.log')) {
      await fs.appendFile(target, content.endsWith('\n') ? content : content + '\n');
    } else {
      await fs.writeFile(target, content.endsWith('\n') ? content : content + '\n');
    }
  }

  async function writeTurn(testId, sampleIdx, turnIdx, json) {
    const turnDir = path.join(dir, `turn${turnIdx}`);
    await fs.mkdir(turnDir, { recursive: true });
    const file = path.join(turnDir, `${testId}-sample${sampleIdx}.json`);
    await fs.writeFile(file, JSON.stringify(json, null, 2) + '\n');
    const rel = path.relative(dir, file).replace(/\\/g, '/');
    const entry = summarizeTurn({
      testId, sampleIdx, turnIdx, rel, json, loadedSkills,
    });
    const sameTurn = (e) =>
      e.evalId === entry.evalId &&
      e.sample === entry.sample &&
      e.turn === entry.turn &&
      e.path === entry.path;
    transcript.entries = transcript.entries.filter(e => !sameTurn(e));
    transcript.entries.push(entry);
    await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 2) + '\n');
    return file;
  }

  async function pairWith(controlBundleDir) {
    manifest.pairedControl = path.relative(REPO_ROOT, controlBundleDir).replace(/\\/g, '/');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  async function finalize({ summary }) {
    manifest.finalizedAt = new Date().toISOString();
    manifest.summary = summary || {};
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return dir;
  }

  return { dir, ts: stamp, writeRaw, writeMd, writeTurn, pairWith, finalize };
}

function textLength(value) {
  if (typeof value === 'string') {
    return value.length;
  }
  if (value == null) {
    return 0;
  }
  return JSON.stringify(value).length;
}

function summarizeTurn({ testId, sampleIdx, turnIdx, rel, json, loadedSkills }) {
  const response = json?.response && typeof json.response === 'object'
    ? json.response
    : null;
  const toolDetails = Array.isArray(response?.toolDetails)
    ? response.toolDetails
    : [];
  const capabilitiesLoaded = Array.isArray(json?.capabilitiesLoaded)
    ? json.capabilitiesLoaded
    : loadedSkills(response);
  const responseText = response && 'text' in response
    ? response.text
    : null;
  return {
    evalId: testId,
    sample: sampleIdx,
    turn: turnIdx,
    path: rel,
    writtenAt: new Date().toISOString(),
    ms: typeof json?.ms === 'number' ? json.ms : null,
    promptChars: textLength(json?.prompt),
    responseChars: textLength(responseText),
    toolCalls: toolDetails.length,
    capabilitiesLoaded,
    error: typeof json?.error === 'string' ? json.error : null,
    generatedArtifactName: json?.generated?.name || null,
    childArtifactName: json?.childArtifactName || null,
  };
}

export async function latest({ runsDir }) {
  if (!runsDir) {
    throw new Error('latest: runsDir is required');
  }
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  if (dirs.length === 0) {
    return null;
  }
  return path.join(runsDir, dirs[dirs.length - 1]);
}

export async function readBundleManifest(bundleDir) {
  const raw = await fs.readFile(path.join(bundleDir, 'manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  // v0 bundles (pre-versioning) do not carry the field. Normalize on read so
  // callers can branch on `m.bundleSchemaVersion` without null-checks.
  if (typeof m.bundleSchemaVersion !== 'number') {
    m.bundleSchemaVersion = 0;
  }
  if (typeof m.runArtifactSchemaVersion !== 'number') {
    m.runArtifactSchemaVersion = 0;
  }
  return m;
}

export const ROOT = REPO_ROOT;
