#!/usr/bin/env node

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LintSkillConfigError,
  exceptionsForSkill,
  readLintSkillConfig,
} from "./lint-skill-config.mjs";

const USAGE = `Usage: lint-skill <directory>... [options]

Options:
  --resource-root <directory>  Allow linked resources under this root
  --config <file>              Read exact per-skill exceptions from JSON
  --format text|json           Select the output format (default: text)
  --strict                     Treat warnings as failures
  --help                       Show this help

Exit codes:
  0  complete and clean (warnings allowed unless --strict)
  1  lint errors, or warnings with --strict
  2  invalid invocation/configuration or incomplete analysis

Example:
  lint-skill ./skills/example --format json

Each directory must be supplied explicitly and contain an exact SKILL.md file.`;

function jsonWasRequested(format) {
  return format === "json";
}

function parseArgs(argv) {
  const errors = [];
  const directories = [];
  let format = "text";
  let resourceRoot;
  let configFile;
  let strict = false;
  let help = false;
  let positionalOnly = false;

  const takeValue = (index, option) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("-")) {
      errors.push(`${option} requires a value`);
      return [index, undefined];
    }
    return [index + 1, argv[index + 1]];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (positionalOnly) {
      directories.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (argument === "--format" || argument === "--resource-root" || argument === "--config") {
      const [nextIndex, value] = takeValue(index, argument);
      index = nextIndex;
      if (value === undefined) continue;
      if (value === "") {
        errors.push(`${argument} requires a value`);
        continue;
      }
      if (argument === "--format") {
        if (value !== "text" && value !== "json") {
          errors.push(`--format must be text or json, got ${JSON.stringify(value)}`);
        } else {
          format = value;
        }
      } else if (argument === "--resource-root") {
        resourceRoot = value;
      } else {
        configFile = value;
      }
      continue;
    }
    if (argument.startsWith("--format=")) {
      const value = argument.slice("--format=".length);
      if (value !== "text" && value !== "json") {
        errors.push(`--format must be text or json, got ${JSON.stringify(value)}`);
      } else {
        format = value;
      }
      continue;
    }
    if (argument.startsWith("--resource-root=")) {
      resourceRoot = argument.slice("--resource-root=".length);
      if (!resourceRoot) errors.push("--resource-root requires a value");
      continue;
    }
    if (argument.startsWith("--config=")) {
      configFile = argument.slice("--config=".length);
      if (!configFile) errors.push("--config requires a value");
      continue;
    }
    if (argument.startsWith("-")) {
      errors.push(`unknown option: ${argument}`);
      continue;
    }
    directories.push(argument);
  }

  const uniqueDirectories = [];
  const seenDirectories = new Set();
  for (const directory of directories) {
    const absolute = normalize(resolve(process.cwd(), directory));
    if (!seenDirectories.has(absolute)) {
      seenDirectories.add(absolute);
      uniqueDirectories.push(absolute);
    }
  }
  if (!help && uniqueDirectories.length === 0) {
    errors.push("at least one skill directory is required");
  }

  return {
    configFile,
    directories: uniqueDirectories,
    errors,
    format,
    help,
    resourceRoot: resourceRoot === undefined ? undefined : normalize(resolve(process.cwd(), resourceRoot)),
    strict,
  };
}

function isWithin(root, child) {
  const distance = relative(root, child);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !distance.startsWith("..\\") && !isAbsolute(distance));
}

function inspectDirectory(directory, label) {
  try {
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      return { error: `${label} is not a directory: ${directory}` };
    }
    accessSync(directory, constants.R_OK | constants.X_OK);
    return { lexical: directory, resolved: realpathSync(directory) };
  } catch (error) {
    return { error: `unable to read ${label} ${directory}: ${error.message}` };
  }
}

function emptyEnvelope(errors = [], results = []) {
  return {
    schemaVersion: 1,
    complete: errors.length === 0 && results.every((result) => result.complete === true),
    results,
    counts: countFindings(results),
    errors,
  };
}

function countFindings(results) {
  const counts = { error: 0, warning: 0 };
  for (const result of results) {
    for (const finding of result.findings ?? []) {
      if (finding.severity === "error") counts.error += 1;
      if (finding.severity === "warning") counts.warning += 1;
    }
  }
  return counts;
}

function compareValues(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function sortFindings(findings) {
  return [...findings].sort((left, right) =>
    compareValues(left.path, right.path) ||
    (Number(left.line ?? 0) - Number(right.line ?? 0)) ||
    (Number(left.column ?? 0) - Number(right.column ?? 0)) ||
    compareValues(left.ruleId, right.ruleId) ||
    compareValues(left.message, right.message),
  );
}

function sortDependencies(dependencies) {
  return [...dependencies].sort((left, right) =>
    compareValues(left.from, right.from) ||
    compareValues(left.target, right.target) ||
    compareValues(left.kind, right.kind) ||
    compareValues(left.status, right.status),
  );
}

function normalizeReport(report, directory) {
  return {
    schemaVersion: 1,
    skill: report?.skill ?? directory,
    name: report?.name ?? null,
    complete: report?.complete === true,
    findings: sortFindings(Array.isArray(report?.findings) ? report.findings : []),
    dependencies: sortDependencies(Array.isArray(report?.dependencies) ? report.dependencies : []),
    appliedExceptions: Array.isArray(report?.appliedExceptions) ? report.appliedExceptions : [],
  };
}

function failureReport(directory, message) {
  return normalizeReport({
    skill: directory,
    complete: false,
    findings: [{
      ruleId: "operational/failure",
      category: "operational",
      severity: "error",
      path: directory,
      message,
    }],
  }, directory);
}

function renderJson(envelope) {
  return `${JSON.stringify(envelope)}\n`;
}

function findingLocation(finding) {
  if (finding.line === undefined) return finding.path;
  return `${finding.path}:${finding.line}${finding.column === undefined ? "" : `:${finding.column}`}`;
}

function renderText(envelope) {
  const lines = [];
  for (const result of envelope.results) {
    lines.push(result.skill);
    for (const finding of result.findings) {
      let detail = `${finding.severity.toUpperCase()} ${finding.ruleId} ${findingLocation(finding)}: ${finding.message}`;
      if (finding.route !== undefined) {
        const route = Array.isArray(finding.route) ? finding.route.join(" -> ") : finding.route;
        detail += ` (route: ${route})`;
      }
      if (finding.depth !== undefined || finding.allowedDepth !== undefined) {
        detail += ` (depth: ${finding.depth ?? "?"}/${finding.allowedDepth ?? "?"})`;
      }
      lines.push(`  ${detail}`);
    }
    if (result.dependencies.length > 0) {
      lines.push("  Dependencies:");
      for (const dependency of result.dependencies) {
        lines.push(`    ${dependency.status} ${dependency.kind} ${dependency.target} (from ${dependency.from})`);
      }
    }
    if (result.appliedExceptions.length > 0) {
      lines.push("  Applied exceptions:");
      for (const exception of result.appliedExceptions) {
        const depth = exception.maxDepth === undefined ? "" : ` (max depth ${exception.maxDepth})`;
        lines.push(`    ${exception.rule} ${exception.path}: ${exception.reason}${depth}`);
      }
    }
  }
  lines.push(`Summary: ${envelope.counts.error} error(s), ${envelope.counts.warning} warning(s)`);
  if (!envelope.complete) lines.push("Status: incomplete");
  return `${lines.join("\n")}\n`;
}

function exitStatus(envelope, strict) {
  if (!envelope.complete) return 2;
  if (envelope.counts.error > 0 || (strict && envelope.counts.warning > 0)) return 1;
  return 0;
}

async function execute(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    return { status: 0, stdout: `${USAGE}\n`, stderr: "" };
  }

  if (parsed.errors.length > 0) {
    const envelope = emptyEnvelope(parsed.errors);
    if (jsonWasRequested(parsed.format)) {
      return { status: 2, stdout: renderJson(envelope), stderr: "" };
    }
    return {
      status: 2,
      stdout: "",
      stderr: `${parsed.errors.map((error) => `lint-skill: ${error}`).join("\n")}\n${USAGE}\n`,
    };
  }

  const inspectedSkills = parsed.directories.map((directory) => ({
    directory,
    inspected: inspectDirectory(directory, "skill root"),
  }));
  const errors = inspectedSkills.flatMap(({ inspected }) => inspected.error ? [inspected.error] : []);

  let inspectedResourceRoot;
  if (parsed.resourceRoot !== undefined) {
    inspectedResourceRoot = inspectDirectory(parsed.resourceRoot, "resource root");
    if (inspectedResourceRoot.error) errors.push(inspectedResourceRoot.error);
  }

  if (inspectedResourceRoot && !inspectedResourceRoot.error) {
    for (const { directory, inspected } of inspectedSkills) {
      if (inspected.error) continue;
      if (!isWithin(inspectedResourceRoot.lexical, inspected.lexical)) {
        errors.push(`resource root does not contain skill root: ${directory}`);
      } else if (!isWithin(inspectedResourceRoot.resolved, inspected.resolved)) {
        errors.push(`resource root does not contain resolved skill root: ${directory}`);
      }
    }
  }

  let config;
  if (parsed.configFile !== undefined) {
    try {
      config = readLintSkillConfig(parsed.configFile);
    } catch (error) {
      const configErrors = error instanceof LintSkillConfigError
        ? error.messages
        : [`unable to load config: ${error.message}`];
      errors.push(...configErrors);
    }
  }

  if (errors.length > 0) {
    const envelope = emptyEnvelope(errors);
    if (jsonWasRequested(parsed.format)) {
      return { status: 2, stdout: renderJson(envelope), stderr: "" };
    }
    return {
      status: 2,
      stdout: "",
      stderr: `${errors.map((error) => `lint-skill: ${error}`).join("\n")}\n`,
    };
  }

  let lintSkill;
  try {
    const core = await import("../lib/lint-skill.mjs");
    lintSkill = core.lintSkill;
    if (typeof lintSkill !== "function") throw new Error("../lib/lint-skill.mjs does not export lintSkill");
  } catch (error) {
    const envelope = emptyEnvelope([`unable to load linter: ${error.message}`]);
    if (jsonWasRequested(parsed.format)) {
      return { status: 2, stdout: renderJson(envelope), stderr: "" };
    }
    return { status: 2, stdout: "", stderr: `lint-skill: ${envelope.errors[0]}\n` };
  }

  const results = [];
  for (const { directory } of inspectedSkills) {
    const exceptions = config ? exceptionsForSkill(config, directory) : [];
    const options = {
      ...(parsed.resourceRoot === undefined ? {} : { resourceRoot: parsed.resourceRoot }),
      ...(exceptions.length === 0 ? {} : { exceptions }),
    };
    try {
      results.push(normalizeReport(lintSkill(directory, options), directory));
    } catch (error) {
      results.push(failureReport(directory, `linter failed: ${error.message}`));
    }
  }

  const envelope = emptyEnvelope([], results);
  const status = exitStatus(envelope, parsed.strict);
  if (parsed.format === "json") {
    return { status, stdout: renderJson(envelope), stderr: "" };
  }
  return { status, stdout: renderText(envelope), stderr: "" };
}

if (process.argv[1]) {
  let invokedPath;
  try {
    invokedPath = realpathSync(resolve(process.argv[1]));
  } catch {
    invokedPath = null;
  }
  const sourcePath = realpathSync(fileURLToPath(import.meta.url));
  if (invokedPath === sourcePath) {
    const result = await execute(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status;
  }
}
