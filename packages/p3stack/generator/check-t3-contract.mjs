#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostToolNames } from "./lint-hosts.mjs";

const json = path => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${path} could not be read, ${error.message}`); }
};
const qualify = name => "mcp__t3-code__" + name;
const groups = ["directTools", "requiredTools", "optionalTools"];

function readContract(packageDir) {
  const contract = json(join(packageDir, "rules/t3-contract.json"));
  const classified = new Set();
  for (const group of groups) {
    const names = contract?.[group];
    if (!Array.isArray(names) || (group === "directTools" && !names.length)) {
      throw new Error(`Invalid rules/t3-contract.json: expected ${group} to list bare T3 operation names.`);
    }
    for (const name of names) {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name) || classified.has(name)) {
        throw new Error(`Invalid rules/t3-contract.json: invalid or duplicate operation in ${group}: ${JSON.stringify(name)}`);
      }
      classified.add(name);
    }
  }
  return contract;
}

function checkHostMap(contract, hostMap) {
  const documented = new Set(hostToolNames(hostMap).filter(name => name.startsWith("mcp__t3-code__")));
  const declared = new Set(groups.flatMap(group => contract[group].map(qualify)));
  const problems = [];
  for (const name of declared) if (!documented.has(name)) problems.push(`host map is missing ${name}`);
  for (const name of documented) if (!declared.has(name)) problems.push(`unclassified host map operation: ${name}`);
  if (problems.length) throw new Error(problems.join("\n"));
}

function doctorProblems(dump, { directTools, requiredTools }) {
  if (!Array.isArray(dump?.tools) || dump.tools.some(tool => typeof tool?.name !== "string" || !["direct", "model-only", "codemode", "deferred", "hidden"].includes(tool.exposure)) ||
      !Array.isArray(dump.problems) || dump.problems.some(problem => typeof problem !== "string")) {
    throw new Error("Invalid doctor dump. Expected tools and problems from /p3stack doctor.");
  }
  const direct = new Set(dump.tools.filter(tool => tool.exposure === "direct").map(tool => tool.name));
  const available = new Set(dump.tools.filter(tool => tool.exposure !== "hidden").map(tool => tool.name));
  const problems = dump.problems.map(problem => `doctor reported ${problem}`);
  for (const name of directTools.map(qualify)) if (!direct.has(name)) problems.push(`doctor missing required direct tool ${name}`);
  for (const name of requiredTools.map(qualify)) if (!available.has(name)) problems.push(`doctor missing required tool ${name}`);
  return problems;
}

function installedDiagnostics(options) {
  const t3 = join(homedir(), ".t3");
  const layouts = [
    { path: join(t3, "runtime/service-state.json"), versionField: "activeVersion" },
    { path: join(t3, "userdata/server-runtime.json"), versionField: "serverVersion" },
  ];
  const layout = options.has("--state")
    ? { path: options.get("--state") }
    : layouts.find(layout => existsSync(layout.path));
  if (!layout) throw new Error(`No installed T3 state file exists at ${layouts.map(layout => layout.path).join(" or ")}.`);
  const state = json(layout.path);
  const activeVersion = layout.versionField ? state?.[layout.versionField] : state?.activeVersion ?? state?.serverVersion;
  if (typeof activeVersion !== "string" || !activeVersion) throw new Error(`Missing activeVersion or serverVersion in ${layout.path}`);
  const bridge = options.get("--bridge") ?? join(t3, "caches/pi-t3-mcp-extension.ts");
  const sha256 = createHash("sha256").update(readFileSync(bridge)).digest("hex");
  console.log(`Installed T3 diagnostics only; compatibility is not verified.\nactiveVersion: ${activeVersion}\nstate read from ${layout.path}\nbridge SHA-256: ${sha256}\nbridge read from ${bridge}`);
}

function main(args) {
  const usage = "Usage: node generator/check-t3-contract.mjs [--installed [--state <file>] [--bridge <file>] | --doctor <file>]";
  const options = new Map();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = flag === "--installed" ? true : args[++index];
    if (!["--installed", "--state", "--bridge", "--doctor"].includes(flag) || options.has(flag) || !value || (typeof value === "string" && value.startsWith("--"))) {
      console.error(usage);
      return 2;
    }
    options.set(flag, value);
  }
  if ((options.has("--doctor") && options.size > 1) || ((options.has("--state") || options.has("--bridge")) && !options.has("--installed"))) {
    console.error(usage);
    return 2;
  }
  try {
    const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
    if (options.has("--installed")) {
      installedDiagnostics(options);
      return 0;
    }
    const contract = readContract(packageDir);
    if (options.has("--doctor")) {
      const problems = doctorProblems(json(options.get("--doctor")), contract);
      if (problems.length) throw new Error(problems.join("\n"));
      console.log("T3 doctor inventory has the required tools and exposures. Live behavior was not tested.");
    } else {
      checkHostMap(contract, readFileSync(join(packageDir, "extra/skills/poteto-mode/references/host-t3.md"), "utf8"));
      console.log("T3 host map matches the declared operations (static check only).");
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
