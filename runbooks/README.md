# Forge runbooks

Runbooks are reusable experiment recipes. A runbook owns its manifest, evals, optional fixtures, and step shims. Experiments and run outputs live under `experiments/<name>/`, not inside the runbook.

A runbook is named after the skill or capability it evaluates, and it is always a directory. Scaffold with `forge new-runbook <id>` (add `--module <name>` to target a capability pack); never hand-write one. `forge list` skips loose files in a runbook root and reports them as warnings, so prose belongs in `docs/`.

## Catalog

| Runbook | What it evaluates |
|---|---|

## Anatomy

```text
runbooks/<id>/
  manifest.json
  README.md
  evals/
  fixtures/
  setup.js
  run.js
  score.js
  judge.js
  report.js
  teardown.js
```

Run outputs live under `experiments/<experiment>/variants/<variant>/runs/<timestamp>/`. See `docs/RUN_ARTIFACT_SCHEMA.md` for the bundle contract.

Run `forge validate <runbook>` before relying on a runbook.
