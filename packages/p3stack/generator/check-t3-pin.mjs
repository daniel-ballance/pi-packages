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
const documentedTools = hostMap => new Set([...hostMap.matchAll(/`(mcp__t3-code__[a-z][a-z0-9_]*)`/g)].map(match => match[1]));
const requiredTools = pin => pin.directTools.map(name => "mcp__t3-code__" + name);

function checkContract(pin, hostMap) {
  if (typeof pin?.version !== "string" || !pin.version || !/^[a-f0-9]{64}$/.test(pin.bridgeSha256 ?? "") ||
      !Array.isArray(pin.statePaths) || !pin.statePaths.length || pin.statePaths.some(layout => typeof layout?.path !== "string" || !layout.path || typeof layout.versionField !== "string" || !layout.versionField) ||
      !Array.isArray(pin.directTools) || !pin.directTools.length || pin.directTools.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name)) || new Set(pin.directTools).size !== pin.directTools.length) {
    throw new Error("Invalid rules/t3-pin.json. Expected provenance version and bridgeSha256, statePaths, and unique directTools.");
  }
  if (!pin.beforeAgentStartReturn || Object.keys(pin.beforeAgentStartReturn).length !== 1 || pin.beforeAgentStartReturn.systemPrompt !== "string") {
    throw new Error("Unsupported beforeAgentStartReturn. Expected { systemPrompt: \"string\" }.");
  }
  const documented = documentedTools(hostMap);
  const missing = requiredTools(pin).filter(name => !documented.has(name));
  if (missing.length) throw new Error(missing.map(name => `host map is missing required direct tool ${name}`).join("\n"));
}

function doctorProblems(dump, pin, hostMap) {
  if (!Array.isArray(dump?.tools) || dump.tools.some(tool => typeof tool?.name !== "string" || !["direct", "deferred"].includes(tool.exposure)) ||
      typeof dump.extension?.path !== "string" || !/^[a-f0-9]{64}$/.test(dump.extension.sha256 ?? "") || !Array.isArray(dump.problems) || dump.problems.some(problem => typeof problem !== "string")) {
    throw new Error("Invalid doctor dump. Expected tools, extension, and problems from /p3stack doctor.");
  }
  const direct = new Set(dump.tools.filter(tool => tool.exposure === "direct").map(tool => tool.name));
  const available = new Set(dump.tools.map(tool => tool.name));
  const problems = dump.problems.map(problem => `doctor reported ${problem}`);
  for (const name of requiredTools(pin)) if (!direct.has(name)) problems.push(`doctor directTools missing ${name}`);
  for (const name of documentedTools(hostMap)) if (!available.has(name)) problems.push(`doctor tools missing host map tool ${name}`);
  return problems;
}

function installedDiagnostics(pin, options) {
  const t3 = join(homedir(), ".t3");
  const layouts = pin.statePaths.map(layout => ({ ...layout, path: join(t3, layout.path) }));
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
  const usage = "Usage: node generator/check-t3-pin.mjs [--installed [--state <file>] [--bridge <file>] | --doctor <file>]";
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
    const pin = json(join(packageDir, "rules/t3-pin.json"));
    const hostMap = readFileSync(join(packageDir, "extra/skills/poteto-mode/references/host-capabilities.md"), "utf8");
    checkContract(pin, hostMap);
    if (options.has("--doctor")) {
      const problems = doctorProblems(json(options.get("--doctor")), pin, hostMap);
      if (problems.length) throw new Error(problems.join("\n"));
      console.log("T3 doctor capabilities match rules/t3-pin.json and the host map; behavioral verification is still required.");
    } else if (options.has("--installed")) {
      installedDiagnostics(pin, options);
    } else {
      console.log("T3 static contract matches rules/t3-pin.json and the host map.");
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
