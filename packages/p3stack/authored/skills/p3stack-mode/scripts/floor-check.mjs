#!/usr/bin/env node
// A line-pattern detector for the final diff, not a test suite or policy parser.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
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
const MINIMUM = />=|≥|minimum|\bmin\b|threshold|coverage|fail[_-]under|lines|branches|functions|statements/i;
const MAXIMUM = /<=|≤|maximum|\bmax|budget/i;
const TEST_CASE = /^\s*(?:it|test)\s*\(\s*(['"`])(.+?)\1\s*,/;
const MAX_BYTES = 1024 * 1024;
const STRICT_OFF = /"(?:strict\w*|noImplicit\w+|noUnused\w+|noUnchecked\w+|exactOptionalPropertyTypes|noFallthroughCasesInSwitch)"\s*:\s*false/; // floor-ok: pattern definitions
const RULE_OFF = /:\s*(?:\[\s*)?(?:"off"|'off'|off|0)(?=\s*[,}\]\/#]|\s*$)/; // floor-ok: pattern definitions
const EXPLAINED = /floor-ok:\s*\S/;

function usage(message) {
  process.stderr.write(`${message}\nUsage: floor-check [--base <ref>] [--cwd <dir>] [--constraints <path>] [--explain 'category path:line=reason']... [--json]\n`);
  process.exit(2);
}

function git(cwd, args, allowFail = false) {
  try {
    return execFileSync("git", ["--literal-pathspecs", "-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (allowFail) return undefined;
    throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

/** The base, in this order: --base, merge-base with origin/HEAD, main, master, then HEAD~1, else the empty tree. */
export function resolveBase(cwd, explicit) {
  if (explicit) {
    const sha = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${explicit}^{commit}`], true);
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
  let file, oldPath, hunk;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { file = oldPath = hunk = undefined; continue; }
    if (!hunk && line.startsWith("--- ")) { oldPath = diffPath(line); continue; }
    if (!hunk && line.startsWith("+++ ")) {
      file = diffPath(line) ?? oldPath;
      if (file && !files.has(file)) files.set(file, []);
      continue;
    }
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

function diffPath(header) {
  const raw = header.slice(4).replace(/\t$/, "");
  const path = raw.startsWith('"') ? JSON.parse(raw) : raw;
  return path === "/dev/null" ? undefined : path.slice(2);
}

const NUMBER = /-?\d+(?:\.\d+)?/g;
const shape = text => text.replace(NUMBER, "#").replace(/\s+/g, "").replace(/,(?=$|[}\]])/g, "");

// Only words/operators leading up to this number can set its direction.
function thresholds(text) {
  let start = 0;
  return [...text.matchAll(NUMBER)].map(match => {
    const clause = text.slice(start, match.index).split(/[|,;]/).at(-1);
    start = match.index + match[0].length;
    const op = clause.match(/(?:>=|≥|<=|≤)\s*$/)?.[0].trim();
    const direction = op ? (/^[>≥]/.test(op) ? "min" : "max")
      : MAXIMUM.test(clause) ? "max" : MINIMUM.test(clause) ? "min" : undefined;
    return { value: Number(match[0]), direction };
  });
}

// Compare literal rule severities/strict flags by key. An explicit off/false
// on the new side already has its own finding.
function lostSetting(path, old, added) {
  const pattern = /["']?([\w@./-]+)["']?\s*:\s*(?:\[\s*)?["']?(error|warn|off|[012]|true|false)["']?(?=\s*[,}\]#\/]|\s*$)/g;
  for (const [, key, value] of old.matchAll(pattern)) {
    const eslint = /eslint/.test(path) && ["error", "2"].includes(value);
    const strict = /tsconfig/.test(path) && key === "strict" && value === "true";
    if (!eslint && !strict) continue;
    if (!added.some(({ text }) => [...text.matchAll(pattern)].some(([, k, v]) =>
      k === key && (eslint ? ["error", "2", "off", "0"] : ["true", "false"]).includes(v)))) return true;
  }
  return false;
}

function checkThresholds(path, hunk, isConstraints, report) {
  const added = new Map();
  for (const line of hunk.added) {
    const key = shape(line.text);
    if (!added.has(key)) added.set(key, []);
    added.get(key).push(line);
    if (!isConstraints && (STRICT_OFF.test(line.text) || (/eslint/.test(path) && RULE_OFF.test(line.text)))) {
      report("weakened-threshold", path, line.line, line.text);
    }
  }
  for (const old of hunk.removed) {
    if (lostSetting(path, old.text, hunk.added)) {
      report("weakened-threshold", path, old.line, `removed setting: ${old.text.trim()}`, "");
      continue;
    }
    const before = thresholds(old.text);
    if (!old.text.trim() || (!isConstraints && !before.some(n => n.direction))) continue;
    const next = added.get(shape(old.text))?.shift();
    if (!next) {
      const category = isConstraints && hunk.added.length ? "changed-constraint" : "weakened-threshold";
      report(category, path, old.line, `removed: ${old.text.trim()}`, "");
      continue;
    }
    const after = [...next.text.matchAll(NUMBER)].map(m => Number(m[0]));
    const changed = before.filter((n, i) => n.value !== after[i]);
    if (!changed.length) continue;
    const detail = `${old.text.trim()} -> ${next.text.trim()}`;
    if (before.some(({ direction, value }, i) => direction === "max" ? after[i] > value : direction === "min" && after[i] < value)) {
      report("weakened-threshold", path, next.line, detail, next.text);
    } else if (isConstraints && changed.some(n => !n.direction)) report("changed-constraint", path, next.line, detail, next.text);
  }
}

function checkHunks(path, hunks, isConstraints, report) {
  // Match names across hunks so an edited body or a moved case isn't a deletion.
  if (TEST_PATH.test(path)) {
    const names = new Map();
    for (const { added } of hunks) for (const { text } of added) {
      const name = TEST_CASE.exec(text)?.[2];
      if (name) names.set(name, (names.get(name) ?? 0) + 1);
    }
    for (const { removed } of hunks) for (const { line, text } of removed) {
      const name = TEST_CASE.exec(text)?.[2];
      if (!name) continue;
      if (names.get(name)) names.set(name, names.get(name) - 1);
      else report("deleted-test-case", path, line, `removed: ${name}`, "");
    }
  }
  for (const hunk of hunks) {
    hunk.added.forEach((added, index) => {
      for (const [category, pattern] of RULES) if (pattern.test(added.text)) report(category, path, added.line, added.text);
      if (/^\s*except\b[^:]*:\s*$/.test(added.text) && /^\s*pass\s*$/.test(hunk.added[index + 1]?.text ?? "")) report("swallowed-error", path, added.line, added.text);
    });
    if (isConstraints || CONFIG_PATH.test(path)) checkThresholds(path, hunk, isConstraints, report);
  }
}

function checkFile(path, stat, report) {
  const reason = stat.isSymbolicLink() ? "symlink" : stat.size > MAX_BYTES ? "over 1 MiB" : undefined;
  if (reason) { report("unchecked-file", path, 0, reason); return false; }
  if (!stat.isFile()) throw new Error(`${path}: expected a regular file`);
  return true;
}

function checkPath(root, path, report) {
  let dir = root;
  for (const part of path.split("/").slice(0, -1)) {
    dir = join(dir, part);
    if (!lstatSync(dir).isDirectory()) throw new Error(`${path}: not a directory: ${dir}`);
  }
  return checkFile(path, lstatSync(join(root, path)), report);
}

function readUntracked(root, path, report) {
  if (!checkPath(root, path, report)) return;
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!checkFile(path, stat, report)) return;
    const bytes = Buffer.alloc(stat.size + 1);
    let n = 0, count;
    while (n < bytes.length && (count = readSync(fd, bytes, n, bytes.length - n, null))) n += count;
    if (n !== stat.size) throw new Error(`${path}: size changed during check`);
    return bytes.toString("utf8", 0, n);
  } finally { closeSync(fd); }
}

const nulList = output => output.split("\0").filter(Boolean);

// Ask for metadata before asking Git for patches or rename detection (both read content).
function trackedPaths(root, base, report) {
  const raw = nulList(git(root, ["diff-index", "--raw", "-z", "--no-renames", "--ignore-submodules=all", base]));
  const paths = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    const path = raw[i + 1], [, mode] = raw[i].split(" ");
    if (mode === "000000" || checkPath(root, path, report)) paths.add(path);
  }
  if (paths.size) {
    for (const row of nulList(git(root, ["ls-tree", "-rlz", base, "--", ...paths]))) {
      const tab = row.indexOf("\t"), [mode, , , size] = row.slice(0, tab).split(/\s+/);
      const path = row.slice(tab + 1);
      if (mode === "120000" || Number(size) > MAX_BYTES) {
        paths.delete(path);
        report("unchecked-file", path, 0, mode === "120000" ? "base is a symlink" : "base over 1 MiB");
      } else if (!/^100(644|755)$/.test(mode)) throw new Error(`${path}: base is not a regular file`);
    }
  }
  return [...paths];
}

function explain(findings, explained, reasons) {
  for (const arg of reasons) {
    const match = /^(.+:\d+)=\s*(\S.*)$/u.exec(arg);
    if (!match) throw new Error("--explain needs 'category path:line=reason'");
    const hits = findings.filter(f => `${f.category} ${f.path}:${f.line}` === match[1]);
    if (hits.length !== 1) throw new Error(`Expected one unexplained finding named ${match[1]}, found ${hits.length}`);
    findings.splice(findings.indexOf(hits[0]), 1);
    explained.push({ ...hits[0], reason: match[2].trim() });
  }
}

export function floorCheck({ cwd = process.cwd(), base, constraints = "CONSTRAINTS.md", reasons = [] } = {}) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const resolved = resolveBase(root, base);
  const findings = [], explained = [];
  const report = (category, path, line, text, source = text) => (EXPLAINED.test(source) ? explained : findings).push({ category, path, line, text: text.trim() });
  const constraintsPath = constraints.replace(/^\.\//, "");
  const paths = trackedPaths(root, resolved, report);
  if (paths.length) {
    const options = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--find-renames"];
    const range = [resolved, "--", ...paths];
    const deleted = new Set();
    const changes = nulList(git(root, [...options, "--name-status", "--diff-filter=DR", "-z", ...range]));
    for (let i = 0; i < changes.length;) {
      const status = changes[i++], from = changes[i++];
      if (status === "D") deleted.add(from);
      else {
        const to = changes[i++];
        if (TEST_PATH.test(from) && !TEST_PATH.test(to)) deleted.add(from);
      }
    }
    const diff = parseDiff(git(root, [...options, "--src-prefix=a/", "--dst-prefix=b/", "-U0", ...range]));
    for (const path of deleted) {
      if (TEST_PATH.test(path)) report("deleted-test", path, 0, "test file deleted");
      if (path === constraintsPath) report("weakened-threshold", path, 0, "constraints file deleted");
    }
    for (const [path, hunks] of diff) {
      if (deleted.has(path) && (TEST_PATH.test(path) || path === constraintsPath)) continue;
      checkHunks(path, hunks, path === constraintsPath, report);
    }
  }
  for (const path of nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    const text = readUntracked(root, path, report);
    if (text === undefined || text.includes("\0")) continue;
    checkHunks(path, [{ removed: [], added: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) }], false, report);
  }
  explain(findings, explained, reasons);
  const order = (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.category.localeCompare(b.category);
  return { base: resolved, findings: findings.sort(order), explained: explained.sort(order) };
}

export function format({ findings, explained }) {
  const line = item => `${item.category} ${item.path}:${item.line} ${item.text}`;
  return [`floor-check: ${findings.length} finding(s), ${explained.length} explained`, ...findings.map(line), ...explained.map(item => `explained ${line(item)}${item.reason ? ` — ${item.reason}` : ""}`)].join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: { base: { type: "string" }, cwd: { type: "string" }, constraints: { type: "string" }, explain: { type: "string", multiple: true }, json: { type: "boolean" }, help: { type: "boolean" } } }));
  } catch (error) { usage(error.message); }
  if (values.help) usage("Reports changes that lower the quality floor.");
  try {
    const result = floorCheck({ cwd: values.cwd, base: values.base, constraints: values.constraints, reasons: values.explain });
    process.stdout.write(values.json ? JSON.stringify(result, null, 2) + "\n" : format(result));
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`floor-check: ${error.message}\n`);
    process.exit(2);
  }
}
