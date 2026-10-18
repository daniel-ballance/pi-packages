#!/usr/bin/env node
// Explicit development-install step, never a lifecycle hook or a check-time repair.
// npm honors the Pi SDK's published shrinkwrap ahead of our outer security pins.
import { cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const root = await realpath(resolve(process.argv[2] ?? sourceRoot));
const sdkName = "@earendil-works/pi-coding-agent";
const hosts: readonly { packageName: string; alias: string }[] = [
  ...["claude-subscription", "computer-use", "mcp-client", "self-reload", "subagents", "todo", "web-search"]
    .map((packageName: string): { packageName: string; alias: string } => ({ packageName, alias: sdkName })),
];

type Dependency = {
  name: "brace-expansion" | "undici";
  sourceVersion: string;
  major: number;
  minor: number;
  patch: number;
  integrity?: string;
};
const dependencies: readonly Dependency[] = [
  { name: "brace-expansion", sourceVersion: "5.0.12", major: 5, minor: 0, patch: 12 },
  { name: "undici", sourceVersion: "8.12.2", major: 8, minor: 10, patch: 2,
    integrity: "sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==" },
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(entries);
}

async function json(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return object(value, path);
}

function inside(path: string, boundary: string = root): void {
  const part = relative(boundary, path);
  if (part === "" || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error(`Refusing security patch outside this development checkout: ${path}`);
  }
}

async function cachePath(directory: string): Promise<string> {
  const parent = await realpath(directory);
  inside(parent);
  return join(parent, ".package-lock.json");
}

function patched(version: unknown, dependency: Dependency): boolean {
  if (typeof version !== "string") throw new Error(`${dependency.name} version must be a string`);
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (parts === null || parts[1] !== String(dependency.major)) {
    throw new Error(`Unreviewed ${dependency.name} version: ${version}`);
  }
  const minor = Number(parts[2]);
  const patch = Number(parts[3]);
  if (![minor, patch].every(Number.isSafeInteger)) throw new Error(`Invalid ${dependency.name} version`);
  return minor > dependency.minor || (minor === dependency.minor && patch >= dependency.patch);
}

function noUndiciDependencies(manifest: Record<string, unknown>): void {
  if (manifest.dependencies !== undefined &&
      Object.keys(object(manifest.dependencies, "undici dependencies")).length !== 0) {
    throw new Error("Unreviewed undici dependency shape");
  }
}

function validateSource(manifest: Record<string, unknown>, dependency: Dependency): void {
  if (manifest.name !== dependency.name || manifest.version !== dependency.sourceVersion) {
    throw new Error(`Install the reviewed ${dependency.name} ${dependency.sourceVersion} development dependency first`);
  }
  if (!patched(dependency.sourceVersion, dependency)) {
    throw new Error("Reviewed source is below its security floor");
  }
  if (dependency.name === "undici") {
    noUndiciDependencies(manifest);
    if (object(manifest.engines, "undici source engines").node !== ">=22.19.0") {
      throw new Error("Unreviewed undici source engines");
    }
  }
}

type Source = {
  dependency: Dependency;
  path: string;
  manifest: Record<string, unknown>;
  resolution: Record<string, unknown>;
};
type Replacement = { target: string; source: Source };
type Plan = {
  sdk: string;
  replacements: Replacement[];
  shrinkwrapPath: string;
  shrinkwrap: Record<string, unknown>;
  cachePaths: readonly string[];
};
type Stage = { replacement: Replacement; path: string; moved: boolean };

// Validate every host before changing any of them. Never follow a link into the
// global Pi installation. Sources are separately installed with npm/pnpm's
// lockfile-integrity verification; no downloads or package scripts run here.
const lock = await json(join(sourceRoot, "package-lock.json"));
const packages = object(lock.packages, "root lock packages");
const sources: Source[] = [];
for (const dependency of dependencies) {
  const path = await realpath(join(sourceRoot, "node_modules", dependency.name));
  inside(path, sourceRoot);
  const manifest = await json(join(path, "package.json"));
  validateSource(manifest, dependency);
  const resolution = object(packages[`node_modules/${dependency.name}`], "security source lock entry");
  if (resolution.version !== dependency.sourceVersion ||
      resolution.resolved !== `https://registry.npmjs.org/${dependency.name}/-/${dependency.name}-${dependency.sourceVersion}.tgz` ||
      typeof resolution.integrity !== "string" || !resolution.integrity.startsWith("sha512-") ||
      (dependency.integrity !== undefined && resolution.integrity !== dependency.integrity)) {
    throw new Error("Security source must have the reviewed version, registry URL and SHA-512 integrity");
  }
  sources.push({ dependency, path, manifest, resolution });
}
const scope = await json(join(root, "package.json"));
const standaloneNames: Record<string, string> = {
  "claude-subscription": "claude-subscription",
  "computer-use": "computer-use",
  "mcp-client": "mcp-client", "self-reload": "self-reload", "subagents": "subagents",
  "todo": "todo", "web-search": "web-search",
};
const scopeName = scope.name;
if (typeof scopeName !== "string" ||
    (scopeName !== "pi-packages-repo" && !Object.hasOwn(standaloneNames, scopeName))) {
  throw new Error("Security patch scope must be this collection or a standalone development package");
}
const selected = scopeName === "pi-packages-repo" ? hosts : hosts.filter(
  (host: { packageName: string; alias: string }): boolean => host.packageName === standaloneNames[scopeName],
);
const rootCache = await cachePath(join(root, "node_modules"));
const plans: Plan[] = [];
const visited = new Set<string>();
for (const host of selected) {
  const directory = scopeName === "pi-packages-repo" ? join(root, "packages", host.packageName) : root;
  const hostCache = await cachePath(join(directory, "node_modules"));
  const sdk = await realpath(join(directory, "node_modules", host.alias));
  inside(sdk);
  const manifest = await json(join(sdk, "package.json"));
  if (manifest.name !== sdkName || typeof manifest.main !== "string") {
    throw new Error(`Unexpected development Pi host: ${host.packageName}/${host.alias}`);
  }
  const entry = await realpath(resolve(sdk, manifest.main));
  inside(entry, sdk);
  // pnpm can link multiple hosts to one SDK. Coalesce their replacements and
  // metadata into one transaction rather than replaying a stale shrinkwrap.
  const existing = plans.find((plan: Plan): boolean => plan.sdk === sdk);
  if (existing !== undefined) {
    existing.cachePaths = [...existing.cachePaths, hostCache];
  }
  if (visited.has(sdk)) continue;
  visited.add(sdk);
  const sdkRequire = createRequire(entry);
  let plan: Plan | undefined;
  for (const source of sources) {
    const { dependency } = source;
    const dependencyRequire = dependency.name === "brace-expansion" ?
      createRequire(sdkRequire.resolve("minimatch")) : sdkRequire;
    const target = await realpath(dirname(dependencyRequire.resolve(`${dependency.name}/package.json`)));
    inside(target);
    const current = await json(join(target, "package.json"));
    if (current.name !== dependency.name) {
      throw new Error(dependency.name === "brace-expansion" ? "Unexpected matcher dependency" : "Unexpected undici dependency");
    }
    if (dependency.name === "undici") noUndiciDependencies(current);
    if (patched(current.version, dependency)) continue;
    inside(target, sdk);
    if (dependency.name === "brace-expansion") {
      const oldDependencies = object(current.dependencies, "old brace dependencies");
      if (Object.keys(oldDependencies).length !== 1 || oldDependencies["balanced-match"] !== "^4.0.2") {
        throw new Error("Unreviewed brace-expansion dependency shape");
      }
    }
    if (plan === undefined) {
      const shrinkwrapPath = await realpath(join(sdk, "npm-shrinkwrap.json"));
      inside(shrinkwrapPath, sdk);
      const shrinkwrap = await json(shrinkwrapPath);
      plan = {
        sdk, replacements: [], shrinkwrapPath,
        shrinkwrap: { ...shrinkwrap, packages: object(shrinkwrap.packages, "Pi shrinkwrap packages") },
        cachePaths: [hostCache, await cachePath(join(sdk, "node_modules"))],
      };
    }
    const entries = object(plan.shrinkwrap.packages, "Pi shrinkwrap packages");
    const key = relative(sdk, target).split(sep).join("/");
    const old = object(entries[key], `Pi shrinkwrap ${dependency.name} entry`);
    if (old.version !== current.version) throw new Error("Installed Pi dependency disagrees with its shrinkwrap");
    if (dependency.name === "undici") noUndiciDependencies(old);
    entries[key] = {
      ...old, version: dependency.sourceVersion, resolved: source.resolution.resolved, integrity: source.resolution.integrity,
    };
    plan.shrinkwrap.packages = entries;
    plan.replacements.push({ target, source });
  }
  if (plan !== undefined) plans.push(plan);
}

for (const plan of plans) {
  const stages: Stage[] = [];
  let committed = false;
  try {
    // Stage both libraries before promoting either, then publish one merged
    // shrinkwrap. A promotion failure restores every replacement in this SDK.
    for (const replacement of plan.replacements) {
      const path = await mkdtemp(join(dirname(replacement.target), `.${replacement.source.dependency.name}-security-`));
      const stage: Stage = { replacement, path, moved: false };
      stages.push(stage);
      await cp(replacement.source.path, join(path, "replacement"), { recursive: true });
      const staged = await json(join(path, "replacement/package.json"));
      if (JSON.stringify(staged) !== JSON.stringify(replacement.source.manifest)) {
        throw new Error("Security source changed during staging");
      }
    }
    const first = stages[0];
    if (first === undefined) throw new Error("Security plan has no replacements");
    const metadata = join(first.path, "shrinkwrap.json");
    await writeFile(metadata, `${JSON.stringify(plan.shrinkwrap, null, 2)}\n`);
    for (const stage of stages) {
      // Atomic replacement avoids mutating a package-manager store's hardlink
      // or following a predictable temporary-file symlink.
      await rename(stage.replacement.target, join(stage.path, "original"));
      stage.moved = true;
      await rename(join(stage.path, "replacement"), stage.replacement.target);
    }
    await rename(metadata, plan.shrinkwrapPath);
    committed = true;
    for (const cache of plan.cachePaths) await rm(cache, { force: true });
  } finally {
    if (!committed) {
      for (const stage of [...stages].reverse()) {
        if (!stage.moved) continue;
        await rm(stage.replacement.target, { recursive: true, force: true });
        await rename(join(stage.path, "original"), stage.replacement.target);
      }
    }
    for (const stage of stages) await rm(stage.path, { recursive: true, force: true });
  }
}
if (plans.length > 0) await rm(rootCache, { force: true });
console.log(`Pi host security: ${selected.length} checked, ${plans.length} patched to ${dependencies.map((dependency: Dependency): string => `${dependency.name} ${dependency.sourceVersion}`).join(" and ")}.`);
