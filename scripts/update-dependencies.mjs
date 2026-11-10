#!/usr/bin/env node
// Moves every registry dependency to ^<npm "latest"> and regenerates the npm, pnpm and child locks.
// --check reports what would change and exits 1 when anything is behind, writing nothing.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workspacePackages } from "./root-package.mjs";

const SECTIONS = /** @type {const} */ (["dependencies", "devDependencies", "optionalDependencies"]);
const REGISTRY_RANGE = /^(\^|~|>=)?\d+(\.\d+){0,2}$/;
const STABLE = /^\d+\.\d+\.\d+$/;

/**
 * The spec a registry dependency should have, or undefined when it is not a registry range.
 * @param {string} spec
 * @param {string} latest
 * @returns {string | undefined}
 */
export function targetSpec(spec, latest) {
  if (!REGISTRY_RANGE.test(spec)) return undefined;
  if (!STABLE.test(latest)) throw new Error(`Refusing prerelease or malformed latest version ${latest}`);
  return `^${latest}`;
}

/** @typedef {{ section: string, name: string, from: string, to: string }} Change */

/**
 * @param {Record<string, unknown>} manifest
 * @param {(name: string) => string} latestOf
 * @returns {Change[]}
 */
export function planManifest(manifest, latestOf) {
  /** @type {Change[]} */
  const changes = [];
  for (const section of SECTIONS) {
    const deps = /** @type {Record<string, string> | undefined} */ (manifest[section]);
    for (const [name, from] of Object.entries(deps ?? {})) {
      if (!REGISTRY_RANGE.test(from)) continue;
      const to = /** @type {string} */ (targetSpec(from, latestOf(name)));
      if (to !== from) changes.push({ section, name, from, to });
    }
  }
  return changes;
}

/**
 * The manifest text with each change applied inside its own section, so formatting and peers stay as written.
 * @param {string} text
 * @param {Change[]} changes
 */
export function applyChanges(text, changes) {
  for (const change of changes) {
    const open = text.indexOf(`"${change.section}": {`);
    const close = text.indexOf("}", open);
    const entry = `${JSON.stringify(change.name)}: ${JSON.stringify(change.from)}`;
    const at = text.indexOf(entry, open);
    if (open < 0 || at < 0 || at > close) throw new Error(`Cannot find ${change.section} ${change.name} ${change.from}`);
    text = text.slice(0, at) + `${JSON.stringify(change.name)}: ${JSON.stringify(change.to)}` + text.slice(at + entry.length);
  }
  return text;
}

/** @param {string} name */
function npmLatest(name) {
  return execFileSync("npm", ["view", name, "dist-tags.latest"], { encoding: "utf8" }).trim();
}

/** @param {string} cwd @param {string} command @param {string[]} args */
function run(cwd, command, args) {
  execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

const LOCK_ONLY = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];

/** npm in a workspace directory acts on the root, so a child lock is built from a lone copy of its manifest. */
function childLock(/** @type {string} */ dir) {
  const scratch = mkdtempSync(join(tmpdir(), "child-lock-"));
  try {
    copyFileSync(join(dir, "package.json"), join(scratch, "package.json"));
    run(scratch, "npm", LOCK_ONLY);
    copyFileSync(join(scratch, "package-lock.json"), join(dir, "package-lock.json"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const check = process.argv.includes("--check");
  const dirs = [".", ...[...workspacePackages(root).values()].map(workspace => workspace.dir)];
  /** @type {Map<string, string>} */
  const cache = new Map();
  const latestOf = (/** @type {string} */ name) => cache.get(name) ?? cache.set(name, npmLatest(name)).get(name) ?? "";
  let behind = 0;
  for (const dir of dirs) {
    const path = join(root, dir, "package.json");
    const text = readFileSync(path, "utf8");
    const changes = planManifest(JSON.parse(text), latestOf);
    for (const change of changes) console.log(`${dir} ${change.section} ${change.name} ${change.from} -> ${change.to}`);
    behind += changes.length;
    if (check || !changes.length) continue;
    writeFileSync(path, applyChanges(text, changes));
  }
  if (check) {
    console.log(behind ? `${behind} dependency specs are behind npm latest.` : "Every dependency spec is at npm latest.");
    process.exitCode = behind ? 1 : 0;
    return;
  }
  // An existing lock keeps every transitive version its range still allows: update moves those too.
  run(root, "npm", LOCK_ONLY);
  run(root, "npm", ["update", ...LOCK_ONLY.slice(1)]);
  rmSync(join(root, "pnpm-lock.yaml"), { force: true });
  run(root, "pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
  for (const dir of dirs.slice(1)) if (existsSync(join(root, dir, "package-lock.json"))) childLock(join(root, dir));
  console.log(`Updated ${behind} dependency specs and regenerated the locks.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
