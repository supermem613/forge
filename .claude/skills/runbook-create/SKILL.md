---
name: runbook-create
description: Scaffold a new Forge runbook.
---

# Create a runbook

Use `forge new-runbook <id>` to create the standard runbook shape. Then edit the manifest, README, evals, and step shims to match the requested scenario.

Replace the scaffold example eval with a real case: one production behavior, a `description` that states how `must` proves it, and no harness-plumbing criteria in the capability score.

Run `forge validate <id>` before handing the runbook back.
