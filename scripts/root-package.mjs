#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ readonly name: string, readonly dir: string }} Workspace */
/** @typedef {Record<(typeof RESOURCES)[number], string[]>} Resources */

const RESOURCES = /** @type {const} */ (["extensions", "skills", "prompts", "themes"]);

/** @param {string} path */
const readJson = path => JSON.parse(readFileSync(path, "utf8"));

/**
 * Root `workspaces` expanded, keyed by package name. A pattern is a literal directory or a
 * directory with one trailing "/*". `dir` is repository-relative POSIX. Directories without a
 * package.json are not packages.
 * @param {string} root
 * @returns {ReadonlyMap<string, Workspace>}
 */
export function workspacePackages(root) {
  /** @type {Map<string, Workspace>} */
  const packages = new Map();
  /** @type {string[]} */
  const patterns = readJson(join(root, "package.json")).workspaces ?? [];
  for (const pattern of patterns) {
    const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
    if (base.includes("*")) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const dirs = base === pattern ? [pattern] : readdirSync(join(root, base), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => `${base}/${entry.name}`).sort();
    for (const dir of dirs) {
      if (!existsSync(join(root, dir, "package.json"))) continue;
      /** @type {string} */
      const name = readJson(join(root, dir, "package.json")).name;
      const previous = packages.get(name);
      if (previous !== undefined) throw new Error(`Workspace name ${name} is used by ${previous.dir} and ${dir}`);
      packages.set(name, { name, dir });
    }
  }
  return packages;
}

/**
 * The root `pi` block: each `piBundle` member's own `pi` entries rebased onto the member
 * directory, in piBundle order and then member order. Pi installs a Git source with one
 * production install at the root, so a member that is not a workspace would load without
 * its dependencies.
 * @param {string} root
 * @returns {Resources}
 */
function rootManifest(root) {
  const members = readJson(join(root, "package.json")).piBundle;
  if (!Array.isArray(members)) throw new Error("package.json has no piBundle list");
  const workspaces = new Set([...workspacePackages(root).values()].map(workspace => workspace.dir));
  /** @type {Resources} */
  const manifest = { extensions: [], skills: [], prompts: [], themes: [] };
  for (const member of members) {
    if (!workspaces.has(member)) throw new Error(`piBundle member ${member} is not a workspace, so a Git install would not install its dependencies`);
    const { pi } = readJson(join(root, member, "package.json"));
    if (pi === undefined) throw new Error(`piBundle member ${member} has no pi block`);
    for (const type of RESOURCES) {
      for (const entry of pi[type] ?? []) {
        const parts = /^(!?)\.\/(.+)$/.exec(entry);
        if (parts === null) throw new Error(`${member}: pi.${type} entry ${entry} must start with "./" or "!./"`);
        manifest[type].push(`${parts[1]}./${member}/${parts[2]}`);
      }
    }
  }
  return manifest;
}

/** @param {string} root */
function t3LaunchArgs(root) {
  const entry = rootManifest(root).extensions.find(entry => /\/claude-subscription\/index\.[cm]?[jt]s$/.test(entry));
  if (entry === undefined) throw new Error("piBundle loads no claude-subscription extension");
  return `--extension ${realpathSync(join(root, entry))}`;
}

/** @param {string[]} args */
function main(args) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const path = join(root, "package.json");
  const [mode, ...rest] = args;
  if (rest.length > 0 || ![undefined, "--check", "--t3-launch-args"].includes(mode)) {
    console.error("Usage: node scripts/root-package.mjs [--check | --t3-launch-args]");
    return 2;
  }
  if (mode === "--t3-launch-args") {
    console.log(t3LaunchArgs(root));
    return 0;
  }
  const manifest = readJson(path);
  const expected = rootManifest(root);
  if (mode === undefined) {
    writeFileSync(path, `${JSON.stringify({ ...manifest, pi: expected }, null, 2)}\n`);
    console.log(`Wrote package.json pi from ${manifest.piBundle.length} piBundle members.`);
    return 0;
  }
  if (JSON.stringify(manifest.pi) === JSON.stringify(expected)) {
    console.log("package.json pi matches piBundle.");
    return 0;
  }
  console.error("package.json pi does not match piBundle. Run node scripts/root-package.mjs and commit the result.");
  console.error(`Current:\n${JSON.stringify(manifest.pi ?? null, null, 2)}\nExpected:\n${JSON.stringify(expected, null, 2)}`);
  return 1;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`root-package: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
