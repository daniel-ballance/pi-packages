#!/usr/bin/env node
// p3stack's own files name capabilities and roles, never a model or a harness
// tool: model slugs live in the role defaults, tool names in the host map.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERNS = [
  ["model slug", /\b(?:claude-(?:opus|sonnet|haiku)|grok-\d|gpt-\d|gemini-\d|o\d-mini)[\w-]*(?:\.\d[\w-]*)*/i],
  ["harness tool", /\b(?:subagent_[a-z_]+|mcp__t3-code__\w+|delegate_task|task_status|AskUserQuestion)\b|\bTask tool\b/],
];

export function lintAuthored(root) {
  const problems = [];
  const visit = dir => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { visit(path); continue; }
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        for (const [kind, pattern] of PATTERNS) {
          const match = line.match(pattern);
          if (match) problems.push(`${relative(root, path)}:${index + 1}: ${kind} ${match[0]}`);
        }
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
    console.error(`Authored lint failed. Name a role (resolved by p3stack_roles) or a capability (mapped in the host map), not a model or a tool.\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("Authored lint passed.");
}
