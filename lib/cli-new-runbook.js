// lib/cli-new-runbook.js — `forge new-runbook <id>`.
//
// Scaffolds a new runbooks/<id>/ directory with the canonical contract:
// manifest.json + step shim files + evals/ + fixtures/. Refuses to
// overwrite an existing directory. Designed so the runbook-create skill
// becomes a thin wrapper around this command.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addCatalogEntry } from './catalog.js';

const SHIM_TEMPLATES = {
  'setup.js': (id) => `#!/usr/bin/env node\n// runbooks/${id}/setup.js — shim over lib/setup.js (RUNBOOK_CONTRACT).\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nimport { runSetup } from '../../lib/setup.js';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nrunSetup({\n  argv: process.argv.slice(2),\n  runbookDir: __dirname,\n  repoRoot: path.resolve(__dirname, '..', '..'),\n}).catch(err => { process.stderr.write(\`setup: \${err.message}\\n\`); process.exit(1); });\n`,
  'teardown.js': (id) => `#!/usr/bin/env node\n// runbooks/${id}/teardown.js — shim over lib/teardown.js.\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nimport { runTeardown } from '../../lib/teardown.js';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nrunTeardown({\n  argv: process.argv.slice(2),\n  runbookDir: __dirname,\n  repoRoot: path.resolve(__dirname, '..', '..'),\n}).catch(err => { process.stderr.write(\`teardown: \${err.message}\\n\`); process.exit(1); });\n`,
  'judge.js': (id) => `#!/usr/bin/env node\n// runbooks/${id}/judge.js — shim over lib/judge-orchestrator.js.\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nimport { runJudge } from '../../lib/judge-orchestrator.js';\nexport { resolvePair } from '../../lib/run-pair.js';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nif (import.meta.url === \`file://\${process.argv[1].replace(/\\\\\\\\/g, '/')}\`) {\n  runJudge({\n    argv: process.argv.slice(2),\n    runbookDir: __dirname,\n    repoRoot: path.resolve(__dirname, '..', '..'),\n  }).catch(err => { process.stderr.write(\`judge: \${err.message}\\n\`); process.exit(1); });\n}\n`,
  'report.js': (id) => `#!/usr/bin/env node\n// runbooks/${id}/report.js — shim over lib/report.js.\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nimport { runReport } from '../../lib/report.js';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nrunReport({\n  argv: process.argv.slice(2),\n  repoRoot: path.resolve(__dirname, '..', '..'),\n}).catch(err => { process.stderr.write(\`report: \${err.message}\\n\`); process.exit(1); });\n`,
  'score.js': (id) => `#!/usr/bin/env node\n// runbooks/${id}/score.js — author your scoring logic here, or wrap lib/score.js.\nprocess.stderr.write('score: not yet implemented for ${id}\\n');\nprocess.exit(1);\n`,
  'run.js': (id) => `#!/usr/bin/env node\n// runbooks/${id}/run.js — author your sample loop here.\n// Use loadRunContext() from lib/run-context.js for standard CLI args.\nimport { loadRunContext } from '../../lib/run-context.js';\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nasync function main() {\n  const ctx = await loadRunContext({\n    argv: process.argv.slice(2),\n    runbookId: '${id}',\n    runbookDir: __dirname,\n    repoRoot: path.resolve(__dirname, '..', '..'),\n  });\n  process.stderr.write(\`[${id}] run \${ctx.variant} (samples=\${ctx.samples}, evals=\${ctx.evals.length}) — implement me\\n\`);\n  process.exit(1);\n}\nmain().catch(err => { process.stderr.write(\`run: \${err.message}\\n\`); process.exit(1); });\n`,
};

export async function scaffoldRunbook({ runbookId, runbooksDir, description } = {}) {
  if (!runbookId) {
    throw new Error('scaffoldRunbook: runbookId required');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(runbookId)) {
    throw new Error(`scaffoldRunbook: runbookId must be kebab-case lowercase (got "${runbookId}")`);
  }
  if (!runbooksDir) {
    throw new Error('scaffoldRunbook: runbooksDir required');
  }
  const dir = path.join(runbooksDir, runbookId);
  let exists = false;
  try {
    await fs.access(dir); exists = true; 
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    } 
  }
  if (exists) {
    throw new Error(`runbook already exists: ${dir}`);
  }

  await fs.mkdir(path.join(dir, 'evals'), { recursive: true });
  await fs.mkdir(path.join(dir, 'fixtures'), { recursive: true });

  const manifest = {
    id: runbookId,
    version: '0.1.0',
    description: description || `Runbook ${runbookId} — describe what this measures.`,
    fixturePrefix: `_ForgeTest_${runbookId}_`,
    evals: ['evals/01-example.json'],
    defaults: { samples: 3 },
    safety: { fixturesCleanedBeforeAndAfter: true },
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const exampleEval = {
    id: 'example',
    description: 'Example eval — replace with a real test case.',
    prompt: 'Ask the agent something specific to your runbook.',
    criteria: {
      must: [{ text: 'The response addresses the user prompt.' }],
      should: [],
      could: [],
    },
  };
  await fs.writeFile(path.join(dir, 'evals', '01-example.json'), JSON.stringify(exampleEval, null, 2) + '\n');

  for (const [name, tmpl] of Object.entries(SHIM_TEMPLATES)) {
    await fs.writeFile(path.join(dir, name), tmpl(runbookId));
  }

  await fs.writeFile(path.join(dir, 'README.md'),
    `# ${runbookId}\n\n${manifest.description}\n\nSee \`docs/RUNBOOK_CONTRACT.md\` for the file shape and step contracts.\n`);

  // Idempotently register the runbook in runbooks/README.md catalog.
  // Errors from the catalog write are non-fatal: the scaffold itself
  // succeeded; the user can hand-edit if the catalog file shape is broken.
  let catalogResult;
  try {
    catalogResult = await addCatalogEntry({
      catalogPath: path.join(runbooksDir, 'README.md'),
      runbookId,
      description: manifest.description,
    });
  } catch (e) {
    catalogResult = { changed: false, error: e.message };
  }

  return { dir, manifest, catalog: catalogResult };
}
