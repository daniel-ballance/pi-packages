#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{ readonly name: string, readonly dir: string }} Workspace */

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
