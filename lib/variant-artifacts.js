// lib/variant-artifacts.js — freeze treatment inputs onto variant + run.
//
// INVARIANT (forge methodology): every mark variant keeps a full copy of the
// treatment inputs under variants/<mark>/artifacts/. Every run that applies
// those inputs also freezes a full copy under runs/<ts>/snapshots/.
// Hashes alone are NOT enough — archive and later analysis must open the
// exact files that produced the scores without reconstructing from git.
//
// Control arms may leave artifacts/ empty. Mark arms that change product
// inputs (skill trees, overlays, prompts packs, binaries) MUST freeze them.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Recursive copy. Overwrites destDir. */
export async function copyTree(srcDir, destDir) {
  if (!srcDir || !destDir) {
    throw new Error('copyTree: srcDir and destDir required');
  }
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });
  async function walk(rel = '') {
    const abs = path.join(srcDir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) {
        await fs.mkdir(path.join(destDir, childRel), { recursive: true });
        await walk(childRel);
      } else if (ent.isFile()) {
        const out = path.join(destDir, childRel);
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.copyFile(path.join(srcDir, childRel), out);
      }
    }
  }
  await walk('');
  return destDir;
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve treatment input dir and freeze onto variant artifacts + run snapshot.
 *
 * @param {object} opts
 * @param {string} opts.liveDir - current working treatment tree (e.g. packages/foo)
 * @param {string} opts.artifactsDir - experiments/<exp>/variants/<mark>/artifacts
 * @param {string} opts.runDir - experiments/<exp>/variants/<mark>/runs/<ts>
 * @param {string} opts.name - artifact folder name (e.g. skill name)
 * @param {boolean} [opts.isControl=false]
 * @param {string} [opts.markerFile='SKILL.md'] - file that proves a frozen tree exists
 * @param {(m:string)=>void} [opts.log]
 */
export async function resolveAndFreezeTreatment({
  liveDir,
  artifactsDir,
  runDir,
  name,
  isControl = false,
  markerFile = 'SKILL.md',
  log = () => {},
} = {}) {
  if (!runDir) throw new Error('resolveAndFreezeTreatment: runDir required');
  if (!name) throw new Error('resolveAndFreezeTreatment: name required');
  if (!liveDir) throw new Error('resolveAndFreezeTreatment: liveDir required');

  const live = path.resolve(liveDir);
  const variantDir = artifactsDir ? path.join(artifactsDir, name) : null;
  let treatmentDir = live;
  let source = 'live';

  if (!isControl) {
    if (!artifactsDir) {
      throw new Error('resolveAndFreezeTreatment: artifactsDir required on mark arms');
    }
    const hasFrozen = variantDir && await pathExists(path.join(variantDir, markerFile));
    if (hasFrozen) {
      treatmentDir = variantDir;
      source = 'variant-artifacts';
      log(`[variant-artifacts] using frozen ${variantDir}\n`);
    } else {
      log(`[variant-artifacts] freezing live -> ${variantDir}\n`);
      await copyTree(live, variantDir);
      treatmentDir = variantDir;
      source = 'live-frozen-to-variant';
    }
  }

  const snapshotDir = path.join(runDir, 'snapshots', name);
  // Control still snapshots the live baseline tree when provided so archives
  // record "what control would have been" only if caller wants it. Default:
  // mark always; control only when explicitly freezing live for audit.
  if (!isControl) {
    await copyTree(treatmentDir, snapshotDir);
    log(`[variant-artifacts] run snapshot -> ${snapshotDir} (source=${source})\n`);
  } else {
    // control: do not invent treatment artifacts; leave snapshot absent
    log('[variant-artifacts] control arm: no treatment freeze\n');
  }

  return {
    treatmentDir,
    snapshotDir: isControl ? null : snapshotDir,
    variantDir,
    source: isControl ? 'control-no-treatment' : source,
    name,
  };
}

/**
 * Hard check used by score/archive/doctor: mark run that claims a treatment
 * must have a non-empty snapshots/<name>/ tree (or legacy artifacts only).
 */
export async function assertMarkTreatmentFrozen({
  runDir,
  variant,
  snapshotName,
  requireSnapshot = true,
} = {}) {
  if (!variant || variant === 'control') {
    return { ok: true, skipped: true };
  }
  if (!runDir) throw new Error('assertMarkTreatmentFrozen: runDir required');
  const errors = [];
  if (requireSnapshot && snapshotName) {
    const snap = path.join(runDir, 'snapshots', snapshotName);
    const marker = path.join(snap, 'SKILL.md');
    const any = await pathExists(snap);
    if (!any) {
      errors.push(`mark run missing snapshots/${snapshotName}/ — treatment inputs were not frozen onto the run`);
    } else if (!(await pathExists(marker)) && !(await pathExists(path.join(snap, 'package.json')))) {
      // accept either skill marker or generic package.json
      const ents = await fs.readdir(snap).catch(() => []);
      if (ents.length === 0) {
        errors.push(`mark run snapshots/${snapshotName}/ is empty`);
      }
    }
  }
  // Also require variant-level artifacts when we can derive path
  // runDir = .../variants/mark-N/runs/<ts>
  const variantDir = path.resolve(runDir, '..', '..');
  const artifactsRoot = path.join(variantDir, 'artifacts');
  if (snapshotName) {
    const art = path.join(artifactsRoot, snapshotName);
    if (!(await pathExists(art))) {
      errors.push(`mark variant missing artifacts/${snapshotName}/ — freeze treatment onto the variant before/at first run`);
    }
  }
  if (errors.length) {
    const msg = errors.join('; ');
    throw new Error(`variant-artifacts INVARIANT violated: ${msg}`);
  }
  return { ok: true, skipped: false };
}
