// lib/cli-pack-analysis.js — `forge pack-analysis` + `forge verify-analysis`.
//
// Portable evidence export (non-destructive). Distinct from `forge archive`,
// which MOVES the experiment for lifecycle retirement. This module copies a
// curated audit subset, snapshots the runbook by content hash, writes
// ANALYSIS.json, packs the staging tree as tar.zst, and self-verifies.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeError } from './envelope.js';
import { findRunbook } from './module-registry.js';
import { readExperimentConfig } from './experiment.js';
import { tarZstDirContents, readTarZstEntries } from './tar-zst.js';

const PACK_EXT = '.tar.zst';

export const ANALYSIS_SCHEMA_VERSION = 1;
export const SELECTION_POLICY = 'audit-v1';
export const SUPPORTED_CLAIM_CLASSES = Object.freeze(['audit']);

const EXPERIMENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

// Run-root files that belong in the audit claim class.
const AUDIT_RUN_FILES = new Set([
  'manifest.json',
  'transcript.json',
  'results.json',
  'pair.json',
  'score.json',
  'REPORT.json',
  'REPORT.md',
  'signals.json',
  'run.log',
]);

// Variant-level markdown notes.
const AUDIT_VARIANT_FILES = new Set([
  'HYPOTHESIS.md',
  'NOTES.md',
]);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function isInside(parent, child) {
  const p = path.resolve(parent) + path.sep;
  const c = path.resolve(child) + path.sep;
  return c === p || c.startsWith(p);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root) {
  const out = [];
  async function rec(dir, relBase = '') {
    let ents;
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') {
        return;
      }
      throw e;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink && e.isSymbolicLink()) {
        // Skip symlinks: packing must not follow or re-emit link targets.
        continue;
      }
      if (e.isDirectory()) {
        await rec(abs, rel);
      } else if (e.isFile()) {
        out.push({ abs, rel: rel.split(path.sep).join('/') });
      }
    }
  }
  await rec(root);
  return out;
}

function classifyRunRel(rel) {
  // rel is path under a run dir, forward-slash form.
  if (!rel || rel.includes('..')) {
    return { include: false, reason: 'invalid-path' };
  }
  const parts = rel.split('/');
  const top = parts[0];
  if (top === 'captures') {
    return { include: false, reason: 'captures-excluded-by-default' };
  }
  if (/^turn\d+$/i.test(top)) {
    return { include: false, reason: 'turns-excluded-from-audit' };
  }
  if (top === 'judge-prompts') {
    return { include: false, reason: 'judge-prompts-excluded-from-audit' };
  }
  if (top === 'judge-verdicts' || top === 'judge-verdicts-refit') {
    return { include: true, reason: null };
  }
  if (parts.length === 1 && AUDIT_RUN_FILES.has(top)) {
    return { include: true, reason: null };
  }
  return { include: false, reason: 'not-in-audit-allowlist' };
}

async function copyFileEnsured(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function hashTree(root) {
  const files = await walkFiles(root);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    h.update(await fs.readFile(f.abs));
    h.update('\0');
  }
  return { contentHash: h.digest('hex'), files: files.map(f => f.rel) };
}

function requiredAuditPaths(analysis) {
  const req = new Set(['ANALYSIS.json', 'experiment/experiment.json']);
  if (analysis.runbook?.id) {
    req.add('runbook/manifest.json');
  }
  return req;
}

function validateAnalysisShape(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    throw new ForgeError('verify-analysis: ANALYSIS.json missing or invalid', {
      code: 'VALIDATION_FAILED',
      hint: 'Repack with `forge pack-analysis`.',
    });
  }
  if (analysis.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
    throw new ForgeError(
      `verify-analysis: unsupported schemaVersion ${analysis.schemaVersion}`,
      { code: 'VALIDATION_FAILED', hint: `Expected schemaVersion ${ANALYSIS_SCHEMA_VERSION}.` },
    );
  }
  if (!SUPPORTED_CLAIM_CLASSES.includes(analysis.claimClass)) {
    throw new ForgeError(
      `verify-analysis: unsupported claimClass ${analysis.claimClass}`,
      { code: 'VALIDATION_FAILED', hint: `Supported: ${SUPPORTED_CLAIM_CLASSES.join(', ')}.` },
    );
  }
  if (!Array.isArray(analysis.included) || !Array.isArray(analysis.excluded)) {
    throw new ForgeError('verify-analysis: ANALYSIS.json missing included/excluded arrays', {
      code: 'VALIDATION_FAILED',
      hint: 'Repack with `forge pack-analysis`.',
    });
  }
}

async function selfVerifyStaging(stageDir, analysis) {
  validateAnalysisShape(analysis);
  const errors = [];
  for (const req of requiredAuditPaths(analysis)) {
    if (!(await pathExists(path.join(stageDir, ...req.split('/'))))) {
      errors.push(`missing required ${req}`);
    }
  }
  for (const entry of analysis.included) {
    const abs = path.join(stageDir, ...entry.path.split('/'));
    if (!(await pathExists(abs))) {
      errors.push(`included path missing: ${entry.path}`);
      continue;
    }
    const buf = await fs.readFile(abs);
    if (buf.length !== entry.bytes) {
      errors.push(`byte mismatch: ${entry.path}`);
    }
    const hash = sha256(buf);
    if (hash !== entry.sha256) {
      errors.push(`hash mismatch: ${entry.path}`);
    }
  }
  // No capture paths may appear among included entries.
  for (const entry of analysis.included) {
    if (entry.path.includes('/captures/') || entry.path.endsWith('/captures') || /\/turn\d+\//i.test(entry.path)) {
      errors.push(`audit pack includes forbidden path: ${entry.path}`);
    }
  }
  if (errors.length) {
    throw new ForgeError(`pack-analysis: self-verify failed: ${errors.join('; ')}`, {
      code: 'VALIDATION_FAILED',
      hint: 'Fix the selection policy or source experiment and retry.',
    });
  }
  return { ok: true, checked: analysis.included.length };
}

export async function packAnalysis({
  repoRoot,
  experimentsDir,
  registry,
  experiment,
  toPath,
  claimClass = 'audit',
  includeCaptures = false,
  dryRun = false,
  forgeVersion = null,
} = {}) {
  if (!experiment) {
    throw new ForgeError('pack-analysis: <experiment> required', {
      code: 'USAGE',
      hint: 'forge pack-analysis <experiment> --to <out.tar.zst>',
    });
  }
  if (!EXPERIMENT_NAME_RE.test(experiment)) {
    throw new ForgeError(
      `pack-analysis: invalid experiment name: ${JSON.stringify(experiment)}`,
      { code: 'USAGE', hint: 'Experiment names may contain only A-Z a-z 0-9 . _ - characters.' },
    );
  }
  if (!toPath) {
    throw new ForgeError('pack-analysis: --to <path.tar.zst> required', {
      code: 'USAGE',
      hint: 'forge pack-analysis <experiment> --to <out.tar.zst>',
    });
  }
  if (!SUPPORTED_CLAIM_CLASSES.includes(claimClass)) {
    throw new ForgeError(
      `pack-analysis: claim class '${claimClass}' is not supported yet (supported: ${SUPPORTED_CLAIM_CLASSES.join(', ')})`,
      {
        code: 'USAGE',
        hint: 'Only audit is shipped. summary/full are deferred until size measurements justify them.',
      },
    );
  }
  if (includeCaptures) {
    throw new ForgeError(
      'pack-analysis: --include-captures is not supported in audit-v1',
      {
        code: 'USAGE',
        hint: 'Captures stay excluded so packs stay shareable. Use forge archive for full preservation.',
      },
    );
  }

  const { dir: expDir, json: expJson } = await readExperimentConfig({ experimentsDir, name: experiment });
  if (!(await isInside(experimentsDir, expDir))) {
    throw new ForgeError(`pack-analysis: experiment path escapes experiments dir: ${expDir}`, {
      code: 'VALIDATION_FAILED',
      hint: 'Pass a plain experiment name, not a path.',
    });
  }

  const outAbs = path.resolve(toPath);
  if (!outAbs.toLowerCase().endsWith(PACK_EXT)) {
    throw new ForgeError(`pack-analysis: --to must end with ${PACK_EXT}`, {
      code: 'USAGE',
      hint: 'Pass an output path like ./exp-audit.tar.zst',
    });
  }
  if (await isInside(expDir, outAbs)) {
    throw new ForgeError('pack-analysis: --to is inside the source experiment dir', {
      code: 'VALIDATION_FAILED',
      hint: 'Write the archive outside the experiment directory.',
    });
  }

  // Resolve runbook for snapshot. Missing runbook is a hard fail for audit
  // packs: without the rubric the scores cannot be interpreted.
  const runbookId = expJson.runbook;
  const runbookInfo = registry ? await findRunbook(registry, runbookId) : null;
  if (!runbookInfo) {
    throw new ForgeError(`pack-analysis: no such runbook: ${runbookId}`, {
      code: 'NOT_FOUND',
      hint: 'Run `forge list` to see available runbooks, or restore the runbook before packing.',
    });
  }

  const included = [];
  const excluded = [];
  let includedBytes = 0;
  let excludedBytes = 0;

  async function noteExclude(rel, reason, bytes) {
    excluded.push({ path: rel, reason, bytes });
    excludedBytes += bytes;
  }

  async function noteInclude(stageRel, absSrc) {
    const buf = await fs.readFile(absSrc);
    const entry = { path: stageRel, sha256: sha256(buf), bytes: buf.length };
    included.push(entry);
    includedBytes += buf.length;
    return buf;
  }

  // Plan: walk experiment and classify without writing when dry-run.
  const plannedCopies = []; // { src, stageRel }

  // experiment.json
  const expJsonAbs = path.join(expDir, 'experiment.json');
  plannedCopies.push({ src: expJsonAbs, stageRel: 'experiment/experiment.json' });

  // variants
  const variantsDir = path.join(expDir, 'variants');
  let variants = [];
  try {
    variants = await fs.readdir(variantsDir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  for (const v of variants) {
    if (!v.isDirectory()) {
      continue;
    }
    const vName = v.name;
    const vDir = path.join(variantsDir, vName);
    for (const name of AUDIT_VARIANT_FILES) {
      const abs = path.join(vDir, name);
      if (await pathExists(abs)) {
        plannedCopies.push({
          src: abs,
          stageRel: `experiment/variants/${vName}/${name}`,
        });
      }
    }
    const runsDir = path.join(vDir, 'runs');
    let runs = [];
    try {
      runs = await fs.readdir(runsDir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    for (const r of runs) {
      if (!r.isDirectory()) {
        // Already-packed runs from archive are not audit sources in-place.
        const lower = r.name.toLowerCase();
        if (r.isFile() && (lower.endsWith('.tar.zst') || lower.endsWith('.zip'))) {
          const st = await fs.stat(path.join(runsDir, r.name));
          await noteExclude(
            `experiment/variants/${vName}/runs/${r.name}`,
            'packed-run-not-unpacked',
            st.size,
          );
        }
        continue;
      }
      const runDir = path.join(runsDir, r.name);
      const files = await walkFiles(runDir);
      for (const f of files) {
        const cls = classifyRunRel(f.rel);
        const stageRel = `experiment/variants/${vName}/runs/${r.name}/${f.rel}`;
        if (cls.include) {
          plannedCopies.push({ src: f.abs, stageRel });
        } else {
          const st = await fs.stat(f.abs);
          await noteExclude(stageRel, cls.reason, st.size);
        }
      }
    }

    // Variant artifacts are not part of audit-v1 (can hold large payloads).
    const artifactsDir = path.join(vDir, 'artifacts');
    if (await pathExists(artifactsDir)) {
      const arts = await walkFiles(artifactsDir);
      for (const f of arts) {
        const st = await fs.stat(f.abs);
        await noteExclude(
          `experiment/variants/${vName}/artifacts/${f.rel}`,
          'artifacts-excluded-from-audit',
          st.size,
        );
      }
    }
  }

  // Runbook snapshot: copy whole tree except node_modules-like noise.
  const rbFiles = await walkFiles(runbookInfo.dir);
  const rbPlanned = [];
  for (const f of rbFiles) {
    if (f.rel.split('/').includes('node_modules')) {
      const st = await fs.stat(f.abs);
      await noteExclude(`runbook/${f.rel}`, 'node_modules-excluded', st.size);
      continue;
    }
    rbPlanned.push({ src: f.abs, stageRel: `runbook/${f.rel}` });
  }

  const plan = {
    action: 'pack-analysis',
    experiment,
    claimClass,
    selectionPolicy: SELECTION_POLICY,
    runbook: runbookId,
    toPath: outAbs,
    plannedIncludeCount: plannedCopies.length + rbPlanned.length + 1, // + ANALYSIS.json
    plannedExcludeCount: excluded.length,
    dryRun: !!dryRun,
  };

  if (dryRun) {
    // Estimate include bytes without copying.
    let est = 0;
    for (const c of [...plannedCopies, ...rbPlanned]) {
      est += (await fs.stat(c.src)).size;
    }
    plan.estimatedIncludedBytes = est;
    plan.estimatedExcludedBytes = excludedBytes;
    plan.excluded = excluded;
    return plan;
  }

  if (await pathExists(outAbs)) {
    throw new ForgeError(`pack-analysis: destination already exists: ${outAbs}`, {
      code: 'CONFLICT',
      hint: 'Choose a new --to path or remove the existing archive.',
    });
  }

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-pack-'));
  try {
    // Copy experiment selections.
    for (const c of plannedCopies) {
      await copyFileEnsured(c.src, path.join(stageDir, ...c.stageRel.split('/')));
      await noteInclude(c.stageRel, c.src);
    }
    // Copy runbook.
    for (const c of rbPlanned) {
      await copyFileEnsured(c.src, path.join(stageDir, ...c.stageRel.split('/')));
      await noteInclude(c.stageRel, c.src);
    }

    const rbHash = await hashTree(path.join(stageDir, 'runbook'));
    let version = forgeVersion;
    if (!version) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
        version = pkg.version || '0.0.0';
      } catch {
        version = '0.0.0';
      }
    }

    included.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const analysis = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      claimClass,
      selectionPolicy: SELECTION_POLICY,
      experiment,
      packedAt: new Date().toISOString(),
      forgeVersion: version,
      runbook: {
        id: runbookId,
        contentHash: rbHash.contentHash,
        fileCount: rbHash.files.length,
      },
      included,
      excluded,
      containerFormat: 'tar.zst',
      totals: {
        includedFiles: included.length,
        includedBytes,
        excludedFiles: excluded.length,
        excludedBytes,
        archiveBytes: null,
        // Legacy alias; envelope still exposes zipBytes for older readers.
        zipBytes: null,
      },
    };

    // ANALYSIS.json is written after inventory so it is not in included[].
    // Verify treats it as the root contract file separately.
    const analysisPath = path.join(stageDir, 'ANALYSIS.json');
    const analysisBody = `${JSON.stringify(analysis, null, 2)}\n`;
    await fs.writeFile(analysisPath, analysisBody);

    await selfVerifyStaging(stageDir, analysis);

    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    const { files: packedCount } = await tarZstDirContents(stageDir, outAbs);
    const archiveStat = await fs.stat(outAbs);
    analysis.totals.archiveBytes = archiveStat.size;
    analysis.totals.zipBytes = archiveStat.size;
    // archiveBytes only in the command envelope. On-disk ANALYSIS.json keeps
    // archiveBytes null and verify does not require it.

    // Re-open tar.zst and confirm ANALYSIS.json + entry count.
    const archiveBuf = await fs.readFile(outAbs);
    const entries = readTarZstEntries(archiveBuf);
    if (!entries.has('ANALYSIS.json')) {
      await fs.rm(outAbs, { force: true });
      throw new ForgeError('pack-analysis: archive missing ANALYSIS.json after write', {
        code: 'VALIDATION_FAILED',
        hint: 'Retry pack-analysis; if it persists, file a forge bug.',
      });
    }
    // +1 because ANALYSIS.json is written into the stage after included[] is sealed.
    const expectedEntries = packedCount;
    if (entries.size !== expectedEntries) {
      await fs.rm(outAbs, { force: true });
      throw new ForgeError(
        `pack-analysis: tar.zst entry count ${entries.size} != writer count ${expectedEntries}`,
        { code: 'VALIDATION_FAILED', hint: 'Retry pack-analysis.' },
      );
    }

    // Source experiment must still exist (non-destructive).
    if (!(await pathExists(expJsonAbs))) {
      throw new ForgeError('pack-analysis: source experiment disappeared during pack', {
        code: 'ERROR',
        hint: 'Another process may have archived or deleted the experiment.',
      });
    }

    return {
      action: 'pack-analysis',
      experiment,
      claimClass,
      selectionPolicy: SELECTION_POLICY,
      containerFormat: 'tar.zst',
      runbook: runbookId,
      runbookContentHash: rbHash.contentHash,
      toPath: outAbs,
      archiveBytes: archiveStat.size,
      zipBytes: archiveStat.size,
      includedFiles: included.length,
      includedBytes,
      excludedFiles: excluded.length,
      excludedBytes,
      archiveEntries: entries.size,
      zipEntries: entries.size,
      analysis,
    };
  } catch (err) {
    await fs.rm(outAbs, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function verifyAnalysis({ zipPath, archivePath } = {}) {
  const inputPath = archivePath || zipPath;
  if (!inputPath) {
    throw new ForgeError('verify-analysis: <path.tar.zst> required', {
      code: 'USAGE',
      hint: 'forge verify-analysis <path.tar.zst>',
    });
  }
  const abs = path.resolve(inputPath);
  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ForgeError(`verify-analysis: no such file: ${abs}`, {
        code: 'NOT_FOUND',
        hint: 'Pass the path produced by `forge pack-analysis --to`.',
      });
    }
    throw e;
  }

  let entries;
  try {
    entries = readTarZstEntries(buf);
  } catch (e) {
    throw new ForgeError(`verify-analysis: invalid tar.zst: ${e.message}`, {
      code: 'VALIDATION_FAILED',
      hint: 'Repack with `forge pack-analysis`.',
    });
  }

  const analysisBuf = entries.get('ANALYSIS.json');
  if (!analysisBuf) {
    throw new ForgeError('verify-analysis: ANALYSIS.json missing from archive', {
      code: 'VALIDATION_FAILED',
      hint: 'Repack with `forge pack-analysis`.',
    });
  }
  let analysis;
  try {
    analysis = JSON.parse(analysisBuf.toString('utf8'));
  } catch (e) {
    throw new ForgeError(`verify-analysis: ANALYSIS.json is not valid JSON: ${e.message}`, {
      code: 'VALIDATION_FAILED',
      hint: 'Repack with `forge pack-analysis`.',
    });
  }
  validateAnalysisShape(analysis);

  const errors = [];
  for (const req of requiredAuditPaths(analysis)) {
    if (!entries.has(req)) {
      errors.push(`missing required ${req}`);
    }
  }
  for (const entry of analysis.included) {
    const data = entries.get(entry.path);
    if (!data) {
      errors.push(`included path missing in archive: ${entry.path}`);
      continue;
    }
    if (data.length !== entry.bytes) {
      errors.push(`byte mismatch: ${entry.path}`);
    }
    if (sha256(data) !== entry.sha256) {
      errors.push(`hash mismatch: ${entry.path}`);
    }
  }
  for (const entry of analysis.included) {
    if (entry.path.includes('/captures/') || /\/turn\d+\//i.test(entry.path)) {
      errors.push(`forbidden path in audit pack: ${entry.path}`);
    }
  }

  if (errors.length) {
    throw new ForgeError(`verify-analysis: failed: ${errors.join('; ')}`, {
      code: 'VALIDATION_FAILED',
      hint: 'Repack with `forge pack-analysis` or inspect ANALYSIS.json exclusions.',
    });
  }

  return {
    action: 'verify-analysis',
    ok: true,
    archivePath: abs,
    zipPath: abs,
    containerFormat: 'tar.zst',
    experiment: analysis.experiment,
    claimClass: analysis.claimClass,
    selectionPolicy: analysis.selectionPolicy,
    runbook: analysis.runbook,
    includedFiles: analysis.included.length,
    excludedFiles: analysis.excluded.length,
    archiveEntries: entries.size,
    zipEntries: entries.size,
    archiveBytes: buf.length,
    zipBytes: buf.length,
  };
}
