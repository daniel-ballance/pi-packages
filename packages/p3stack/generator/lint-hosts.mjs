#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hostMap = "skills/poteto-mode/references/host-capabilities.md";
const tokens = ["mcp__t3", "delegate_task", "task_status", "schedule_task", "watch_pull_request", "t3_thread_read"];

export function lintHosts(root, paths = [""]) {
  const problems = [];
  const visit = path => {
    const absolute = join(root, path);
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(path, entry));
      return;
    }
    const output = path.split("\\").join("/");
    if (output === hostMap) return;
    readFileSync(absolute, "utf8").split("\n").forEach((line, index) => {
      for (const token of tokens) if (line.includes(token)) problems.push(`${output}:${index + 1}: ${token}`);
    });
  };
  for (const path of paths) visit(path);
  return problems;
}

function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== "--root" || !args[1] || args[1].startsWith("--"))) {
    console.error("Usage: node generator/lint-hosts.mjs [--root <emitted-directory>]");
    return 2;
  }
  try {
    const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
    const root = args.length ? resolve(args[1]) : packageDir;
    const manifest = args.length ? undefined : JSON.parse(readFileSync(join(packageDir, "rules/manifest.json"), "utf8"));
    const paths = manifest ? [...new Set(manifest.sources.flatMap(source => source.map.map(({ to }) => to.split("/")[0])))].sort() : undefined;
    const problems = lintHosts(root, paths);
    if (problems.length) throw new Error(`Host lint failed. Keep tool names in the host map.\n${problems.join("\n")}`);
    console.log("Host lint passed.");
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
