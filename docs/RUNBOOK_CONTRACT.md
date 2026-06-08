# Runbook contract

A runbook is a self-contained scenario directory that Forge can `setup`, `run`, `judge`, `score`, `report`, and `teardown`.

## Directory layout

```text
runbooks/<id>/
  manifest.json
  README.md
  evals/
    01-<slug>.json
  fixtures/
  setup.js
  run.js
  score.js
  judge.js
  report.js
  teardown.js
```

## manifest.json

```json
{
  "id": "runbook-id",
  "version": "0.1.0",
  "description": "What this runbook measures.",
  "fixturePrefix": "_ForgeTest_runbook-id_",
  "evals": ["evals/01-example.json"],
  "defaults": { "samples": 3 }
}
```

Runbook modules may extend the manifest with namespaced fields.

## eval JSON

```json
{
  "id": "example",
  "description": "Short human description.",
  "prompt": "Prompt or input for the system under test.",
  "criteria": {
    "must": ["Required observable outcome."],
    "should": [],
    "could": []
  }
}
```

Criterion text is shown to the judge model verbatim. Rewording criteria invalidates prior verdicts because the criteria hash changes.

## Step shims

Step files are executable shims. They should delegate mechanics to reusable library code or module code and keep runbook-specific orchestration small.

All step shims receive `--experiment <name>`. `run.js` also receives `--variant <control|mark-N>`, `--samples <N>`, and optional `--evalIds a,b`.

## Validation

`forge validate <runbook-id>` checks manifest shape, referenced evals, criteria tiers, README presence, fixture references, and step shim presence.
