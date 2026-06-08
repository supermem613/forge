// lib/run-artifact-check.js - read-only validation for completed run bundles.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RUN_ARTIFACT_SCHEMA_VERSION, readBundleManifest } from './run-bundle.js';

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }
  if (path.isAbsolute(value)) {
    return false;
  }
  return !value.split(/[\\/]+/).includes('..');
}

function requireString(obj, field, errors, label) {
  if (typeof obj?.[field] !== 'string' || obj[field].length === 0) {
    errors.push(`${label}.${field} must be a non-empty string`);
  }
}

function requireNumber(obj, field, errors, label) {
  if (typeof obj?.[field] !== 'number') {
    errors.push(`${label}.${field} must be a number`);
  }
}

export async function checkRunArtifact({ runDir } = {}) {
  if (!runDir) {
    throw new Error('checkRunArtifact: runDir is required');
  }

  const errors = [];
  const warnings = [];
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = await readBundleManifest(runDir).catch((e) => {
    errors.push(`manifest.json: missing or invalid JSON (${e.message})`);
    return null;
  });

  if (!manifest) {
    return {
      ok: false,
      runDir,
      manifest: null,
      transcriptEntries: 0,
      errors,
      warnings,
    };
  }

  requireNumber(manifest, 'bundleSchemaVersion', errors, 'manifest');
  requireNumber(manifest, 'runArtifactSchemaVersion', errors, 'manifest');
  requireString(manifest, 'experiment', errors, 'manifest');
  requireString(manifest, 'variant', errors, 'manifest');
  requireString(manifest, 'ts', errors, 'manifest');
  requireString(manifest, 'startedAt', errors, 'manifest');

  if (manifest.runArtifactSchemaVersion > RUN_ARTIFACT_SCHEMA_VERSION) {
    warnings.push(
      `manifest.runArtifactSchemaVersion=${manifest.runArtifactSchemaVersion} is newer than this checker (${RUN_ARTIFACT_SCHEMA_VERSION})`
    );
  }

  const transcriptPath = path.join(runDir, 'transcript.json');
  let transcript = null;
  try {
    transcript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && manifest.runArtifactSchemaVersion === 0) {
      warnings.push('legacy bundle has no transcript.json');
    } else {
      errors.push(`transcript.json: missing or invalid JSON (${e.message})`);
    }
  }
  let transcriptEntries = 0;
  if (transcript) {
    requireNumber(transcript, 'schemaVersion', errors, 'transcript');
    requireString(transcript, 'experiment', errors, 'transcript');
    requireString(transcript, 'variant', errors, 'transcript');
    requireString(transcript, 'runTs', errors, 'transcript');
    if (transcript.schemaVersion !== manifest.runArtifactSchemaVersion) {
      errors.push(
        `transcript.schemaVersion=${transcript.schemaVersion} does not match manifest.runArtifactSchemaVersion=${manifest.runArtifactSchemaVersion}`
      );
    }
    if (transcript.experiment !== manifest.experiment) {
      errors.push(`transcript.experiment="${transcript.experiment}" does not match manifest.experiment="${manifest.experiment}"`);
    }
    if (transcript.variant !== manifest.variant) {
      errors.push(`transcript.variant="${transcript.variant}" does not match manifest.variant="${manifest.variant}"`);
    }
    if (transcript.runTs !== manifest.ts) {
      errors.push(`transcript.runTs="${transcript.runTs}" does not match manifest.ts="${manifest.ts}"`);
    }
    if (!Array.isArray(transcript.entries)) {
      errors.push('transcript.entries must be an array');
    } else {
      transcriptEntries = transcript.entries.length;
      const seen = new Set();
      for (let i = 0; i < transcript.entries.length; i++) {
        const entry = transcript.entries[i];
        const label = `transcript.entries[${i}]`;
        requireString(entry, 'evalId', errors, label);
        requireNumber(entry, 'sample', errors, label);
        requireNumber(entry, 'turn', errors, label);
        requireString(entry, 'path', errors, label);
        requireString(entry, 'writtenAt', errors, label);
        requireNumber(entry, 'promptChars', errors, label);
        requireNumber(entry, 'responseChars', errors, label);
        requireNumber(entry, 'toolCalls', errors, label);
        if (!Array.isArray(entry?.capabilitiesLoaded)) {
          errors.push(`${label}.capabilitiesLoaded must be an array`);
        } else {
          for (let j = 0; j < entry.capabilitiesLoaded.length; j++) {
            if (typeof entry.capabilitiesLoaded[j] !== 'string') {
              errors.push(`${label}.capabilitiesLoaded[${j}] must be a string`);
            }
          }
        }
        if (!isSafeRelativePath(entry?.path)) {
          errors.push(`${label}.path must be a safe relative path`);
          continue;
        }
        const key = `${entry.evalId}\0${entry.sample}\0${entry.turn}\0${entry.path}`;
        if (seen.has(key)) {
          errors.push(`${label} duplicates evalId/sample/turn/path ${entry.path}`);
        }
        seen.add(key);
        const target = path.resolve(runDir, entry.path);
        try {
          await fs.access(target);
        } catch {
          errors.push(`${label}.path points to missing artifact: ${entry.path}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    runDir,
    manifest: {
      bundleSchemaVersion: manifest.bundleSchemaVersion,
      runArtifactSchemaVersion: manifest.runArtifactSchemaVersion,
      experiment: manifest.experiment,
      variant: manifest.variant,
      ts: manifest.ts,
    },
    manifestPath,
    transcriptPath,
    transcriptEntries,
    errors,
    warnings,
  };
}

export function formatArtifactCheck(result) {
  const lines = [];
  if (result.ok && result.warnings.length === 0) {
    lines.push(`OK ${result.runDir}`);
  } else if (result.ok) {
    lines.push(`OK with ${result.warnings.length} warning(s): ${result.runDir}`);
  } else {
    lines.push(`FAIL: ${result.errors.length} error(s)${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ''}`);
  }
  if (result.manifest) {
    lines.push(
      `  ${result.manifest.experiment}/${result.manifest.variant}/${result.manifest.ts} ` +
      `artifactSchema=${result.manifest.runArtifactSchemaVersion} transcriptEntries=${result.transcriptEntries}`
    );
  }
  for (const e of result.errors) {
    lines.push(`  error:   ${e}`);
  }
  for (const w of result.warnings) {
    lines.push(`  warning: ${w}`);
  }
  return lines.join('\n') + '\n';
}
