#!/usr/bin/env node
// Reports changes that lower the quality floor: new suppressions, skipped or
// deleted tests, stubs and swallowed errors, and weakened thresholds.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const RULES = [
  ["suppression", /@ts-ignore\b|@ts-nocheck\b|eslint-disable(?:-next-line|-line)?\b|biome-ignore\b|#\s*noqa\b|#\s*type:\s*ignore\b|#\s*pylint:\s*disable\b|#\[allow\(|\/\/\s*nolint\b|@SuppressWarnings\b/], // floor-ok: pattern definitions
  ["suppression", /@ts-expect-error(?!\s*[:\-–—]*\s*\w)/], // floor-ok: pattern definitions
  ["skipped-test", /\b(?:it|test|describe|context)\.(?:skip|only|todo)\s*\(|(?:^|[^.\w$])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bunittest\.skip|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]/], // floor-ok: pattern definitions
  ["stub", /throw\s+new\s+Error\(\s*["'`](?:not implemented|todo)\b|raise\s+NotImplementedError\b|\btodo!\s*\(|\bunimplemented!\s*\(|panic\(\s*"(?:todo|not implemented)/i], // floor-ok: pattern definitions
  ["swallowed-error", /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except\b[^:]*:\s*pass\b/], // floor-ok: pattern definitions
];
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/;
const CONFIG_PATH = /(?:^|\/)(?:(?:vitest|jest|vite|karma)\.config\.[^/]+|\.nycrc(?:\.json)?|pyproject\.toml|setup\.cfg|\.coveragerc|tsconfig[^/]*\.json|biome\.jsonc?|\.eslintrc[^/]*|eslint\.config\.[^/]+)$/;
const THRESHOLD_WORD = /threshold|coverage|fail_under|min(?:imum)?|lines|branches|functions|statements|budget|max/i;
const STRICT_OFF = /"(?:strict\w*|noImplicit\w+|noUnused\w+|noUnchecked\w+|exactOptionalPropertyTypes|noFallthroughCasesInSwitch)"\s*:\s*false/; // floor-ok: pattern definitions
const RULE_OFF = /:\s*(?:\[\s*)?(?:"off"|'off'|0)\b/; // floor-ok: pattern definitions
const EXPLAINED = /floor-ok:\s*\S/;

function usage(message) {
  process.stderr.write(`${message}\nUsage: floor-check [--base <ref>] [--cwd <dir>] [--constraints <path>] [--json]\n`);
  process.exit(2);
}

function git(cwd, args, allowFail = false) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (allowFail) return undefined;
    throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

/** The base, in this order: --base, merge-base with origin/HEAD, main, master, then HEAD~1, else the empty tree. */
export function resolveBase(cwd, explicit) {
  if (explicit) {
    const sha = git(cwd, ["rev-parse", "--verify", `${explicit}^{commit}`], true);
    if (!sha) throw new Error(`Unknown base ${explicit}`);
    return sha.trim();
  }
  for (const ref of ["origin/HEAD", "main", "master"]) {
    const sha = git(cwd, ["merge-base", "HEAD", ref], true);
    if (sha?.trim()) return sha.trim();
  }
  return git(cwd, ["rev-parse", "--verify", "HEAD~1^{commit}"], true)?.trim() || EMPTY_TREE;
}

/** Parses `git diff -U0` into per-file hunks of removed and added lines with their line numbers. */
export function parseDiff(text) {
  const files = new Map();
  let file, hunk;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { file = undefined; hunk = undefined; continue; }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
      if (file && !files.has(file)) files.set(file, []);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = { removed: [], added: [], oldLine: Number(header[1]), newLine: Number(header[2]) };
      if (file) files.get(file).push(hunk);
      continue;
    }
    if (!hunk || !file) continue;
    if (line.startsWith("-")) hunk.removed.push({ line: hunk.oldLine++, text: line.slice(1) });
    else if (line.startsWith("+")) hunk.added.push({ line: hunk.newLine++, text: line.slice(1) });
  }
  return files;
}

const numbers = text => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

function checkHunks(path, hunks, isConstraints, report) {
  for (const hunk of hunks) {
    hunk.added.forEach((added, index) => {
      for (const [category, pattern] of RULES) if (pattern.test(added.text)) report(category, path, added.line, added.text);
      if (/^\s*except\b[^:]*:\s*$/.test(added.text) && /^\s*pass\s*$/.test(hunk.added[index + 1]?.text ?? "")) report("swallowed-error", path, added.line, added.text);
    });
    if (isConstraints) {
      hunk.removed.forEach((removed, index) => {
        const added = hunk.added[index];
        if (!removed.text.trim()) return;
        if (!added) report("weakened-threshold", path, removed.line, `removed: ${removed.text}`, removed.text);
        else if (numbers(removed.text).join() !== numbers(added.text).join()) report("weakened-threshold", path, added.line, `${removed.text.trim()} -> ${added.text.trim()}`, added.text);
      });
    } else if (CONFIG_PATH.test(path)) {
      hunk.added.forEach((added, index) => {
        if (STRICT_OFF.test(added.text)) report("weakened-threshold", path, added.line, added.text);
        else if (/eslint/.test(path) && RULE_OFF.test(added.text)) report("weakened-threshold", path, added.line, added.text);
        const removed = hunk.removed[index];
        if (removed && THRESHOLD_WORD.test(added.text)) {
          const before = numbers(removed.text), after = numbers(added.text);
          if (before.length === after.length && after.some((value, i) => value < before[i])) report("weakened-threshold", path, added.line, `${removed.text.trim()} -> ${added.text.trim()}`, added.text);
        }
      });
    }
  }
}

export function floorCheck({ cwd = process.cwd(), base, constraints = "CONSTRAINTS.md" } = {}) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const resolved = resolveBase(root, base);
  const findings = [], explained = [];
  const report = (category, path, line, text, source = text) => (EXPLAINED.test(source) ? explained : findings).push({ category, path, line, text: text.trim() });
  const constraintsPath = constraints.replace(/^\.\//, "");
  const diff = parseDiff(git(root, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", "--find-renames", resolved]));
  for (const [path, hunks] of diff) checkHunks(path, hunks, path === constraintsPath, report);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const path of untracked) {
    let text;
    try { text = readFileSync(join(root, path), "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    checkHunks(path, [{ removed: [], added: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) }], false, report);
  }
  const statuses = git(root, ["diff", "--no-color", "--name-status", "--find-renames", resolved]);
  for (const row of statuses.split("\n").filter(Boolean)) {
    const [status, path] = row.split("\t");
    if (status === "D" && TEST_PATH.test(path)) findings.push({ category: "deleted-test", path, line: 0, text: "test file deleted" });
    if (status === "D" && path === constraintsPath) findings.push({ category: "weakened-threshold", path, line: 0, text: "constraints file deleted" });
  }
  const order = (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.category.localeCompare(b.category);
  return { base: resolved, findings: findings.sort(order), explained: explained.sort(order) };
}

export function format({ findings, explained }) {
  const line = item => `${item.category} ${item.path}:${item.line} ${item.text}`;
  return [`floor-check: ${findings.length} finding(s), ${explained.length} explained`, ...findings.map(line), ...explained.map(item => `explained ${line(item)}`)].join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: { base: { type: "string" }, cwd: { type: "string" }, constraints: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } } }));
  } catch (error) { usage(error.message); }
  if (values.help) usage("Reports changes that lower the quality floor.");
  try {
    const result = floorCheck({ cwd: values.cwd, base: values.base, constraints: values.constraints });
    process.stdout.write(values.json ? JSON.stringify(result, null, 2) + "\n" : format(result));
    process.exit(result.findings.length ? 1 : 0);
  } catch (error) {
    process.stderr.write(`floor-check: ${error.message}\n`);
    process.exit(2);
  }
}
