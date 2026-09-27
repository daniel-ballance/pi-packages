#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

function isConfigurationJson(file) {
  const name = basename(file);
  return (
    name === "package.json" ||
    name === "package-lock.json" ||
    name === "tsconfig.json" ||
    name === ".prettierrc.json" ||
    file === ".pi/settings.json" ||
    file === ".pi/subagents.json" ||
    (file.startsWith(".github/") && file.endsWith(".json"))
  );
}

// Unstaged deletions remain in git ls-files; validate the working tree, not
// removed configuration (notably an intentionally deleted project override).
const files = new Set(tracked.filter(file => isConfigurationJson(file) && existsSync(resolve(root, file))));
// Include a newly created root manifest before it is staged. Example, proposal,
// and other fixture JSON remains data rather than repository configuration.
if (existsSync(resolve(root, "package.json"))) files.add("package.json");
for (const file of [".pi/settings.json", ".pi/subagents.json"]) {
  if (existsSync(resolve(root, file))) files.add(file);
}

let failures = 0;
for (const file of [...files].sort()) {
  const path = resolve(root, file);
  if (!isAbsolute(path) || relative(root, path).startsWith("..")) {
    console.error(`JSON config check: refusing path outside repository: ${file}`);
    failures++;
    continue;
  }
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`JSON config check: invalid ${file}`);
    console.error(error instanceof Error ? error.message : String(error));
    failures++;
  }
}

if (failures) process.exitCode = 1;
else console.log(`JSON config check: ${files.size} configuration file(s) valid`);
