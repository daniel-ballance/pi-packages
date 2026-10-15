#!/usr/bin/env node
// Generate pistack from the vendored upstream pstack.
//
//   node generator/generate.mjs          regenerate the generated roots
//   node generator/generate.mjs --check  regenerate to a temp dir and fail on drift
//
// Never edit generated output. Change a rule (rules/, overlays/, patches/) and
// re-run. Rule kinds apply in order: token rewrites, section replacements,
// per-file patches. The coupling lint then runs over every emitted file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;

function walk(dir) {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [""];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path).map(file => join(entry.name, file)));
    else if (entry.isFile()) files.push(entry.name);
  }
  return files;
}

const isText = bytes => !bytes.includes(0);

// Map upstream paths to output paths; the first matching `from` prefix wins.
function collect(vendor, manifest) {
  const exclude = (manifest.exclude ?? []).map(source => new RegExp(source));
  const files = new Map();
  for (const path of walk(vendor).map(file => file.split("\\").join("/"))) {
    if (exclude.some(pattern => pattern.test(path))) continue;
    const entry = manifest.map.find(({ from }) => from.endsWith("/") ? path.startsWith(from) : path === from);
    if (!entry) continue;
    const bytes = readFileSync(join(vendor, path));
    files.set(entry.to + path.slice(entry.from.length), isText(bytes) ? bytes.toString("utf8") : bytes);
  }
  return files;
}

// Count, then apply, per rule in order: later rules may rewrite earlier output.
function applyTokens(files, rules, problems) {
  for (const rule of rules) {
    const scope = rule.files ? new RegExp(rule.files) : undefined;
    const pattern = new RegExp(rule.find, `g${rule.flags ?? ""}`);
    let count = 0;
    for (const [path, text] of files) {
      if (typeof text !== "string" || (scope && !scope.test(path))) continue;
      const matches = text.match(pattern)?.length ?? 0;
      if (matches === 0) continue;
      count += matches;
      files.set(path, text.replace(pattern, rule.replace));
    }
    if (count < (rule.min ?? 0)) problems.push(`token rule ${rule.id}: ${count} matches, expected at least ${rule.min}. Upstream reworded it.`);
  }
}

// A section runs from its heading to the next heading of the same or a higher
// level, ignoring headings inside fenced code.
function findSection(lines, heading) {
  const starts = lines.flatMap((line, index) => line === heading ? [index] : []);
  if (starts.length !== 1) return { error: starts.length === 0 ? "not found" : `found ${starts.length} times` };
  const start = starts[0], level = heading.match(/^#+/)?.[0].length ?? 0;
  let end = lines.length, fence;
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].match(/^\s*(```|~~~)/)?.[1];
    if (marker) fence = fence === marker ? undefined : fence ?? marker;
    else if (!fence && index > start && /^#+\s/.test(lines[index]) && lines[index].match(/^#+/)[0].length <= level) { end = index; break; }
  }
  return { start, end };
}

// The hash of the untranslated upstream section an overlay replaces. When
// upstream edits that section, the overlay must be reviewed, not left to hide it.
export function sectionHash(text, heading) {
  const lines = text.split("\n"), section = findSection(lines, heading);
  if (section.error) return undefined;
  const body = lines.slice(section.start, section.end).join("\n").trimEnd() + "\n";
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

function applySections(files, upstream, sections, overlaysDir, problems) {
  for (const { file, heading, upstreamHeading = heading, overlay, upstream: expected } of sections) {
    const text = files.get(file);
    if (typeof text !== "string") { problems.push(`section rule: ${file} is not an emitted text file`); continue; }
    const lines = text.split("\n"), section = findSection(lines, heading);
    if (section.error) { problems.push(`section rule: ${file}: heading "${heading}" ${section.error}. Upstream changed the section.`); continue; }
    const actual = sectionHash(upstream.get(file), upstreamHeading);
    if (actual !== expected) {
      problems.push(`section rule: ${file}: section "${heading}" changed upstream (was ${expected}, now ${actual}). Review the overlay, then update its hash.`);
      continue;
    }
    lines.splice(section.start, section.end - section.start, ...readFileSync(join(overlaysDir, overlay), "utf8").trimEnd().split("\n"), "");
    files.set(file, lines.join("\n"));
  }
}

// Hand-written files under extra/ join the output as they are: they are already
// written for Pi, so only the coupling lint applies to them.
function addExtras(files, extraDir) {
  for (const path of walk(extraDir)) files.set(path.split("\\").join("/"), readFileSync(join(extraDir, path)));
}

function writeFiles(files, outDir) {
  for (const [path, contents] of files) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), contents);
  }
}

function applyPatches(patchesDir, outDir, problems) {
  for (const name of walk(patchesDir).filter(file => file.endsWith(".patch"))) {
    const patch = join(patchesDir, name);
    try {
      execFileSync("git", ["apply", "--check", patch], { cwd: outDir, stdio: "pipe" });
      execFileSync("git", ["apply", patch], { cwd: outDir, stdio: "pipe" });
    } catch (error) {
      problems.push(`patch ${name} no longer applies; rebase it: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
}

function lint(outDir, deny, problems) {
  for (const path of walk(outDir)) {
    const bytes = readFileSync(join(outDir, path));
    if (!isText(bytes)) continue;
    bytes.toString("utf8").split("\n").forEach((line, index) => {
      for (const token of deny) if (line.includes(token)) problems.push(`${path}:${index + 1}: ${token}`);
    });
  }
}

export function generate({ packageDir, outDir }) {
  const rules = join(packageDir, "rules");
  const manifest = readJson(join(rules, "manifest.json"));
  const problems = [];
  const files = collect(join(packageDir, manifest.vendor), manifest);
  const upstream = new Map(files);
  applyTokens(files, readJson(join(rules, "tokens.json"), []), problems);
  applySections(files, upstream, readJson(join(rules, "sections.json"), []), join(packageDir, "overlays"), problems);
  addExtras(files, join(packageDir, "extra"));
  if (problems.length) throw new Error(problems.join("\n"));
  writeFiles(files, outDir);
  applyPatches(join(packageDir, "patches"), outDir, problems);
  if (problems.length) throw new Error(problems.join("\n"));
  const lintProblems = [];
  lint(outDir, readJson(join(rules, "lint.json"), { deny: [] }).deny, lintProblems);
  if (lintProblems.length) throw new Error(`Coupling lint: Cursor-only tokens remain; add a rule, never edit the output.\n${lintProblems.join("\n")}`);
}

// Top-level files and directories the generator owns, replaced whole on sync.
const generatedRoots = packageDir =>
  [...new Set(readJson(join(packageDir, "rules/manifest.json")).map.map(({ to }) => to.split("/")[0]))].sort();

function drift(packageDir, outDir) {
  const problems = [];
  for (const root of generatedRoots(packageDir)) {
    const expected = new Set(walk(join(outDir, root)).map(file => join(root, file)));
    const actual = new Set(walk(join(packageDir, root)).map(file => join(root, file)));
    for (const path of [...new Set([...expected, ...actual])].sort()) {
      if (!actual.has(path)) problems.push(`${path}: missing`);
      else if (!expected.has(path)) problems.push(`${path}: not generated`);
      else if (!readFileSync(join(outDir, path)).equals(readFileSync(join(packageDir, path)))) problems.push(`${path}: differs`);
    }
  }
  return problems;
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node generator/generate.mjs [--check]");
    return 2;
  }
  const packageDir = resolve(process.env.PISTACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const outDir = mkdtempSync(join(tmpdir(), "pistack-"));
  try {
    generate({ packageDir, outDir });
    if (args[0] === "--check") {
      const problems = drift(packageDir, outDir);
      if (problems.length === 0) return 0;
      console.error(`Generated output differs from a fresh generation. Run node generator/generate.mjs.\n  ${problems.join("\n  ")}`);
      return 1;
    }
    for (const root of generatedRoots(packageDir)) {
      rmSync(join(packageDir, root), { recursive: true, force: true });
      if (existsSync(join(outDir, root))) cpSync(join(outDir, root), join(packageDir, root), { recursive: true });
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
