#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
  const reviewed = pin.reviewed;
  if (!reviewed || typeof reviewed.release !== "string" || !reviewed.release || typeof reviewed.commit !== "string" || !/^[a-f0-9]{40}$/.test(reviewed.commit)) {
    throw new Error("Invalid rules/t3-pin.json reviewed. Expected a release string and a 40-hex commit.");
  }
  if (!Array.isArray(pin.watch) || !pin.watch.length) throw new Error("Invalid rules/t3-pin.json watch. Expected a non-empty list.");
  const paths = new Set();
  for (const entry of pin.watch) {
    if (!entry || typeof entry.path !== "string" || !entry.path || paths.has(entry.path) || typeof entry.contract !== "string" || !entry.contract ||
        !Array.isArray(entry.dependents) || !entry.dependents.length || entry.dependents.some(dep => typeof dep !== "string" || !dep)) {
      throw new Error("Invalid rules/t3-pin.json watch. Expected unique paths, a non-empty contract, and a non-empty dependents list.");
    }
    paths.add(entry.path);
  }
}

function git(checkout, args) {
  const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status !== 0) return { ok: false, message: (result.stderr || result.stdout || "git failed").trimEnd() };
  return { ok: true, stdout: result.stdout ?? "" };
}

function sourceReport(pin, checkout, ref) {
  for (const object of [ref, pin.reviewed.commit]) {
    const present = git(checkout, ["cat-file", "-e", object]);
    if (!present.ok) {
      console.error(present.message);
      return 1;
    }
  }
  const missing = pin.watch.filter(entry => !git(checkout, ["cat-file", "-e", `${ref}:${entry.path}`]).ok).map(entry => entry.path);
  if (missing.length) {
    for (const path of missing) console.error(`watched path missing at ${ref}: ${path}`);
    return 1;
  }
  const diff = git(checkout, ["diff", "--name-only", pin.reviewed.commit, ref, "--", ...pin.watch.map(entry => entry.path)]);
  if (!diff.ok) {
    console.error(diff.message);
    return 1;
  }
  const changedNames = new Set(diff.stdout.split("\n").filter(Boolean));
  const changed = pin.watch.filter(entry => changedNames.has(entry.path));
  if (changed.length) console.log(changed.map(entry => [entry.path, entry.contract, ...entry.dependents].join("\n")).join("\n\n"));
  const release = pin.reviewed.release;
  console.log(changed.length
    ? `${changed.length} of ${pin.watch.length} watched T3 files changed since ${release}; review each contract above.`
    : `No watched T3 file changed since ${release}.`);
  return 0;
}

function assertDependents(pin) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const missing = [...new Set(pin.watch.flatMap(entry => entry.dependents))].filter(path => !existsSync(join(repoRoot, path)));
  if (missing.length) throw new Error(missing.map(path => `dependents path does not exist: ${path}`).join("\n"));
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
  const usage = "Usage: node generator/check-t3-pin.mjs [--installed [--state <file>] [--bridge <file>] | --doctor <file> | --source <checkout> [--ref <ref>]]";
  const options = new Map();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = flag === "--installed" ? true : args[++index];
    if (!["--installed", "--state", "--bridge", "--doctor", "--source", "--ref"].includes(flag) || options.has(flag) || !value || (typeof value === "string" && value.startsWith("--"))) {
      console.error(usage);
      return 2;
    }
    options.set(flag, value);
  }
  if ((options.has("--doctor") && options.size > 1) || ((options.has("--state") || options.has("--bridge")) && !options.has("--installed")) ||
      (options.has("--ref") && !options.has("--source")) || (options.has("--source") && (options.has("--installed") || options.has("--doctor") || options.has("--state") || options.has("--bridge")))) {
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
    } else if (options.has("--source")) {
      return sourceReport(pin, options.get("--source"), options.get("--ref") ?? "HEAD");
    } else {
      assertDependents(pin);
      console.log("T3 static contract matches rules/t3-pin.json and the host map.");
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
