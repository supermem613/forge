# Forge methodology

Forge uses standard experiment-harness terms and directory shapes.

## Glossary

| Term | Definition |
|---|---|
| Experiment | Named investigation under `experiments/<name>/`. |
| Variant | Configuration being compared. `control` is the baseline, `mark-N` variants are candidates. |
| Run | Timestamped execution of one variant. |
| Sample | One invocation of one eval inside a run. |
| Eval | Test-case definition under a runbook's `evals/` directory. One eval enforces one production behavior. |
| Runbook | Reusable recipe containing manifest, evals, fixtures, and step shims. |
| Criterion | Single judgeable assertion in a severity tier. |
| Judge | LLM-as-judge step that grades criteria from run artifacts. |
| Report | Human-readable rollup for a run pair. |

## Directory schema

```text
forge/
  lib/
  docs/
  runbooks/
  experiments/
    <experiment>/
      experiment.json
      variants/
        control/
          artifacts/
          runs/<timestamp>/
        mark-1/
          artifacts/
          runs/<timestamp>/
```

## Lifecycle

```text
setup -> run -> score -> judge -> report -> teardown
```

Forge owns the lifecycle and delegates domain-specific behavior to runbooks and configured modules.

## Evidence rule

Completed run bundles are append-only evidence. Re-scoring, refits, or resamples must write sibling artifacts rather than rewriting canonical run evidence.

## Eval discipline

1. **Targeted evals.** Each eval locks one production behavior. A large suite that does not match production behaviors is noise.
2. **Dogfood loop.** When a real run fails for a real reason, add an eval that would have caught it, then re-run the pair.
3. **Correctness first.** Judge `must` on outcomes. Compare efficiency between control and variant in the report; do not smuggle cost into pass/fail criteria unless the product requires it.
4. **Partial runs.** Use `forge run … --evalIds a,b` when you need a cheap slice.

## Variant artifacts invariant

**Mark variants MUST keep full treatment inputs under ariants/<mark>/artifacts/.**  
**Each mark run MUST also freeze those inputs under uns/<ts>/snapshots/.**

- Hashes / package-identity.json alone are not enough.
- Archives pack the experiment tree; if the skill body is missing from the variant, history is lost when the live package moves on.
- Control may leave rtifacts/ empty.
- Use lib/variant-artifacts.js (esolveAndFreezeTreatment) from every runbook that applies a treatment tree (skills, overlays, packs).
- Do not edit frozen rtifacts/ in place after scores exist; cut mark-N+1 instead.

