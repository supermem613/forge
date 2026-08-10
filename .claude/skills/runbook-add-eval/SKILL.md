---
name: runbook-add-eval
description: Add an eval case to an existing Forge runbook.
---

# Add an eval

Read the runbook manifest and README first.

Add one `evals/<NN>-<slug>.json` that enforces **one** production behavior:

1. `description` — name the behavior and how `must` proves it (not a vague label).
2. `criteria.must` / `should` / `could` — observable outcomes only; keep efficiency out of `must` unless the product requires it.
3. Register the file in `manifest.json` (`forge add-eval` preferred).

Do not add evals that only exercise harness plumbing. Prefer fewer targeted evals over a large weak suite.

Run `forge validate <runbook>` after editing. Fix description warnings before handoff.
