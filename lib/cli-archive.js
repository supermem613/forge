// lib/cli-archive.js — `forge archive <exp> --to <path>`.
//
// Moves experiments/<exp>/ into <archiveRoot>/experiments/<exp>/<ts>/.
// Atomic-ish via copy-to-<ts>.tmp + rename + source-remove (or single
// rename when same volume). Writes ARCHIVE.json with provenance.
//
// CLI owns mechanics. Skill (.claude/skills/experiment-archive) owns
// the judgment ("which experiment?", "keep the shell?").

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ForgeError } from './envelope.js';
import { tarZstDirContents } from './tar-zst.js';

const EXPERIMENT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const RUN_ARCHIVE_FORMAT = 'tar.zst';

// GitHub blocks pushes containing files > 100 MB. Per-run dirs hold tens of
// thousands of near-duplicate capture files — ZIP's per-entry compress and
// headers explode there. Pack each runs/<ts>/ into runs/<ts>.tar.zst (solid
// tar + zstd) so the archive repo stays under the blob limit. Matches the
// forge-archive convention (runArchiveFormat: tar.zst). In-process via
// lib/tar-zst.js; no shell tar.
async function countFiles(dir) {
  let n = 0;
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      n += await countFiles(path.join(dir, ent.name));
    } else if (ent.isFile()) {
      n++;
    }
  }
  return n;
}

export async function packAllRuns(rootDir) {
  // Find every <root>/variants/*/runs/<ts>/ dir, tar.zst + verify entry count + rm.
  const results = [];
  const variantsDir = path.join(rootDir, 'variants');
  let variants;
  try {
    variants = await fs.readdir(variantsDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') {
      return results;
    }
    throw e;
  }
  for (const v of variants) {
    if (!v.isDirectory()) {
      continue;
    }
    const runsDir = path.join(variantsDir, v.name, 'runs');
    let runs;
    try {
      runs = await fs.readdir(runsDir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') {
        continue;
      }
      throw e;
    }
    for (const r of runs) {
      if (!r.isDirectory()) {
        continue;
      }
      const runDir = path.join(runsDir, r.name);
      const srcCount = await countFiles(runDir);
      const archivePath = `${runDir}.tar.zst`;
      const { files: packedCount } = await tarZstDirContents(runDir, archivePath);
      const archiveSize = (await fs.stat(archivePath)).size;
      // Integrity gate. Every source file must appear as a tar entry before
      // the run dir is removed. The in-process writer reports its own entry
      // count, so a mismatch means the archive is incomplete and the run dir
      // is kept intact for a retry.
      if (packedCount !== srcCount) {
        await fs.rm(archivePath, { force: true });
        throw new Error(
          `archive: tar.zst entry count ${packedCount} != ${srcCount} source files for ${runDir}`,
        );
      }
      await fs.rm(runDir, { recursive: true, force: true });
      results.push({
        runDir,
        archivePath,
        // Legacy field name kept for envelope consumers that still say zip*.
        zipPath: archivePath,
        srcFiles: srcCount,
        archiveBytes: archiveSize,
        zipBytes: archiveSize,
        format: RUN_ARCHIVE_FORMAT,
      });
    }
  }
  return results;
}

/** @deprecated Use packAllRuns. Kept as alias during rename. */
export const zipAllRuns = packAllRuns;

async function copyDirRec(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      await copyDirRec(s, d);
    } else if (ent.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function isInside(parent, child) {
  const p = path.resolve(parent) + path.sep;
  const c = path.resolve(child) + path.sep;
  return c.startsWith(p);
}

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')); 
  } catch {
    return null; 
  }
}

function tsForArchive() {
  // Match the run-dir convention used elsewhere in forge:
  // 2026-04-23T18-15-19-428 (ISO with `:` and `.` replaced by `-`).
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

export async function archiveExperiment({
  repoRoot, experimentsDir, experiment, archiveRoot,
  reason = null, keepShell = false, dryRun = false, zipRuns = true,
  now = tsForArchive,
}) {
  if (!experiment) {
    throw new ForgeError('archive: <experiment> required', { code: 'USAGE', hint: 'forge archive <experiment> --to <archive-root>' });
  }
  if (!EXPERIMENT_NAME_RE.test(experiment)) {
    throw new ForgeError(`archive: invalid experiment name: ${JSON.stringify(experiment)} (allowed: A-Z a-z 0-9 . _ -)`, { code: 'USAGE', hint: 'Experiment names may contain only A-Z a-z 0-9 . _ - characters.' });
  }
  if (!archiveRoot) {
    throw new ForgeError('archive: --to <path> required (or set FORGE_ARCHIVE_ROOT)', { code: 'USAGE', hint: 'forge archive <experiment> --to <archive-root>' });
  }

  const sourceAbs = path.resolve(experimentsDir, experiment);
  // Ensure the resolved source is actually inside experimentsDir — defends
  // against `..` slipping past EXPERIMENT_NAME_RE on weird platforms.
  if (!(await isInside(experimentsDir, sourceAbs))) {
    throw new ForgeError(`archive: experiment path escapes experiments dir: ${sourceAbs}`, { code: 'VALIDATION_FAILED', hint: 'Pass a plain experiment name, not a path.' });
  }
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceAbs); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ForgeError(`archive: no such experiment: ${experiment} (missing ${sourceAbs})`, { code: 'NOT_FOUND', hint: 'Run `forge experiments` to list experiments.' });
    }
    throw e;
  }
  if (!sourceStat.isDirectory()) {
    throw new ForgeError(`archive: source is not a directory: ${sourceAbs}`, { code: 'VALIDATION_FAILED', hint: 'The experiment path must be a directory.' });
  }

  const archiveRootAbs = path.resolve(archiveRoot);

  // Containment guard: source and archive root must not nest in either
  // direction. Otherwise we'd recursively copy the archive into itself.
  if (await isInside(sourceAbs, archiveRootAbs)) {
    throw new ForgeError(`archive: --to is inside the source experiment dir: ${archiveRootAbs}`, { code: 'VALIDATION_FAILED', hint: 'Choose a --to archive root outside the experiment directory.' });
  }
  if (await isInside(archiveRootAbs, sourceAbs)) {
    throw new ForgeError(`archive: source experiment is inside --to root: ${sourceAbs}`, { code: 'VALIDATION_FAILED', hint: 'Choose a --to archive root that does not contain the experiment.' });
  }

  // Validate archive root if it exists; create later (after dry-run check).
  let archiveRootExisting = null;
  try {
    archiveRootExisting = await fs.stat(archiveRootAbs); 
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    } 
  }
  if (archiveRootExisting && !archiveRootExisting.isDirectory()) {
    throw new ForgeError(`archive: --to exists but is not a directory: ${archiveRootAbs}`, { code: 'VALIDATION_FAILED', hint: 'Pass a directory path for --to.' });
  }

  const ts = typeof now === 'function' ? now() : String(now);
  const destDir = path.join(archiveRootAbs, 'experiments', experiment, ts);
  const destTmp = `${destDir}.tmp`;

  // Collision guard. Almost impossible with millisecond timestamps, but cheap.
  try {
    await fs.access(destDir); throw new ForgeError(`archive: destination already exists: ${destDir}`, { code: 'CONFLICT', hint: 'A prior archive used this timestamp. Retry, or remove the existing destination.' }); 
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    } 
  }

  const expJson = await readJsonOrNull(path.join(sourceAbs, 'experiment.json'));
  const archiveRootIsGitRepo = !!(await fs.stat(path.join(archiveRootAbs, '.git')).catch(() => null));

  const plan = {
    action: 'archive',
    experiment,
    runbook: expJson?.runbook || null,
    sourceAbsPath: sourceAbs,
    archiveDirAbsPath: destDir,
    archiveRootAbsPath: archiveRootAbs,
    archiveRootIsGitRepo,
    keepShell: !!keepShell,
    zipRuns: !!zipRuns,
    runArchiveFormat: zipRuns ? RUN_ARCHIVE_FORMAT : null,
    reason: reason || null,
    timestamp: ts,
    dryRun: !!dryRun,
  };

  if (dryRun) {
    return plan;
  }

  await fs.mkdir(path.dirname(destDir), { recursive: true });

  // Move source -> destDir. Try `rename` first (atomic on same volume).
  // On EXDEV (cross-device) fall back to copy-to-tmp + rename + source-rm
  // so a partial copy never appears as the final destDir.
  let moved;
  try {
    await fs.rename(sourceAbs, destDir);
    moved = true;
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'ENOTEMPTY') {
      throw e;
    }
    // Cross-volume (or Windows EPERM on cross-volume rename) — copy + rm.
    try {
      await copyDirRec(sourceAbs, destTmp);
      await fs.rename(destTmp, destDir);
      await fs.rm(sourceAbs, { recursive: true, force: true });
      moved = true;
    } catch (copyErr) {
      // Best-effort cleanup of half-written tmp; leave source intact.
      await fs.rm(destTmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`archive: cross-volume copy failed: ${copyErr.message}`);
    }
  }
  if (!moved) {
    throw new Error('archive: move did not complete');
  }

  const manifest = {
    experiment,
    runbook: expJson?.runbook || null,
    archivedAt: new Date().toISOString(),
    archivedFromAbsPath: sourceAbs,
    forgeRepoAbsPath: repoRoot,
    reason: reason || null,
    // zipRuns = whether runs are packed at all (name predates tar.zst).
    zipRuns: !!zipRuns,
    runArchiveFormat: zipRuns ? RUN_ARCHIVE_FORMAT : null,
  };
  await fs.writeFile(path.join(destDir, 'ARCHIVE.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Pack per-run dirs in place as .tar.zst. Done AFTER ARCHIVE.json so the
  // manifest is present even if packing fails partway (loose runs stay at
  // destDir; the user can retry).
  if (zipRuns) {
    plan.zippedRuns = await packAllRuns(destDir);
    plan.runArchiveFormat = RUN_ARCHIVE_FORMAT;
  }

  if (keepShell) {
    // Re-stage minimal ready-to-run shell at the source path: experiment.json
    // (preserves runbook + urlParams + notes) plus bare control dirs.
    // Prior mark variants intentionally NOT restored — user can `forge propose`
    // fresh marks against the same control.
    await fs.mkdir(path.join(sourceAbs, 'variants', 'control', 'artifacts'), { recursive: true });
    await fs.mkdir(path.join(sourceAbs, 'variants', 'control', 'runs'), { recursive: true });
    const archivedExpJson = path.join(destDir, 'experiment.json');
    if (await fs.stat(archivedExpJson).catch(() => null)) {
      await fs.copyFile(archivedExpJson, path.join(sourceAbs, 'experiment.json'));
    }
  }

  return plan;
}
