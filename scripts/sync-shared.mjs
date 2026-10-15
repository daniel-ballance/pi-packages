#!/usr/bin/env node
// Copy shared modules into the packages that use them.
//
//   node scripts/sync-shared.mjs          write every copy listed in shared/copies.json
//   node scripts/sync-shared.mjs --check  fail if any copy differs; write nothing
//
// Pi loads each package from its own module root, so a package cannot import
// from shared/ at runtime. Never edit a copy; edit shared/<file> and re-run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("Usage: node scripts/sync-shared.mjs [--check]");
  process.exit(2);
}
const check = args[0] === "--check";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const copies = JSON.parse(readFileSync(join(root, "shared/copies.json"), "utf8"));

const problems = [];
for (const [file, targets] of Object.entries(copies)) {
  const source = `shared/${file}`;
  if (!existsSync(join(root, source))) {
    problems.push(`${source}: listed in shared/copies.json but missing`);
    continue;
  }
  const expected = `// Generated from ${source} by scripts/sync-shared.mjs. Do not edit.\n`
    + readFileSync(join(root, source), "utf8");
  for (const target of targets) {
    const path = join(root, target);
    const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (actual === expected) continue;
    if (check) {
      problems.push(`${target}: ${actual === undefined ? "missing" : "differs from"} ${source}`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, expected);
    }
  }
}

if (problems.length > 0) {
  console.error(`Shared copies out of date. Run node scripts/sync-shared.mjs.\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
