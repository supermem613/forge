# Forge decisions

Durable design decisions for the Forge harness. Each entry records what was
chosen, why, and what is explicitly out of scope, so future changes do not
re-litigate settled ground. See `METHODOLOGY.md` for terminology and
`docs/GOTCHAS.md` for operational traps.

## D1: Analysis is data-only; recommendations are a separate step

**Decision.** `forge report`, `forge present`, and `REPORT.md` describe only what
happened: scores, deltas, tool behavior, criterion movements, outliers. They
carry no prescriptions. Prescriptive guidance (what variant to try next, whether
to promote, sample-size advice) lives behind `forge recommend`.

**Why.** Co-mingling suggestions with measurements makes a reader trust an
opinion as if it were data, and it makes the report read differently every run
even when the numbers are stable. Splitting the two lets a reader consume the
evidence first and ask for advice deliberately.

**Shape.** `REPORT.json` remains the canonical store and keeps all three insight
buckets (`breakthroughs`, `pitfalls`, `suggestions`). The data surfaces render
only `breakthroughs` and `pitfalls`. `forge recommend` reads `suggestions` plus a
headline-driven next-step from the same `REPORT.json` with no recomputation.

**Out of scope.** Removing `suggestions` from `REPORT.json`. The data store is
complete on purpose; only the rendered text is split.

## D2: Efficiency tables report direction, not bare "% saved"

**Decision.** Efficiency rows render a signed, direction-worded change
(`18% faster`, `5% more`, `no change`) rather than a bare `12%`.

**Why.** A bare percentage hides whether higher is better. `pctSaved > 0` means
the variant spent less, which is good, but "12%" alone reads as ambiguous and was
mis-stated in earlier runs. Direction words remove the sign-convention guesswork.

**Shape.** `fmtChange(key, pctSaved)` in `lib/report.js` keys off the metric name:
time-like metrics say faster/slower, count-like metrics say fewer/more. All
efficiency keys are lower-is-better (latency, model time, ttfc, tokens, model
calls per solve).

## D3: `--quiet` exists because PowerShell treats native stderr as an error

**Decision.** A global `--quiet` flag suppresses Forge's own stderr chatter and
the final error echo. Stdout JSON and exit codes are unchanged.

**Why.** PowerShell raises a red `NativeCommandError` for any native-command
stderr write, even on a clean exit 0. The JSON success envelope on stdout already
carries everything a caller needs, so silencing stderr removes false-alarm noise
without losing information.

**Out of scope.** Suppressing the runbook child's own stdout/stderr. `--quiet`
governs the Forge wrapper only.

## D4: `forge grade` is a two-phase wrapper, not full automation

**Decision.** `forge grade <exp>` prepares judge prompts and prints the gpt-5.5
dispatch contract. `forge grade <exp> --finalize` validates verdicts, collects
them, and scores.

**Why.** Judging cannot be one-shot automated: an external gpt-5.5 sub-agent must
write the verdicts between prompt generation and collection. `grade` collapses the
surrounding four-call dance into two named phases around that authoring step.

**Shape.** Each underlying step runs with its stdout captured (see `runStep`'s
`capture` option) so `grade` emits exactly one JSON envelope, honoring the
single-envelope contract. The gpt-5.5 judge model is the only judge model.

## D5: One JSON envelope per command on stdout

**Decision.** Every non-interactive command writes exactly one JSON envelope to
stdout. Progress, banners, and human-readable errors go to stderr. There is no
`--json` flag; JSON is the only stdout format.

**Why.** A single, predictable stdout shape lets any caller parse results without
heuristics. Wrapper commands that fan out to child steps must capture child
stdout rather than letting multiple envelopes interleave.

## D6: `<subcommand> --help` returns that command's schema slice

**Decision.** `forge <subcommand> --help` prints the machine-readable schema for
that one command and exits 0, instead of erroring or printing prose.

**Why.** An agent can ask any command how to call it without parsing the whole
`forge schema` catalog, and without a separate help format to keep in sync.
