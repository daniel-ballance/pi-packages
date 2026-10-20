#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const dirs = [];
  let json = false;
  let check = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      dirs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`unknown flag ${arg}`);
      console.error("usage: node scripts/skill-report.mjs [--json] [--check] [dir ...]");
      process.exit(2);
    }
    dirs.push(arg);
  }
  if (dirs.length === 0) dirs.push(process.cwd());
  return { json, check, dirs: dirs.map(resolveDir) };
}

function resolveDir(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return resolve(input);
}

function findSdkIndex() {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return undefined;
  const names = readdirSync(packagesDir).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const candidate = join(
      packagesDir,
      name,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    );
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readPiVersion() {
  const result = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) {
    if (result.error.code === "ENOENT") return { missing: true };
    return { error: result.error.message };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { error: detail };
  }
  const line = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return { version: line.split(/\s+/).at(-1) ?? line };
}

function compareLoaderVersion(sdkIndex) {
  const packageJson = join(dirname(sdkIndex), "..", "package.json");
  const sdkVersion = JSON.parse(readFileSync(packageJson, "utf8")).version;
  const pi = readPiVersion();
  if (pi.missing) {
    console.error("pi is not on PATH.");
    return;
  }
  if (pi.error) {
    console.error(`pi --version failed (${pi.error}).`);
    return;
  }
  if (pi.version !== sdkVersion) {
    console.error(
      `warning: loader version ${sdkVersion} does not match pi --version ${pi.version}. The report describes a different loader than the one you run.`,
    );
  }
}

function packageLabel(sourceInfo) {
  if (sourceInfo.origin === "package") {
    const name = basename(sourceInfo.baseDir || sourceInfo.source || "package");
    if (sourceInfo.scope === "project") return `${name} (project settings)`;
    return name;
  }
  if (sourceInfo.origin === "top-level") return `${sourceInfo.scope} skills dir`;
  return `${sourceInfo.scope} ${sourceInfo.origin}`;
}

function isUnder(root, filePath) {
  if (!root) return false;
  const rel = relative(root, filePath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function labelForPath(filePath, skills) {
  const exact = skills.find((skill) => skill.filePath === filePath);
  if (exact) return packageLabel(exact.sourceInfo);
  const matches = skills
    .filter((skill) => isUnder(skill.sourceInfo.baseDir, filePath))
    .sort((left, right) => (right.sourceInfo.baseDir?.length ?? 0) - (left.sourceInfo.baseDir?.length ?? 0));
  if (matches.length > 0) return packageLabel(matches[0].sourceInfo);
  const parts = filePath.split(/[/\\]/);
  const packageIndex = parts.lastIndexOf("packages");
  if (packageIndex >= 0 && parts[packageIndex + 1]) return parts[packageIndex + 1];
  if (filePath.includes(`${sep}.pi${sep}agent${sep}skills${sep}`)) return "user skills dir";
  if (filePath.includes(`${sep}.pi${sep}skills${sep}`)) return "project skills dir";
  return basename(dirname(filePath));
}

function isInsidePistackPackage(filePath) {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  return parts.some((part, index) => part === "packages" && parts[index + 1] === "p3stack");
}

function isPocockPackage(skill) {
  return skill.sourceInfo.origin === "package" && basename(skill.sourceInfo.baseDir ?? "") === "pi-pocock-skills";
}

function readSkillDirNames(skillsDir) {
  if (!skillsDir || !existsSync(skillsDir)) return [];
  return readdirSync(skillsDir).filter((name) => {
    try {
      return statSync(join(skillsDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function pistackSkillNames(skills, scannedDir) {
  const loaded = skills.find(
    (skill) => skill.sourceInfo.origin === "package" && basename(skill.sourceInfo.baseDir ?? "") === "p3stack",
  );
  const candidates = [
    loaded?.sourceInfo.baseDir ? join(loaded.sourceInfo.baseDir, "skills") : undefined,
    join(scannedDir, "packages", "p3stack", "skills"),
    join(repoRoot, "packages", "p3stack", "skills"),
  ];
  for (const dir of candidates) {
    const names = readSkillDirNames(dir);
    if (names.length > 0) return new Set(names);
  }
  return new Set();
}

function violations(scannedDir, skills, diagnostics) {
  const failures = [];
  for (const diagnostic of diagnostics) {
    const collision = diagnostic.collision;
    if (diagnostic.type !== "collision" || !collision) continue;
    if (!isInsidePistackPackage(collision.loserPath)) continue;
    const winner = labelForPath(collision.winnerPath, skills);
    failures.push(
      `collision ${collision.name} loser is inside packages/p3stack at ${collision.loserPath}, winner is ${winner}`,
    );
  }
  const names = pistackSkillNames(skills, scannedDir);
  for (const skill of skills) {
    if (!isPocockPackage(skill) || !names.has(skill.name)) continue;
    failures.push(`loaded pi-pocock-skills skill ${skill.name} matches packages/p3stack/skills/${skill.name}`);
  }
  return failures;
}

function skillView(skill) {
  return {
    name: skill.name,
    visible: !skill.disableModelInvocation,
    package: packageLabel(skill.sourceInfo),
    scope: skill.sourceInfo.scope,
    path: skill.filePath,
  };
}

function diagnosticView(diagnostic, skills) {
  const view = {
    type: diagnostic.type,
    message: diagnostic.message,
  };
  if (diagnostic.path) view.path = diagnostic.path;
  if (diagnostic.collision) {
    view.collision = {
      resourceType: diagnostic.collision.resourceType,
      name: diagnostic.collision.name,
      winnerPath: diagnostic.collision.winnerPath,
      loserPath: diagnostic.collision.loserPath,
      winner: labelForPath(diagnostic.collision.winnerPath, skills),
      loser: labelForPath(diagnostic.collision.loserPath, skills),
    };
  }
  return view;
}

async function loadDir(sdk, dir) {
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: sdk.getAgentDir() });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  const sorted = [...skills].sort((left, right) => left.name.localeCompare(right.name));
  return { skills: sorted, diagnostics };
}

function printText(dir, skills, diagnostics) {
  console.log(dir);
  for (const skill of skills) {
    const visibility = skill.disableModelInvocation ? "hidden" : "model";
    console.log(`${skill.name} ${visibility} ${packageLabel(skill.sourceInfo)}`);
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === "collision" && diagnostic.collision) {
      const winner = labelForPath(diagnostic.collision.winnerPath, skills);
      const loser = labelForPath(diagnostic.collision.loserPath, skills);
      console.log(`collision: ${diagnostic.collision.name} winner=${winner} loser=${loser}`);
      continue;
    }
    const where = diagnostic.path ? ` ${diagnostic.path}` : "";
    console.log(`${diagnostic.type}: ${diagnostic.message}${where}`);
  }
}

function printCheckLines(dir, failures, toStderr) {
  const write = toStderr ? console.error : console.log;
  if (failures.length === 0) {
    write(`OK ${dir}`);
    return;
  }
  for (const reason of failures) write(`FAIL ${dir}: ${reason}`);
}

async function main() {
  const { json, check, dirs } = parseArgs(process.argv.slice(2));
  const sdkIndex = findSdkIndex();
  if (!sdkIndex) {
    console.error("no @earendil-works/pi-coding-agent install under packages/*/node_modules");
    process.exit(1);
  }
  compareLoaderVersion(sdkIndex);
  const sdk = await import(pathToFileURL(sdkIndex).href);
  const reports = {};
  let loadFailed = false;
  let checkFailed = false;
  for (const dir of dirs) {
    let loaded;
    try {
      loaded = await loadDir(sdk, dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(check ? `FAIL ${dir}: ${message}` : `${dir}: ${message}`);
      loadFailed = true;
      continue;
    }
    const failures = violations(dir, loaded.skills, loaded.diagnostics);
    if (failures.length > 0) checkFailed = true;
    if (json) {
      reports[dir] = {
        skills: loaded.skills.map(skillView),
        diagnostics: loaded.diagnostics.map((diagnostic) => diagnosticView(diagnostic, loaded.skills)),
      };
    } else {
      printText(dir, loaded.skills, loaded.diagnostics);
    }
    if (check) printCheckLines(dir, failures, json);
  }
  if (json) console.log(`${JSON.stringify(reports, null, 2)}\n`);
  if (loadFailed || (check && checkFailed)) process.exit(1);
}

await main();
