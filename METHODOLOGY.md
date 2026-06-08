# Forge methodology

Forge uses standard experiment-harness terms and directory shapes.

## Glossary

| Term | Definition |
|---|---|
| Experiment | Named investigation under `experiments/<name>/`. |
| Variant | Configuration being compared. `control` is the baseline, `mark-N` variants are candidates. |
| Run | Timestamped execution of one variant. |
| Sample | One invocation of one eval inside a run. |
| Eval | Test-case definition under a runbook's `evals/` directory. |
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
