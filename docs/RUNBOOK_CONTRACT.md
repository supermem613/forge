# Runbook contract

A runbook is a self-contained scenario directory that Forge can `setup`, `run`, `judge`, `score`, `report`, and `teardown`.

## Naming

A runbook id is the **name of the skill or capability it evaluates**, in kebab-case: a runbook that measures the `prepare` skill is `runbooks/prepare/`, not `prepare-plan-relay` or `prepare-cost-v2`. The id answers "what is under test", never "which experiment am I running" or "which hypothesis am I testing this week". Those belong to `experiments/<name>/`, which is where variants, hypotheses, and run outputs live.

One runbook per skill. When you want to measure something new about the same skill, add an eval or a variant to the existing runbook rather than forking a second runbook, so results stay comparable over time.

## Creating a runbook

Always scaffold. Never hand-write the directory:

```bash
forge new-runbook <id>                       # into this repo's runbooks/
forge new-runbook <id> --module <name>       # into a configured module's runbooks/
forge new-runbook <id> --runbooks-dir <path> # into an explicit directory
```

`--module` resolves the module by name from `forge.config.json`, so a capability pack can own the runbooks for the skills it exercises.

A runbook must be a **directory**. `forge list` skips loose files inside a runbook root, so a stray `.md` there is invisible to forge while still looking authoritative to the next author; `forge list` reports such files as warnings. Put prose in `docs/`.

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

`forge validate <runbook-id>` checks manifest shape, referenced evals, criteria tiers, README presence, fixture references, and step shim presence. Run it before relying on a runbook, and after any hand edit.
