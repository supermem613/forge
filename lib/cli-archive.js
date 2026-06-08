// lib/cli-archive.js — `forge archive <exp> --to <path>`.
//
// Moves experiments/<exp>/ into <archiveRoot>/experiments/<exp>/<ts>/.
// Atomic-ish via copy-to-<ts>.tmp + rename + source-remove (or single
// rename when same volume). Writes ARCHIVE.json with provenance.
//
// CLI owns mechanics. Skill (.claude/skills/experiment-archive) owns
// the judgment ("which experiment?", "keep the shell?").

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const EXPERIMENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

// GitHub blocks pushes containing files > 100 MB. Per-run dirs in forge
// experiments may contain large diagnostic event captures,
// which makes raw archives unpushable. Zipping each runs/<ts>/ into
// runs/<ts>.zip both compresses (these are JSON, ~10x ratio) and bundles
// the per-run sample artifacts into one file the archive repo can ship.
async function zipRunDir(runDir) {
  const zipPath = `${runDir}.zip`;
  // Compress-Archive is built into PowerShell 5.1+ (ships with Windows).
  // -Path "<dir>\*" packs the *contents* (no top-level dir inside the zip)
  // which mirrors the layout the manual backfill produced.
  const args = [
    '-NoProfile', '-NonInteractive', '-Command',
    `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path "${runDir}\\*" -DestinationPath "${zipPath}" -CompressionLevel Optimal -Force; if (-not (Test-Path "${zipPath}")) { exit 2 }`,
  ];
  await new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => {
      err += d; 
    });
    proc.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Compress-Archive exited ${code}: ${err.trim()}`));
      }
    });
    proc.on('error', reject);
  });
  return zipPath;
}

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

async function zipAllRuns(rootDir) {
  // Find every <root>/variants/*/runs/<ts>/ dir, zip + verify entry count + rm.
  const results = [];
  const variantsDir = path.join(rootDir, 'variants');
  let variants;
  try {
    variants = await fs.readdir(variantsDir, { withFileTypes: true }); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      return results;
    } throw e; 
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
      } throw e; 
    }
    for (const r of runs) {
      if (!r.isDirectory()) {
        continue;
      }
      const runDir = path.join(runsDir, r.name);
      const srcCount = await countFiles(runDir);
      const zipPath = await zipRunDir(runDir);
      const zipSize = (await fs.stat(zipPath)).size;
      // Sanity: zip exists and is non-empty. Stronger entry-count check
      // would need a zip parser; we trust Compress-Archive's exit code
      // plus a non-zero size for a non-zero source.
      if (srcCount > 0 && zipSize === 0) {
        await fs.rm(zipPath, { force: true });
        throw new Error(`archive: zip is empty for ${runDir} (${srcCount} source files)`);
      }
      await fs.rm(runDir, { recursive: true, force: true });
      results.push({ runDir, zipPath, srcFiles: srcCount, zipBytes: zipSize });
    }
  }
  return results;
}

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
    throw new Error('archive: <experiment> required');
  }
  if (!EXPERIMENT_NAME_RE.test(experiment)) {
    throw new Error(`archive: invalid experiment name: ${JSON.stringify(experiment)} (allowed: A-Z a-z 0-9 . _ -)`);
  }
  if (!archiveRoot) {
    throw new Error('archive: --to <path> required (or set FORGE_ARCHIVE_ROOT)');
  }

  const sourceAbs = path.resolve(experimentsDir, experiment);
  // Ensure the resolved source is actually inside experimentsDir — defends
  // against `..` slipping past EXPERIMENT_NAME_RE on weird platforms.
  if (!(await isInside(experimentsDir, sourceAbs))) {
    throw new Error(`archive: experiment path escapes experiments dir: ${sourceAbs}`);
  }
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceAbs); 
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`archive: no such experiment: ${experiment} (missing ${sourceAbs})`);
    }
    throw e;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`archive: source is not a directory: ${sourceAbs}`);
  }

  const archiveRootAbs = path.resolve(archiveRoot);

  // Containment guard: source and archive root must not nest in either
  // direction. Otherwise we'd recursively copy the archive into itself.
  if (await isInside(sourceAbs, archiveRootAbs)) {
    throw new Error(`archive: --to is inside the source experiment dir: ${archiveRootAbs}`);
  }
  if (await isInside(archiveRootAbs, sourceAbs)) {
    throw new Error(`archive: source experiment is inside --to root: ${sourceAbs}`);
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
    throw new Error(`archive: --to exists but is not a directory: ${archiveRootAbs}`);
  }

  const ts = typeof now === 'function' ? now() : String(now);
  const destDir = path.join(archiveRootAbs, 'experiments', experiment, ts);
  const destTmp = `${destDir}.tmp`;

  // Collision guard. Almost impossible with millisecond timestamps, but cheap.
  try {
    await fs.access(destDir); throw new Error(`archive: destination already exists: ${destDir}`); 
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
    zipRuns: !!zipRuns,
  };
  await fs.writeFile(path.join(destDir, 'ARCHIVE.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Zip per-run dirs in place. Done AFTER ARCHIVE.json so the manifest is
  // present even if zipping fails partway (the un-zipped runs are still
  // intact at destDir; the user can retry).
  if (zipRuns) {
    plan.zippedRuns = await zipAllRuns(destDir);
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
