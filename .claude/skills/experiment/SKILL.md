---
name: experiment
description: Run paired control/variant experiments using Forge.
---

# Forge experiment

Use this skill when the user asks to list runbooks, create an experiment, run a control/variant pair, score, judge, report, or compare results.

Read `README.md`, `METHODOLOGY.md`, the target runbook `README.md`, and the experiment's `experiment.json` before running commands.

Use the `forge` CLI as the driver. Do not call runbook scripts directly unless debugging a failed Forge command.

## Judge model policy

The judge runs as a sub-agent that reads `judge-prompts/*.md` and writes verdicts to `judge-verdicts/`. To avoid a wasted grading pass:

1. **Never hand-write the verdict schema.** Hand the sub-agent the verbatim output of `forge judge <experiment> --dispatch-prompt`. It carries the exact `criteria_results` schema, the required model, and the paths. Inventing a `{criteria: [...]}` shape gets rejected only at collect, after the whole pass is spent.
2. **Use the model the dispatch prompt names** (the single source of truth is `REQUIRED_JUDGE_MODEL` in `lib/judge.js`). Mixing models within a control/variant pair contaminates the comparison; off-model verdicts are rejected.
3. **Validate before collect.** After the sub-agent reports done, run `forge judge <experiment> --mode validate` to catch wrong-shape verdicts immediately. Only run `--mode collect` then `forge score` once validate is clean. Collect now BLOCKS loudly on any missing or invalid verdict instead of green-lighting score.
