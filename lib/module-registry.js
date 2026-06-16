import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createForgeRegistry({ repoRoot }) {
  const runbookRoots = [path.join(repoRoot, 'runbooks')];
  const commands = new Map();
  const commandMeta = new Map();
  const doctorChecks = [];
  const preStepHooks = [];
  const abortHooks = [];

  return {
    repoRoot,
    registerRunbookRoot(root) {
      runbookRoots.push(path.resolve(root));
    },
    registerCommand(name, handler, meta = null) {
      commands.set(name, handler);
      if (meta) {
        commandMeta.set(name, meta);
      }
    },
    registerDoctorCheck(check) {
      doctorChecks.push(check);
    },
    registerPreStepHook(hook) {
      preStepHooks.push(hook);
    },
    registerAbortHook(hook) {
      abortHooks.push(hook);
    },
    runbookRoots() {
      return [...new Set(runbookRoots.map(root => path.resolve(root)))];
    },
    commands() {
      return commands;
    },
    commandMeta() {
      return commandMeta;
    },
    doctorChecks() {
      return [...doctorChecks];
    },
    preStepHooks() {
      return [...preStepHooks];
    },
    abortHooks() {
      return [...abortHooks];
    },
  };
}

async function readConfig(repoRoot, configPath = path.join(repoRoot, 'forge.config.json')) {
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { modules: [] };
    }
    throw err;
  }
}

async function loadModule(moduleSpec, registry) {
  const modulePath = path.resolve(registry.repoRoot, moduleSpec.path || moduleSpec);
  let entry = modulePath;
  const stat = await fs.stat(entry);
  if (stat.isDirectory()) {
    entry = path.join(entry, 'index.js');
  }
  const mod = await import(pathToFileURL(entry).href);
  const register = mod.register || mod.default;
  if (typeof register !== 'function') {
    throw new Error(`forge module ${modulePath} must export register(forge)`);
  }
  await register(registry, { modulePath, spec: moduleSpec });
}

export async function loadForgeRegistry({ repoRoot }) {
  const registry = createForgeRegistry({ repoRoot });
  const config = await readConfig(repoRoot);
  for (const moduleSpec of config.modules || []) {
    await loadModule(moduleSpec, registry);
  }
  return registry;
}

export async function listRunbooks(registry) {
  const out = [];
  for (const root of registry.runbookRoots()) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(root, entry.name);
      let manifest = null;
      try {
        manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
      } catch {}
      out.push({ id: entry.name, dir, root, manifest });
    }
  }
  return out;
}

export async function findRunbook(registry, id) {
  return (await listRunbooks(registry)).find(runbook => runbook.id === id) || null;
}
