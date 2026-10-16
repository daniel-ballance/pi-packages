import { readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve, win32 } from "node:path";

const CONFIG_KEYS = new Set(["version", "skills"]);
const SKILL_KEYS = new Set(["path", "exceptions"]);
const EXCEPTION_KEYS = new Set(["rule", "path", "reason", "maxDepth"]);
const RULES = new Set(["orphan", "depth"]);
const MAX_CONFIG_BYTES = 1024 * 1024;

export class LintSkillConfigError extends Error {
  constructor(messages) {
    const normalized = Array.isArray(messages) ? messages : [messages];
    super(normalized.join("; "));
    this.name = "LintSkillConfigError";
    this.messages = normalized;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function windowsAbsolute(value) {
  return win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function configPath(configFile) {
  return resolve(configFile ?? process.cwd());
}

function exceptionPathKey(value) {
  return value.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".").join("/");
}

function validateException(raw, skillIndex, exceptionIndex, issues) {
  const label = `skills[${skillIndex}].exceptions[${exceptionIndex}]`;
  if (!isRecord(raw)) {
    issues.push(`${label} must be an object`);
    return null;
  }

  for (const key of unknownKeys(raw, EXCEPTION_KEYS)) {
    issues.push(`${label} has unknown key ${JSON.stringify(key)}`);
  }

  const { rule, path, reason } = raw;
  if (typeof rule !== "string" || !RULES.has(rule)) {
    issues.push(`${label}.rule must be "orphan" or "depth"`);
  }
  if (typeof path !== "string" || path.length === 0) {
    issues.push(`${label}.path must be a non-empty relative file path`);
  } else if (isAbsolute(path) || windowsAbsolute(path)) {
    issues.push(`${label}.path must be relative`);
  } else if (path.split(/[\\/]/u).includes("..")) {
    issues.push(`${label}.path must not contain .. segments`);
  } else if (path.includes("\0")) {
    issues.push(`${label}.path must not contain NUL`);
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    issues.push(`${label}.reason must be a non-empty string`);
  }

  if (rule === "depth") {
    if (!Object.hasOwn(raw, "maxDepth")) {
      issues.push(`${label}.maxDepth is required for a depth exception`);
    } else if (!Number.isSafeInteger(raw.maxDepth) || raw.maxDepth < 3 || raw.maxDepth > 100) {
      issues.push(`${label}.maxDepth must be an integer from 3 to 100`);
    }
  } else if (Object.hasOwn(raw, "maxDepth")) {
    issues.push(`${label}.maxDepth is only valid for a depth exception`);
  }

  return {
    rule,
    path,
    reason,
    ...(rule === "depth" && Object.hasOwn(raw, "maxDepth") ? { maxDepth: raw.maxDepth } : {}),
  };
}

function validateLintSkillConfig(value, options = {}) {
  const filePath = configPath(options.filePath);
  const directory = resolve(filePath, "..");
  const issues = [];

  if (!isRecord(value)) {
    throw new LintSkillConfigError("config must be a JSON object");
  }
  for (const key of unknownKeys(value, CONFIG_KEYS)) {
    issues.push(`config has unknown key ${JSON.stringify(key)}`);
  }
  if (value.version !== 1) {
    issues.push("config.version must be 1");
  }
  if (!Array.isArray(value.skills)) {
    issues.push("config.skills must be an array");
  }

  const skills = [];
  const selectors = new Map();
  if (Array.isArray(value.skills)) {
    value.skills.forEach((rawSkill, skillIndex) => {
      const label = `skills[${skillIndex}]`;
      if (!isRecord(rawSkill)) {
        issues.push(`${label} must be an object`);
        return;
      }
      for (const key of unknownKeys(rawSkill, SKILL_KEYS)) {
        issues.push(`${label} has unknown key ${JSON.stringify(key)}`);
      }

      const selector = rawSkill.path;
      let resolvedSelector = null;
      if (typeof selector !== "string" || selector.length === 0 || isAbsolute(selector) || windowsAbsolute(selector)) {
        issues.push(`${label}.path must be a non-empty relative path`);
      } else if (selector.includes("\0")) {
        issues.push(`${label}.path must not contain NUL`);
      } else {
        resolvedSelector = normalize(resolve(directory, selector));
        if (selectors.has(resolvedSelector)) {
          issues.push(`${label}.path duplicates ${selectors.get(resolvedSelector)}`);
        } else {
          selectors.set(resolvedSelector, `${label}.path`);
        }
      }

      if (!Array.isArray(rawSkill.exceptions)) {
        issues.push(`${label}.exceptions must be an array`);
      }
      const exceptions = [];
      const exceptionKeys = new Map();
      if (Array.isArray(rawSkill.exceptions)) {
        rawSkill.exceptions.forEach((rawException, exceptionIndex) => {
          const exception = validateException(rawException, skillIndex, exceptionIndex, issues);
          if (!exception) return;
          if (typeof exception.rule === "string" && typeof exception.path === "string") {
            const key = `${exception.rule}\u0000${exceptionPathKey(exception.path)}`;
            if (exceptionKeys.has(key)) {
              issues.push(
                `skills[${skillIndex}].exceptions[${exceptionIndex}] duplicates ${exceptionKeys.get(key)}`,
              );
            } else {
              exceptionKeys.set(key, `skills[${skillIndex}].exceptions[${exceptionIndex}]`);
            }
          }
          exceptions.push(exception);
        });
      }

      skills.push({ path: selector, resolvedPath: resolvedSelector, exceptions });
    });
  }

  if (issues.length > 0) {
    throw new LintSkillConfigError(issues);
  }

  return { version: 1, filePath, directory, skills };
}

export function readLintSkillConfig(file) {
  const filePath = configPath(file);
  let metadata;
  try {
    metadata = statSync(filePath);
  } catch (error) {
    throw new LintSkillConfigError(`unable to read config ${filePath}: ${error.message}`);
  }
  if (!metadata.isFile()) {
    throw new LintSkillConfigError(`config must be a regular file: ${filePath}`);
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new LintSkillConfigError(`config exceeds the ${MAX_CONFIG_BYTES}-byte limit: ${filePath}`);
  }

  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new LintSkillConfigError(`unable to read config ${filePath}: ${error.message}`);
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new LintSkillConfigError(`invalid JSON in ${filePath}: ${error.message}`);
  }
  return validateLintSkillConfig(value, { filePath });
}

export function exceptionsForSkill(config, skillDirectory) {
  const selected = normalize(resolve(skillDirectory));
  const entry = config.skills.find((skill) => skill.resolvedPath === selected);
  return entry ? entry.exceptions.map((exception) => ({ ...exception })) : [];
}
