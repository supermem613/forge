# Forge — Experiment Harness

Forge is a local-first harness for paired control/variant experiments. It owns the generic lifecycle, artifact layout, scoring, judging, reporting, and module-loading seams. Domain-specific integrations live in separately loaded modules.

## Install

```powershell
npm install
npm link
forge --help
```

You can also run the CLI without linking:

```powershell
node lib\cli.js --help
```

## Concepts

| Term | Meaning |
|---|---|
| **Runbook** | Reusable recipe under `runbooks/<id>/` or a registered module runbook root. |
| **Experiment** | Local lab notebook under `experiments/<name>/` that names one runbook. |
| **Control** | Baseline variant under `variants/control/`. |
| **Variant** | Candidate variant under `variants/mark-N/`. |
| **Run** | Timestamped execution bundle under `runs/<timestamp>/`. |
| **Pair** | Control run compared with one variant run. |

## CLI

```powershell
forge list
forge experiments
forge config init
forge config add-module --path C:\path\to\forge-module
forge new-experiment <name> --runbook <runbook>
forge propose <experiment> [--from <path>] [--iterate mark-N]
forge setup <experiment>
forge run <experiment> control --samples 3
forge run <experiment> mark-1 --samples 3
forge score <experiment> --pair latest
forge judge <experiment> --pair latest
forge report <experiment> --pair latest
forge teardown <experiment>
forge validate [runbook]
forge artifact-check <runDir> [--json]
```

Modules may register additional commands, runbook roots, doctor checks, pre-step hooks, and abort cleanup hooks. Forge remains the only CLI driver.

## Repository layout

```text
forge/
  lib/                  generic harness primitives and CLI
  docs/                 runbook and run artifact contracts
  runbooks/             optional generic runbooks
  experiments/          gitignored local experiment notebooks
  tests/                unit tests for generic harness behavior
```

## Module configuration

`forge.config.json` is a local activation file and is ignored by git:

```json
{
  "modules": [
    { "name": "example-module", "path": "C:\\path\\to\\module" }
  ]
}
```

Each module exports `register(forge)` and can call:

```js
export function register(forge) {
  forge.registerRunbookRoot(new URL('./runbooks', import.meta.url))
  forge.registerCommand('my-command', async context => {})
  forge.registerDoctorCheck(async context => [])
  forge.registerPreStepHook(async context => {})
  forge.registerAbortHook(async context => {})
}
```

## Development

```powershell
npm install
npm test
npm run lint
```

## License

MIT
