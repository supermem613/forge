# Skills hold policy. CLI absorbs mechanics.

This is the **single contract** between forge's `.claude/skills/*` and
`lib/cli.js`. Every PR that touches either side is judged against it.

## The split

| Layer | Owns | Examples |
|---|---|---|
| **CLI** (`lib/cli.js` + `lib/*.js`) | Anything mechanical: file edits, schema validation, manifest patching, output formatting, semver, idempotent table writes, sub-agent dispatch prompts, paste-ready summaries. | `forge new-runbook` updates the catalog. `forge add-eval` patches the manifest. `forge bump --changelog` writes the README line. `forge judge --dispatch-prompt` emits the sub-agent prompt. `forge present` formats the user-facing block. |
| **Skill** (`.claude/skills/<name>/SKILL.md`) | Anything requiring **judgment, vocabulary, or policy**: when to invoke, what to ask the user, what each safety tenet means, how to interpret a result, which mode of operation is appropriate. | "Ask the user for the experiment name first." "Never reintroduce SAFE/DEGRADED/BROKEN vocabulary." "If gate-pass < 80%, downgrade conclusions." |

## The rule

If a skill step says **"edit file X to add line Y"**, **"run command A then command B"**,
**"copy this JSON shape verbatim"**, or **"format the output as Z"** —
**that's mechanics**. It belongs in the CLI, not in the skill.

The skill should reduce to:

```
1. Ask the user about <judgment call>.
2. Run `forge <one command>`.
3. Interpret the output: <policy>.
```

If you find yourself adding a 4th mechanical step, **stop and lift it into the
CLI instead**. Examples of past lifts:

- `runbook-create` step "Add row to runbooks/README.md catalog" → `forge new-runbook` does it.
- `runbook-add-eval` step "Patch manifest.json evals[]" → `forge add-eval` does it.
- `runbook-update` step "Append Changelog line to README" → `forge bump --changelog "..."` does it.
- `experiment` skill Phase B "Construct sub-agent prompt with schema" → `forge judge --dispatch-prompt` does it.
- `experiment` skill "Echo headline + learnings + heatmap to user" → `forge present` does it.

## How to detect drift

Periodic audit (every quarter, or after any large skill edit):

1. Read each `.claude/skills/<name>/SKILL.md`.
2. For every numbered step that doesn't start with "Ask", "Decide", "Interpret",
   "Confirm", or "Halt" — ask: **"Could this be one CLI command?"**
3. If yes, file a `lift-N-<name>` todo. Lift it. Delete the prose from the skill.
4. Tests prove the mechanics. Skill prose is only as durable as the next session.

## Why

- **Mechanics drift.** Hand-edit instructions decay every time the underlying file format changes. Code stays in sync (with tests).
- **Sub-agents drop precision.** When a skill says "write JSON in this shape", the orchestrator may forward that to a sub-agent that paraphrases it. A `--dispatch-prompt` flag delivers the exact bytes.
- **Skills bloat.** A 437-line skill is an unread skill. Lifting mechanics keeps skills focused on judgment, which is what skills are uniquely good at.
- **One source of truth.** The CLI's tests verify the mechanics. The skill's prose verifies nothing — it's read-only documentation.

## Counterexamples (things that stay in skills)

- "Ask the user what hypothesis the variant tests." — judgment.
- "Never mix judge models within a control/variant pair." — policy.
- "If gate-pass < 80%, label conclusions preliminary." — policy.
- "Forge owns the headline numbers; don't paraphrase them." — policy.

These are NOT mechanical and CANNOT be lifted into the CLI. They live in skills forever.
