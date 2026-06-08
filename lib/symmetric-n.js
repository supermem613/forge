// lib/symmetric-n.js — enforce same N samples between control and variant.
//
// `forge run <exp> mark-N` should produce a run with the SAME number of
// samples as the latest control run. Otherwise control vs variant pp
// deltas are skewed by sample count, not by the variant change.
//
// resolveSampleN({expDir, variant, requestedSamples, allowAsymmetric}) is the
// gatekeeper:
//   - control variant or no control run yet → returns requestedSamples (or null)
//   - control run exists, variant != 'control':
//       * if requestedSamples == null → return controlSamples (auto-pin)
//       * if requestedSamples == controlSamples → return controlSamples
//       * if mismatch + allowAsymmetric → return requestedSamples (warn)
//       * if mismatch + !allowAsymmetric → throw
//
// `latestControlSamples({expDir})` reads the most recent control run's
// results.json and returns `samples` (or null if none).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { latest } from './run-bundle.js';

export async function latestControlSamples({ expDir }) {
  const runsDir = path.join(expDir, 'variants', 'control', 'runs');
  const ctl = await latest({ runsDir });
  if (!ctl) {
    return null;
  }
  try {
    const r = JSON.parse(await fs.readFile(path.join(ctl, 'results.json'), 'utf8'));
    return typeof r.samples === 'number' ? r.samples : null;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

export async function resolveSampleN({ expDir, variant, requestedSamples, allowAsymmetric, log }) {
  const onLog = log || (() => {});
  if (variant === 'control') {
    return requestedSamples;
  }
  const ctlN = await latestControlSamples({ expDir });
  if (ctlN == null) {
    if (requestedSamples == null) {
      onLog('symmetric-n: no control run yet — variant will define the baseline N');
    }
    return requestedSamples;
  }
  if (requestedSamples == null) {
    onLog(`symmetric-n: pinning --samples ${ctlN} (matches latest control run)`);
    return ctlN;
  }
  if (requestedSamples === ctlN) {
    return ctlN;
  }
  if (allowAsymmetric) {
    onLog(`symmetric-n: WARNING --samples ${requestedSamples} differs from control ${ctlN} (--asymmetric set)`);
    return requestedSamples;
  }
  throw new Error(
    `symmetric-n: --samples ${requestedSamples} mismatches latest control run (${ctlN}). ` +
    `Pass --samples ${ctlN} to match, or --asymmetric to override (will skew pp deltas).`
  );
}
