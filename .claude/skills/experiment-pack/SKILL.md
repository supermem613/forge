---
name: experiment-pack
description: Pack a Forge experiment into a compressed audit archive for analysis.
---

# Pack an experiment for analysis

Use when the user wants a shareable, auditable snapshot of an experiment (reports, results, conclusions) without full preservation bulk.

This is **not** `experiment-archive`. Archive moves the experiment out of the workspace. Pack copies a curated subset and leaves the experiment in place.

## Judgment

1. Confirm the experiment name (`forge experiments` if needed).
2. Use claim depth `audit` only (summary/full are deferred).
3. Run the pack command.
4. Interpret size and exclusions from the envelope; offer verification.

## Commands

```text
forge pack-analysis <experiment> --to <out.tar.zst>
forge verify-analysis <out.tar.zst>
```

## Policy

- Do not invent file lists or copy paths by hand. The CLI owns selection, runbook snapshot, hashing, `ANALYSIS.json`, and tar.zst creation.
- Captures and raw turn dumps are excluded by default so packs stay small. If the user needs full bulk preservation, use `forge archive` instead.
- Forge owns the inventory numbers in the JSON envelope. Do not paraphrase hashes or byte totals.
- After packing, run `forge verify-analysis` when the user wants confirmation the archive is intact.
