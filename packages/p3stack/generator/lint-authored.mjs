#!/usr/bin/env node
// Only authored prose must name roles instead of model slugs. Host lint
// applies the tool-name check to the entire emitted tree.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modelSlug = /\b(?:claude-(?:opus|sonnet|haiku)|grok-\d|gpt-\d|gemini-\d|o\d-mini)[\w-]*(?:\.\d[\w-]*)*/i;

export function lintAuthored(root) {
  const problems = [];
  const visit = dir => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { visit(path); continue; }
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        const match = line.match(modelSlug);
        if (match) problems.push(`${relative(root, path)}:${index + 1}: model slug ${match[0]}`);
      });
    }
  };
  visit(root);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "authored");
  const problems = lintAuthored(root);
  if (problems.length) {
    console.error(`Authored lint failed. Name a role (resolved by p3stack_roles), not a model.\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("Authored lint passed.");
}
