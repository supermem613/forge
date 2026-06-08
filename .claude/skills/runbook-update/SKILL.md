---
name: runbook-update
description: Make a controlled change to an existing forge runbook — manifest tweak, fixture update, README revision, default samples change, or version bump. Use when the user says "update <runbook>", "change samples to N for <runbook>", "swap the fixture in <runbook>", or "bump the version of <runbook>". NOT for editing an experiment instance — experiments are gitignored user data.
---

# runbook-update

You make a single, controlled change to one existing **runbook** under
`runbooks/<name>/`. Updates that touch the eval contract, criteria, or
variant-artifact shape MUST bump the manifest version and document the change
in the README.

Per-user experiments under `experiments/<name>/` are NOT in scope here —
those are local lab notebooks the user mutates freely.

## When to invoke

User says:
- "update <runbook> to do X"
- "change <runbook>'s samples default to N"
- "swap the fixture <a.docx> for <b.docx>"
- "bump <runbook>'s version"
- "rename an eval in <runbook>"
- "add a `must` criterion to eval <id>"

## Update categories

| Change | Bump version? | Notes |
|---|---|---|
| Default `samples` change | Patch (0.x.Y) | Document old → new in README. |
| Add an eval | Patch | Use `runbook-add-eval` skill instead. |
| Add criteria to an eval (any tier) | Minor (0.X.0) | Old judge verdicts no longer have those criterion entries → re-judge required. |
| Remove or rename an eval | Minor | Old run bundles still reference old eval ids; do NOT delete bundles. |
| Change criteria wording (kept same intent) | Patch | Old verdicts still tally; flag as "criteria edited" in README. |
| Swap a fixture file | Minor | Exercise prompts referencing the old fixture must also change. |
| Change variant-artifact shape (e.g., add a required ref file) | Major (X.0.0) | Breaks all prior runs. Strongly consider creating a new runbook instead. |
| Wording-only README change | None | No bump needed. |

## Steps

1. Confirm the change with one `ask_user` if there's any ambiguity about
   scope.
2. View `manifest.json`, the README, and any affected files.
3. Make the change.
4. If a version bump is needed, run `node lib/cli.js bump <rb>
   [patch|minor|major] --changelog "<one-line summary>"` (defaults
   to patch). The CLI bumps `manifest.json` AND inserts a newest-first
   entry under the README's `## Changelog` header (creating the
   section if missing). Do NOT hand-edit either file.
5. Run `node lib/cli.js validate <rb>` and `node lib/cli.js list` to
   confirm the runbook still parses end-to-end.
6. If the change invalidates prior run bundles in any user's
   `experiments/<exp>/.../runs/`, tell the user explicitly that
   prior pp deltas are no longer apples-to-apples and the user should
   re-run + re-judge.

## Things you MUST NOT do

- Don't silently change criteria or thresholds. Bump the version and
  call it out.
- Don't touch anyone's `experiments/<name>/` tree. That's user data.
- Don't reintroduce SAFE/DEGRADED/BROKEN vocabulary anywhere.
- Don't update both the runbook AND a kill-switch / unrelated repo
  concern in the same change. One concern per update.
## Skill vs CLI

This skill holds policy (the bump-level matrix, what counts as breaking, which user data must not be touched). All mechanical work — manifest rewrite, README changelog insertion — lives in `forge bump --changelog`. See `../../../docs/SKILL_CLI_POLICY.md`.
