#!/usr/bin/env node
// Explicit development-install step, never a lifecycle hook or a check-time repair.
// npm honors the Pi SDK's published shrinkwrap ahead of our outer security pin.
import { cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const root = await realpath(resolve(process.argv[2] ?? sourceRoot));
const floor = "5.0.12";
const sdkName = "@earendil-works/pi-coding-agent";
const hosts: readonly { packageName: string; alias: string }[] = [
  ...["durable-subagents", "mcp-client", "self-reload", "subagents", "t3-subagents", "web-search"]
    .map((packageName: string): { packageName: string; alias: string } => ({ packageName, alias: sdkName })),
  { packageName: "durable-subagents", alias: "pi-host-1" },
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

function patched(version: unknown): boolean {
  if (typeof version !== "string") throw new Error("brace-expansion version must be a string");
  const parts = /^5\.(\d+)\.(\d+)$/.exec(version);
  if (parts === null) throw new Error(`Unreviewed brace-expansion version: ${version}`);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (![minor, patch].every(Number.isSafeInteger)) throw new Error("Invalid brace-expansion version");
  return minor > 0 || patch >= 12;
}

type Plan = {
  target: string;
  shrinkwrapPath: string;
  shrinkwrap: Record<string, unknown>;
  cachePaths: readonly string[];
};

// Validate every host before changing any of them. Never follow a link into the
// global Pi installation. The source is separately installed with npm/pnpm's
// lockfile-integrity verification; no downloads or package scripts run here.
const source = await realpath(join(sourceRoot, "node_modules/brace-expansion"));
inside(source, sourceRoot);
const sourceManifest = await json(join(source, "package.json"));
if (sourceManifest.name !== "brace-expansion" || sourceManifest.version !== floor) {
  throw new Error(`Install the reviewed brace-expansion ${floor} development dependency first`);
}
const scope = await json(join(root, "package.json"));
const standaloneNames: Record<string, string> = {
  "@daniel-ballance/durable-subagents": "durable-subagents",
  "mcp-client": "mcp-client", "self-reload": "self-reload", "subagents": "subagents",
  "t3-subagents": "t3-subagents", "web-search": "web-search",
};
const scopeName = scope.name;
if (typeof scopeName !== "string" ||
    (scopeName !== "pi-packages-repo" && !Object.hasOwn(standaloneNames, scopeName))) {
  throw new Error("Security patch scope must be this collection or a standalone development package");
}
const selected = scopeName === "pi-packages-repo" ? hosts : hosts.filter(
  (host: { packageName: string; alias: string }): boolean => host.packageName === standaloneNames[scopeName],
);
const lock = await json(join(sourceRoot, "package-lock.json"));
const packages = object(lock.packages, "root lock packages");
const resolution = object(packages["node_modules/brace-expansion"], "security source lock entry");
if (resolution.version !== floor ||
    resolution.resolved !== `https://registry.npmjs.org/brace-expansion/-/brace-expansion-${floor}.tgz` ||
    typeof resolution.integrity !== "string" || !resolution.integrity.startsWith("sha512-")) {
  throw new Error("Security source must have the reviewed version, registry URL and SHA-512 integrity");
}
const plans: Plan[] = [];
for (const host of selected) {
  const directory = scopeName === "pi-packages-repo" ? join(root, "packages", host.packageName) : root;
  const sdk = await realpath(join(directory, "node_modules", host.alias));
  inside(sdk);
  const manifest = await json(join(sdk, "package.json"));
  if (manifest.name !== sdkName || typeof manifest.main !== "string") {
    throw new Error(`Unexpected development Pi host: ${host.packageName}/${host.alias}`);
  }
  const entry = await realpath(resolve(sdk, manifest.main));
  inside(entry, sdk);
  const sdkRequire = createRequire(entry);
  const matcherRequire = createRequire(sdkRequire.resolve("minimatch"));
  const target = await realpath(dirname(matcherRequire.resolve("brace-expansion/package.json")));
  inside(target);
  const current = await json(join(target, "package.json"));
  if (current.name !== "brace-expansion") throw new Error("Unexpected matcher dependency");
  if (patched(current.version)) continue;
  inside(target, sdk);
  const dependencies = object(current.dependencies, "old brace dependencies");
  if (Object.keys(dependencies).length !== 1 || dependencies["balanced-match"] !== "^4.0.2") {
    throw new Error("Unreviewed brace-expansion dependency shape");
  }
  const shrinkwrapPath = await realpath(join(sdk, "npm-shrinkwrap.json"));
  inside(shrinkwrapPath, sdk);
  const shrinkwrap = await json(shrinkwrapPath);
  const entries = object(shrinkwrap.packages, "Pi shrinkwrap packages");
  const old = object(entries["node_modules/brace-expansion"], "Pi shrinkwrap brace entry");
  if (old.version !== current.version) throw new Error("Installed Pi dependency disagrees with its shrinkwrap");
  entries["node_modules/brace-expansion"] = {
    ...old, version: floor, resolved: resolution.resolved, integrity: resolution.integrity,
  };
  plans.push({
    target, shrinkwrapPath, shrinkwrap: { ...shrinkwrap, packages: entries },
    cachePaths: [join(directory, "node_modules/.package-lock.json"), join(sdk, "node_modules/.package-lock.json")],
  });
}

for (const plan of plans) {
  const stage = await mkdtemp(join(dirname(plan.target), ".brace-security-"));
  let moved = false;
  let committed = false;
  try {
    const replacement = join(stage, "replacement");
    await cp(source, replacement, { recursive: true });
    const staged = await json(join(replacement, "package.json"));
    if (staged.version !== floor) throw new Error("Security source changed during staging");
    // Atomic replacement avoids mutating a package-manager store's hardlink
    // or following a predictable temporary-file symlink.
    const metadata = join(stage, "shrinkwrap.json");
    await writeFile(metadata, `${JSON.stringify(plan.shrinkwrap, null, 2)}\n`);
    await rename(plan.target, join(stage, "original"));
    moved = true;
    await rename(replacement, plan.target);
    await rename(metadata, plan.shrinkwrapPath);
    committed = true;
    for (const cache of plan.cachePaths) await rm(cache, { force: true });
  } finally {
    if (moved && !committed) {
      await rm(plan.target, { recursive: true, force: true });
      await rename(join(stage, "original"), plan.target);
    }
    await rm(stage, { recursive: true, force: true });
  }
}
if (plans.length > 0) await rm(join(root, "node_modules/.package-lock.json"), { force: true });
console.log(`Pi host security: ${selected.length} checked, ${plans.length} patched to brace-expansion ${floor}.`);
