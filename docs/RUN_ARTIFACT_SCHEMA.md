# Run artifact schema

This document defines the generic contract for files under a Forge run bundle:

```text
experiments/<experiment>/variants/<variant>/runs/<timestamp>/
```

The schema is read-side only. Artifact readers must not change prompts, mutate external state, or turn missing runs into reported results.

## Required files

Every new bundle opened by `openBundle()` writes:

| File | Contract |
|---|---|
| `manifest.json` | Bundle identity, schema versions, timestamps, pairing, and final summary. |
| `transcript.json` | Append-only index of turn artifact summaries written through `writeTurn()`. |

Runbooks may add domain artifacts such as `run.log`, `results.json`, `signals.json`, `score.json`, `REPORT.json`, `REPORT.md`, `judge-prompts/`, and `judge-verdicts/`.

## manifest.json

```json
{
  "bundleSchemaVersion": 1,
  "runArtifactSchemaVersion": 1,
  "experiment": "my-experiment",
  "variant": "control",
  "ts": "2026-05-11T15-30-00-000",
  "startedAt": "2026-05-11T15:30:00.000Z",
  "finalizedAt": null,
  "pairedControl": null,
  "summary": null
}
```

## transcript.json

```json
{
  "schemaVersion": 1,
  "experiment": "my-experiment",
  "variant": "mark-1",
  "runTs": "2026-05-11T15-30-00-000",
  "entries": [
    {
      "evalId": "example",
      "sample": 1,
      "turn": 1,
      "path": "turn1/example-sample1.json",
      "writtenAt": "2026-05-11T15:31:00.000Z",
      "ms": 12345,
      "promptChars": 420,
      "responseChars": 2048,
      "toolCalls": 2,
      "capabilitiesLoaded": [],
      "error": null,
      "generatedArtifactName": null,
      "childArtifactName": null
    }
  ]
}
```

## Append-only rule

Canonical run evidence is immutable after a run finishes. Derived refreshes write to sibling locations, not over canonical evidence.
