#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const json = path => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${path} could not be read, ${error.message}`); }
};

function doctorProblems(dump, pin, hostMap) {
  if (!Array.isArray(dump?.tools) || dump.tools.some(tool => typeof tool?.name !== "string" || typeof tool.exposure !== "string") || !dump.extension || !Array.isArray(dump.problems)) {
    throw new Error("Invalid doctor dump. Expected tools, extension, and problems from /p3stack doctor.");
  }
  const prefix = "mcp__t3-code__";
  const expected = new Set(pin.directTools.map(name => prefix + name));
  const direct = new Set(dump.tools.filter(tool => tool.exposure === "direct").map(tool => tool.name));
  const available = new Set(dump.tools.map(tool => tool.name));
  const documented = new Set([...hostMap.matchAll(/mcp__t3-code__[a-z][a-z0-9_]*\b/g)].map(match => match[0]));
  const problems = dump.problems.map(problem => `doctor reported ${problem}`);
  for (const name of expected) {
    if (!documented.has(name)) problems.push(`host map is missing pinned direct tool ${name}`);
    if (!direct.has(name)) problems.push(`doctor directTools missing ${name}`);
  }
  for (const name of direct) if (!expected.has(name)) problems.push(`doctor directTools added ${name}`);
  for (const name of documented) if (!available.has(name)) problems.push(`doctor tools missing host map tool ${name}`);
  if (dump.extension.sha256 !== pin.bridgeSha256) problems.push(`doctor bridge SHA-256 is ${dump.extension.sha256}, expected ${pin.bridgeSha256}`);
  return problems;
}

function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--state", "--bridge", "--doctor"].includes(flag) || options.has(flag) || !value || value.startsWith("--")) {
      console.error("Usage: node generator/check-t3-pin.mjs [--state <file>] [--bridge <file>] | --doctor <file>");
      return 2;
    }
    options.set(flag, value);
  }
  if (options.has("--doctor") && options.size > 1) {
    console.error("Usage: node generator/check-t3-pin.mjs --doctor <file>");
    return 2;
  }
  try {
    const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
    const pin = json(join(packageDir, "rules/t3-pin.json"));
    if (options.has("--doctor")) {
      const dump = json(options.get("--doctor"));
      const hostMap = readFileSync(join(packageDir, "extra/skills/poteto-mode/references/host-capabilities.md"), "utf8");
      const problems = doctorProblems(dump, pin, hostMap);
      if (problems.length) throw new Error(problems.join("\n"));
      console.log("T3 doctor dump matches the host map and rules/t3-pin.json");
      return 0;
    }
    const t3 = join(homedir(), ".t3");
    if (!options.size && !existsSync(t3)) {
      console.log("Skipping T3 pin check because ~/.t3 is absent.");
      return 0;
    }
    const state = json(options.get("--state") ?? join(t3, "runtime/service-state.json"));
    const bridge = options.get("--bridge") ?? join(t3, "caches/pi-t3-mcp-extension.ts");
    const sha256 = createHash("sha256").update(readFileSync(bridge)).digest("hex");
    const problems = [];
    if (state?.activeVersion !== pin.version) problems.push(`activeVersion is ${state?.activeVersion}, expected ${pin.version}`);
    if (sha256 !== pin.bridgeSha256) problems.push(`bridge SHA-256 is ${sha256}, expected ${pin.bridgeSha256}`);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(`T3 ${pin.version} matches rules/t3-pin.json`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
