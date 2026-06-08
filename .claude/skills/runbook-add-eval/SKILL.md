---
name: runbook-add-eval
description: Add an eval case to an existing Forge runbook.
---

# Add an eval

Read the runbook manifest and README first. Add one `evals/<NN>-<slug>.json` file with `criteria.must`, `criteria.should`, and `criteria.could` arrays, then register it in `manifest.json`.

Run `forge validate <runbook>` after editing.
