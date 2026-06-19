export const CORE_COMMANDS = Object.freeze([
  {
    path: ['list'],
    usage: 'list',
    summary: 'List committed runbooks.',
    effect: 'read',
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: 'RunbookList' },
    examples: ['forge list'],
  },
  {
    path: ['experiments'],
    usage: 'experiments',
    summary: 'List local experiments.',
    effect: 'read',
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: 'ExperimentList' },
  },
  {
    path: ['schema'],
    usage: 'schema [<command> [<subcommand>...]] [--summary]',
    summary: 'Emit the machine-readable command catalog.',
    effect: 'read',
    input: {
      positionals: [{ name: 'command', required: false, repeat: true }],
      flags: [{ name: 'summary', type: 'boolean' }],
    },
    output: { documented: true, schema: 'ForgeSchema' },
    examples: ['forge schema', 'forge schema run --summary'],
  },
  {
    path: ['config', 'init'],
    usage: 'config init',
    summary: 'Create local module configuration.',
    effect: 'mutate-local',
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: 'ConfigResult' },
  },
  {
    path: ['config', 'add-module'],
    usage: 'config add-module --path <path> [--name <name>]',
    summary: 'Register a local Forge module.',
    effect: 'mutate-local',
    input: {
      positionals: [],
      flags: [
        { name: 'path', type: 'string', required: true },
        { name: 'name', type: 'string' },
      ],
    },
    output: { documented: true, schema: 'ConfigResult' },
  },
  {
    path: ['new-experiment'],
    usage: 'new-experiment <exp> --runbook <rb> [--notes ..] [--control-from <dir>] [--treatment-url-params "?..."]',
    summary: 'Scaffold a local experiment.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [
        { name: 'runbook', type: 'string', required: true },
        { name: 'notes', type: 'string' },
        { name: 'control-from', type: 'path' },
        { name: 'treatment-url-params', type: 'string' },
      ],
    },
    output: { documented: true, schema: 'NewExperimentResult' },
    examples: ['forge new-experiment prompt-routing --runbook router-eval --notes "first cut"'],
  },
  {
    path: ['propose'],
    usage: 'propose <exp> [--from <p>] [--iterate mark-N] [--copy-prev] [--mark mark-N]',
    summary: 'Draft a variant under variants/mark-<next>/.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [
        { name: 'from', type: 'path' },
        { name: 'iterate', type: 'string' },
        { name: 'copy-prev', type: 'boolean' },
        { name: 'mark', type: 'string' },
      ],
    },
    output: { documented: true, schema: 'ProposeVariantResult' },
    examples: ['forge propose prompt-routing --from C:/temp/variant-artifacts'],
  },
  {
    path: ['setup'],
    usage: 'setup <exp>',
    summary: 'Run runbook setup.',
    effect: 'mutate-local',
    input: { positionals: [{ name: 'exp', required: true }], flags: [] },
    output: { documented: false },
    examples: ['forge setup prompt-routing'],
  },
  {
    path: ['run'],
    usage: 'run <exp> <control|mark-N> [--samples N] [--append-control] [--asymmetric] [--capture]',
    summary: 'Run samples for a control or variant.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }, { name: 'variant', required: true }],
      flags: [
        { name: 'samples', type: 'number' },
        { name: 'append-control', type: 'boolean' },
        { name: 'asymmetric', type: 'boolean' },
        { name: 'capture', type: 'boolean' },
      ],
    },
    output: { documented: false },
    examples: ['forge run prompt-routing control --samples 3', 'forge run prompt-routing mark-1 --samples 3'],
  },
  {
    path: ['score'],
    usage: 'score <exp> [--pair latest|<spec>]',
    summary: 'Run deterministic scoring of a paired run.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [{ name: 'pair', type: 'string' }],
    },
    output: { documented: false },
    examples: ['forge score prompt-routing --pair latest'],
  },
  {
    path: ['judge'],
    usage: 'judge <exp> [--pair latest|<spec>] [--mode agent|validate|collect] [--dispatch-prompt]',
    summary: 'Run agent-as-judge, validate verdict shape, or collect verdicts. --dispatch-prompt prints the exact sub-agent contract.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [
        { name: 'pair', type: 'string' },
        { name: 'mode', type: 'string' },
        { name: 'dispatch-prompt', type: 'boolean' },
      ],
    },
    output: { documented: false },
    examples: [
      'forge judge prompt-routing --dispatch-prompt',
      'forge judge prompt-routing --mode validate',
      'forge judge prompt-routing --pair latest --mode collect',
    ],
  },
  {
    path: ['report'],
    usage: 'report <exp> [--pair latest|<spec>]',
    summary: 'Write REPORT.md and REPORT.json into the variant run.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [{ name: 'pair', type: 'string' }],
    },
    output: { documented: true, schema: 'ReportArtifact' },
    examples: ['forge report prompt-routing --pair latest'],
  },
  {
    path: ['present'],
    usage: 'present <exp> [--pair latest|<spec>]',
    summary: 'Emit a paste-ready summary as data.markdown.',
    effect: 'read',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [{ name: 'pair', type: 'string' }],
    },
    output: { documented: true, schema: 'PresentationResult' },
  },
  {
    path: ['teardown'],
    usage: 'teardown <exp>',
    summary: 'Clean up runbook fixtures.',
    effect: 'mutate-local',
    input: { positionals: [{ name: 'exp', required: true }], flags: [] },
    output: { documented: false },
    examples: ['forge teardown prompt-routing'],
  },
  {
    path: ['archive'],
    usage: 'archive <exp> --to <path> [--keep-shell] [--no-zip] [--reason "..."] [--dry-run]',
    summary: 'Move a local experiment into an archive.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [
        { name: 'to', type: 'path', required: true },
        { name: 'keep-shell', type: 'boolean' },
        { name: 'no-zip', type: 'boolean' },
        { name: 'reason', type: 'string' },
        { name: 'dry-run', type: 'boolean' },
      ],
    },
    output: { documented: true, schema: 'ArchiveResult' },
  },
  {
    path: ['runs'],
    usage: 'runs <exp>',
    summary: 'List runs across control and variants.',
    effect: 'read',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [],
    },
    output: { documented: true, schema: 'RunList' },
  },
  {
    path: ['artifact-check'],
    usage: 'artifact-check <runDir>',
    summary: 'Validate manifest and transcript run artifact schema.',
    effect: 'read',
    input: {
      positionals: [{ name: 'runDir', required: true }],
      flags: [],
    },
    output: { documented: true, schema: 'ArtifactCheckResult' },
  },
  {
    path: ['adoption'],
    usage: 'adoption <exp> [--variant mark-N] [--run <dir>] [--known-verbs a,b] [--expect-verb v --min-rate 0.5] [--max-hand-reduce 0.3] [--forbid-dead]',
    summary: 'Report code-mode tool adoption (requested/surfaced/called/hand-reduce) for a run and optionally gate on it. Use as a pre-build probe so a build that does not move adoption fails in minutes.',
    effect: 'read',
    input: {
      positionals: [{ name: 'exp', required: true }],
      flags: [
        { name: 'variant', type: 'string' },
        { name: 'run', type: 'path' },
        { name: 'known-verbs', type: 'string' },
        { name: 'expect-verb', type: 'string' },
        { name: 'min-rate', type: 'number' },
        { name: 'max-hand-reduce', type: 'number' },
        { name: 'forbid-dead', type: 'boolean' },
      ],
    },
    output: { documented: true, schema: 'AdoptionResult' },
    examples: [
      'forge adoption code-mode --variant mark-11 --known-verbs files.search,files.extract,files.aggregate',
      'forge adoption code-mode --expect-verb files.select --min-rate 0.7',
    ],
  },
  {
    path: ['compare'],
    usage: 'compare <exp> <variantA> <variantB>',
    summary: 'Compare REPORT.json headlines between two variants.',
    effect: 'read',
    input: {
      positionals: [
        { name: 'exp', required: true },
        { name: 'variantA', required: true },
        { name: 'variantB', required: true },
      ],
      flags: [],
    },
    output: { documented: true, schema: 'CompareResult' },
  },
  {
    path: ['resample'],
    usage: 'resample <exp> <variant> --eval <id> --sample <N> [run flags...]',
    summary: 'Re-run one sample in place in the latest run for a variant. ' +
      'Forwards the remaining run flags (e.g. --spfx-dev-server, --capture) to the runbook; ' +
      '--eval/--sample identify the single sample and are not forwarded as run flags.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'exp', required: true }, { name: 'variant', required: true }],
      flags: [{ name: 'eval', type: 'string', required: true }, { name: 'sample', type: 'number', required: true }],
    },
    output: { documented: false },
    examples: ['forge resample code-mode mark-8 --eval 01-open-tasks-by-assignee --sample 5 --spfx-dev-server https://localhost:46435/'],
  },
  {
    path: ['doctor'],
    usage: 'doctor [--fix] [--wait] [--timeout MS] [--interval MS]',
    summary: 'Run environment health checks.',
    effect: 'read',
    input: {
      positionals: [],
      flags: [
        { name: 'fix', type: 'boolean' },
        { name: 'wait', type: 'boolean' },
        { name: 'timeout', type: 'number' },
        { name: 'interval', type: 'number' },
      ],
    },
    output: { documented: true, schema: 'DoctorResult' },
  },
  {
    path: ['validate'],
    usage: 'validate [<runbook>]',
    summary: 'Validate one or all runbooks against the runbook contract.',
    effect: 'read',
    input: {
      positionals: [{ name: 'runbook', required: false }],
      flags: [],
    },
    output: { documented: true, schema: 'ValidateResult' },
  },
  {
    path: ['update'],
    usage: 'update',
    summary: 'Self-update with git pull, npm install, build, and link.',
    effect: 'mutate-local',
    input: { positionals: [], flags: [] },
    output: { documented: true, schema: 'UpdateResult' },
  },
  {
    path: ['bump'],
    usage: 'bump <runbook> [patch|minor|major] [--changelog "summary"]',
    summary: 'Bump a runbook manifest version.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'runbook', required: true }, { name: 'level', required: false }],
      flags: [{ name: 'changelog', type: 'string' }],
    },
    output: { documented: true, schema: 'BumpResult' },
  },
  {
    path: ['add-eval'],
    usage: 'add-eval <runbook> --file <path>',
    summary: 'Register a new eval JSON in a runbook.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'runbook', required: true }],
      flags: [{ name: 'file', type: 'path', required: true }],
    },
    output: { documented: true, schema: 'AddEvalResult' },
  },
  {
    path: ['new-runbook'],
    usage: 'new-runbook <id> [--description "..."]',
    summary: 'Scaffold a new runbook.',
    effect: 'mutate-local',
    input: {
      positionals: [{ name: 'id', required: true }],
      flags: [{ name: 'description', type: 'string' }],
    },
    output: { documented: true, schema: 'NewRunbookResult' },
  },
]);

export function buildUsageText({ commands = CORE_COMMANDS, version = '0.0.0', description = 'experiment harness' } = {}) {
  const commandLines = commands.map((command) => {
    const usage = command.usage.padEnd(49);
    return `  ${usage} ${command.summary}`;
  });
  return `forge ${version} - ${description}

Commands:
${commandLines.join('\n')}
  <module-command>                                  Commands registered by configured modules.

Pair spec:
  latest                          latest control run × latest variant run under the largest mark
  <ctlTs>+<mark>:<txTs>           explicit, e.g. 2026-04-23T18-15-19-428+mark-1:2026-04-23T18-36-11-926

Examples:
  forge list
  forge --version
  forge schema --summary
  forge new-experiment prompt-routing --runbook router-eval --notes "first cut"
  forge propose prompt-routing --from C:/temp/variant-artifacts
  forge setup prompt-routing
  forge run   prompt-routing control --samples 3
  forge run   prompt-routing mark-1  --samples 3
  forge score prompt-routing --pair latest
  forge judge prompt-routing --pair latest
  forge report prompt-routing --pair latest
  forge teardown prompt-routing
`;
}

export function moduleCommandsForSchema(registry) {
  const metaMap = typeof registry.commandMeta === 'function' ? registry.commandMeta() : new Map();
  const out = [];
  for (const name of [...registry.commands().keys()].sort()) {
    const meta = metaMap.get(name);
    if (meta && Array.isArray(meta.subcommands) && meta.subcommands.length) {
      for (const sub of meta.subcommands) {
        out.push({
          path: [name, sub.name],
          summary: sub.summary || 'Module-registered command.',
          effect: sub.effect || 'mutate-local',
          input: sub.input || { positionals: [], flags: [] },
          output: sub.output || { documented: false },
          moduleCommand: true,
        });
      }
      continue;
    }
    out.push({
      path: [name],
      summary: meta?.summary || 'Module-registered command.',
      effect: meta?.effect || 'mutate-local',
      input: meta?.input || { positionals: [], flags: [] },
      output: meta?.output || { documented: false },
      moduleCommand: true,
    });
  }
  return out;
}

export function buildSchema({ version, registry, commandPrefix = [], summary = false }) {
  const commands = [...CORE_COMMANDS, ...moduleCommandsForSchema(registry)]
    .filter((command) => commandPrefix.every((part, index) => command.path[index] === part));
  if (summary) {
    return {
      schemaVersion: 1,
      cliVersion: version,
      commandCount: commands.length,
      commandPaths: commands.map((command) => command.path.join(' ')),
    };
  }
  return {
    schemaVersion: 1,
    cliVersion: version,
    envelope: {
      stdout: 'JSON only. Every non-interactive command emits a JSON envelope on stdout; schema and doctor use their own documented top-level shapes.',
      stderr: 'Progress, diagnostics, banners, and human-readable errors.',
      successEnvelope: ['ok', 'command', 'data'],
      errorEnvelope: ['ok', 'command', 'error', 'code', 'hint'],
    },
    globalFlags: [
      { name: 'help', aliases: ['h'], type: 'boolean' },
      { name: 'version', type: 'boolean' },
    ],
    commands,
    errorCodes: [
      { code: 'USAGE', description: 'Required command, positional argument, or flag is missing.' },
      { code: 'NOT_FOUND', description: 'Requested experiment, runbook, run, or artifact path does not exist.' },
      { code: 'VALIDATION_FAILED', description: 'A runbook, artifact, or environment validation failed.' },
      { code: 'CONFLICT', description: 'Target already exists or conflicts with current state.' },
      { code: 'ERROR', description: 'Unclassified failure.' },
    ],
    exitCodes: [
      { code: 0, meaning: 'Success.' },
      { code: 1, meaning: 'Usage error, validation failure, or command failure.' },
    ],
  };
}
