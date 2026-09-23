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
  "defaults": { "samples": 3 },
  "evalKind": "judge"
}
```

`evalKind` is `oracle`, `judge`, or `hybrid`. Omit it to keep `judge`.

- `judge` (default): `forge grade` writes prompts and prints the gpt-5.5 dispatch contract. `forge grade --finalize` validates verdicts, collects them, and scores.
- `oracle`: no gpt-5.5 dispatch. `forge grade` reports `judgeDispatches: 0`. `forge grade --finalize` scores from `score.json` only. `--dispatch-prompt` fails.
- `hybrid`: same dispatch path as `judge` in this slice. Per-eval mix is not implemented.

Runbook modules may extend the manifest with namespaced fields.

## eval JSON

```json
{
  "id": "example",
  "description": "Enforces <one production behavior>. Proof: must criteria observe <concrete outcome>.",
  "prompt": "Prompt or input for the system under test.",
  "criteria": {
    "must": ["Required observable outcome."],
    "should": [],
    "could": []
  }
}
```

### Eval authoring rules

1. **One eval, one production behavior.** `description` names that behavior and how `must` proves it. Do not pack unrelated checks into one eval.
2. **More evals is not automatically better.** Add an eval only when it locks a behavior you care about in production (or a real failure you dogfooded).
3. **`must` is correctness only.** Put observable outcomes in `must`. Do not put speed, token cost, or “was efficient” in `must` unless that property is itself the product requirement. Pair efficiency stays in report metrics.
4. **Harness plumbing is not capability score.** Unit or integration checks of the runbook/harness do not belong in skill-quality evals.
5. **Targeted runs use `--evalIds`.** Prefer an explicit id list for partial suites. Do not invent taxonomy fields for grouping.

Criterion text is shown to the judge model verbatim. Rewording criteria invalidates prior verdicts because the criteria hash changes.

`forge validate` warns when `description` is missing or too short to state a behavior and its proof.

## Metrics profiles

Efficiency metrics use the Forge catalog in `lib/metrics.js` (see DECISIONS D8).

- **Profiles:** `core` → `efficiency` → `capacity` → `forensic` (each includes the previous).
- **Planes:** capture, score, and report are independent. A runbook may capture
  capacity telemetry while scoring only `efficiency`.
- **pair.json:** prefer `declareMetrics()` + `savings()` / `buildEfficiency()` so
  reports get direction-aware wording and provenance.
- **Honesty:** missing telemetry is `null`, never a fabricated zero. Do not put
  speed/token cost into eval `must` criteria unless that property is the product
  requirement (see eval rules above).

## Step shims

Step files are executable shims. They should delegate mechanics to reusable library code or module code and keep runbook-specific orchestration small.

All step shims receive `--experiment <name>`. `run.js` also receives `--variant <control|mark-N>`, `--samples <N>`, and optional `--evalIds a,b`.

## Validation

`forge validate <runbook-id>` checks manifest shape, referenced evals, criteria tiers, README presence, fixture references, and step shim presence. Run it before relying on a runbook, and after any hand edit.
