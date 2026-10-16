#!/usr/bin/env node
// Run the collection's lint-skill CLI (from pi-pocock-skills) over every generated skill.
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skills = join(root, "skills");
const lintSkill = join(root, "../pi-pocock-skills/scripts/lint-skill.mjs");
const directories = readdirSync(skills, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(skills, entry.name, "SKILL.md")))
  .map(entry => join(skills, entry.name))
  .sort();

if (directories.length === 0) {
  console.error("No generated skills found; refusing an empty lint check.");
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [lintSkill, "--resource-root", skills, ...directories], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (result.error) console.error(result.error.message);
  // The per-skill dependency listing is long; keep findings and the summary.
  const lines = (result.stdout ?? "").split("\n").filter(line => !/^\s+(exists|Dependencies:)/.test(line));
  process.stdout.write(lines.join("\n"));
  process.exitCode = result.status ?? 2;
}
