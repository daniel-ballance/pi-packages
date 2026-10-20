#!/usr/bin/env node
// Generate p3stack from the vendored upstream pstack.
//
//   node generator/generate.mjs          regenerate the generated roots
//   node generator/generate.mjs --check  regenerate to a temp dir and fail on drift
//
// Never edit generated output. Change a rule (rules/, overlays/, patches/) and
// re-run. Rule kinds apply in order: token rewrites, section replacements,
// per-file patches. The coupling lint then runs over every emitted file.
//
// Token `replace` strings and overlays may name the pinned upstream commit as
// {{upstream.commit}}, so links to upstream follow the pin instead of going stale.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-env.mjs";
import { sourcePathClassifier } from "./source-paths.mjs";

const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;

// Code-unit order, so output and patch order never depend on the machine's locale.
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// Files and symlinks under dir. Symlinks are listed, never followed, so a stray
// link in a generated root shows up as drift.
function walk(dir) {
  if (!existsSync(dir) && !isLink(dir)) return [];
  if (!lstatSync(dir).isDirectory()) return [""];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path).map(file => join(entry.name, file)));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(entry.name);
  }
  return files;
}

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
function decode(bytes) {
  if (bytes.includes(0)) return undefined;
  try { return utf8.decode(bytes); } catch { return undefined; }
}

const isExecutable = path => (statSync(path).mode & 0o111) !== 0;

// Map upstream paths to output paths; the first matching `from` prefix wins.
// Text files are strings, which rules may rewrite; anything else stays bytes.
function collect(packageDir, sources, executables, problems) {
  const files = new Map(), owners = new Map();
  for (const source of sources) {
    const vendor = join(packageDir, source.vendor), classify = sourcePathClassifier(source);
    for (const path of walk(vendor).map(file => file.split("\\").join("/"))) {
      const { output } = classify(path);
      if (output === undefined) continue;
      if (isLink(join(vendor, path))) { problems.push(`${source.name}: ${path}: upstream symlinks are not supported; exclude it or add a rule`); continue; }
      if (owners.has(output)) {
        problems.push(`${output}: sources "${owners.get(output)}" and "${source.name}" both emit this path`);
        continue;
      }
      const bytes = readFileSync(join(vendor, path));
      files.set(output, decode(bytes) ?? bytes);
      owners.set(output, source.name);
      if (isExecutable(join(vendor, path))) executables.add(output);
    }
  }
  return { files, owners };
}

const COMMIT = "{{upstream.commit}}";

// Fill the pinned commit into hand-written rule text.
function expander(commit, problems) {
  return (text, where) => {
    if (!text.includes(COMMIT)) return text;
    if (commit === undefined) { problems.push(`${where}: uses ${COMMIT}, but rules/manifest.json has no upstream checkout`); return text; }
    return text.replaceAll(COMMIT, commit);
  };
}

// Count, then apply, per rule in order: later rules may rewrite earlier output.
function applyTokens(files, owners, rules, expand, problems) {
  const skillNames = [...files.keys()]
    .flatMap(path => /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.slice(1) ?? [])
    .sort().map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)";
  for (const rule of rules) {
    const replace = expand(rule.replace, `token rule ${rule.id}`);
    const scope = rule.files ? new RegExp(rule.files) : undefined;
    const pattern = new RegExp(rule.find.replaceAll("{{skills.names}}", () => skillNames), `g${rule.flags ?? ""}`);
    let count = 0;
    for (const [path, text] of files) {
      if (typeof text !== "string" || (rule.source !== undefined && owners.get(path) !== rule.source) || (scope && !scope.test(path))) continue;
      const matches = text.match(pattern)?.length ?? 0;
      if (matches === 0) continue;
      count += matches;
      files.set(path, text.replace(pattern, replace));
    }
    if (count < (rule.min ?? 0)) problems.push(`token rule ${rule.id}: ${count} matches, expected at least ${rule.min}. Upstream reworded or removed its text.`);
  }
}

// Whether each line sits inside fenced code. A fence opens with three or more
// backticks or tildes, indented at most three spaces, and closes with a line of
// at least as many of the same character (CommonMark).
function fencedLines(lines) {
  let fence;
  return lines.map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence) {
      if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) { fence = marker[1]; return true; }
      return false;
    }
    if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "") fence = undefined;
    return true;
  });
}

const headingLevel = line => line.match(/^ {0,3}(#{1,6})(?:[ \t]|$)/)?.[1].length;

// A section runs from its heading to the next heading of the same or a higher
// level. Headings inside fenced code neither start nor end one.
function findSection(lines, heading) {
  const fenced = fencedLines(lines);
  const starts = lines.flatMap((line, index) => line === heading && !fenced[index] ? [index] : []);
  if (starts.length !== 1) return { error: starts.length === 0 ? "not found" : `found ${starts.length} times` };
  const start = starts[0], level = headingLevel(heading) ?? 0;
  let end = lines.length;
  const children = [];
  for (let index = start + 1; index < lines.length; index++) {
    const found = fenced[index] ? undefined : headingLevel(lines[index]);
    if (found === undefined) continue;
    if (found <= level) { end = index; break; }
    children.push(lines[index]);
  }
  return { start, end, children };
}

// The hash of the untranslated upstream section an overlay replaces. When
// upstream edits that section, the overlay must be reviewed, not left to hide it.
export function sectionHash(text, heading) {
  const lines = text.split("\n"), section = findSection(lines, heading);
  if (section.error) return undefined;
  const body = lines.slice(section.start, section.end).join("\n").trimEnd() + "\n";
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

function applySections(files, upstream, sections, overlaysDir, expand, problems) {
  for (const { file, heading, upstreamHeading = heading, overlay, upstream: expected } of sections) {
    const text = files.get(file);
    if (typeof text !== "string") { problems.push(`section rule: ${file} is not an emitted text file`); continue; }
    const lines = text.split("\n"), section = findSection(lines, heading);
    if (section.error) { problems.push(`section rule: ${file}: heading "${heading}" ${section.error}. Upstream changed the section.`); continue; }
    const source = upstream.get(file);
    const sourceSection = typeof source === "string" ? findSection(source.split("\n"), upstreamHeading) : undefined;
    if (sourceSection && !sourceSection.error && sourceSection.children.length) {
      const listed = sourceSection.children.map(line => `"${line}"`).join(", ");
      problems.push(`section rule: ${file}: "${heading}" is not a leaf; it contains ${listed}. Replace each child. Put text before the first child in a token anchored on "${heading}". A sibling with no rule is emitted.`);
      continue;
    }
    const actual = sectionHash(source, upstreamHeading);
    if (actual !== expected) {
      problems.push(`section rule: ${file}: section "${heading}" changed upstream (was ${expected}, now ${actual}). Review the overlay, then update its hash.`);
      continue;
    }
    const replacement = expand(readFileSync(join(overlaysDir, overlay), "utf8"), `overlay ${overlay}`);
    lines.splice(section.start, section.end - section.start, ...replacement.trimEnd().split("\n"), "");
    files.set(file, lines.join("\n"));
  }
}

// Hand-written files under extra/ join the output as they are: they are already
// written for Pi, so only the coupling lint applies to them.
function addExtras(files, extraDir, executables) {
  for (const path of walk(extraDir)) {
    const output = path.split("\\").join("/");
    files.set(output, readFileSync(join(extraDir, path)));
    if (isExecutable(join(extraDir, path))) executables.add(output);
  }
}

function writeFiles(files, executables, outDir) {
  for (const [path, contents] of files) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), contents);
    chmodSync(join(outDir, path), executables.has(path) ? 0o755 : 0o644);
  }
}

function applyPatches(patchesDir, outDir, problems) {
  for (const name of walk(patchesDir).filter(file => file.endsWith(".patch"))) {
    const patch = join(patchesDir, name);
    try {
      execFileSync("git", ["apply", "--check", patch], { cwd: outDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["apply", patch], { cwd: outDir, stdio: "pipe", env: gitEnv() });
    } catch (error) {
      problems.push(`patch ${name} no longer applies; rebase it: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
}

function lint(outDir, deny, problems) {
  for (const path of walk(outDir)) {
    const text = decode(readFileSync(join(outDir, path)));
    if (text === undefined) continue;
    text.split("\n").forEach((line, index) => {
      for (const token of deny) if (line.includes(token)) problems.push(`${path}:${index + 1}: ${token}`);
    });
  }
}

export function generate({ packageDir, outDir }) {
  const rules = join(packageDir, "rules");
  const manifest = readJson(join(rules, "manifest.json"));
  const info = manifest.sources.map(source => upstreamInfo(packageDir, source))[0];
  const problems = [], executables = new Set();
  const { files, owners } = collect(packageDir, manifest.sources, executables, problems);
  const upstream = new Map(files), expand = expander(info?.commit, problems);
  applyTokens(files, owners, readJson(join(rules, "tokens.json"), []), expand, problems);
  applySections(files, upstream, readJson(join(rules, "sections.json"), []), join(packageDir, "overlays"), expand, problems);
  addExtras(files, join(packageDir, "extra"), executables);
  if (problems.length) throw new Error(problems.join("\n"));
  writeFiles(files, executables, outDir);
  applyPatches(join(packageDir, "patches"), outDir, problems);
  if (problems.length) throw new Error(problems.join("\n"));
  // Patches are rewritten under the caller's umask; keep only the executable bit.
  for (const path of walk(outDir)) chmodSync(join(outDir, path), isExecutable(join(outDir, path)) ? 0o755 : 0o644);
  const lintProblems = [];
  lint(outDir, readJson(join(rules, "lint.json"), { deny: [] }).deny, lintProblems);
  if (lintProblems.length) throw new Error(`Coupling lint: Cursor-only tokens remain; add a rule, never edit the output.\n${lintProblems.join("\n")}`);
}

// Top-level files and directories the generator owns, replaced whole on sync.
const generatedRoots = packageDir =>
  [...new Set(readJson(join(packageDir, "rules/manifest.json")).sources.flatMap(source => source.map.map(({ to }) => to.split("/")[0])))].sort();

function drift(packageDir, outDir) {
  const problems = [];
  for (const root of generatedRoots(packageDir)) {
    const expected = new Set(walk(join(outDir, root)).map(file => join(root, file)));
    const actual = new Set(walk(join(packageDir, root)).map(file => join(root, file)));
    for (const path of [...new Set([...expected, ...actual])].sort()) {
      const committed = join(packageDir, path), fresh = join(outDir, path);
      if (!actual.has(path)) problems.push(`${path}: missing`);
      else if (!expected.has(path)) problems.push(`${path}: not generated`);
      else if (isLink(committed)) problems.push(`${path}: is a symlink`);
      else if (!readFileSync(fresh).equals(readFileSync(committed))) problems.push(`${path}: differs`);
      else if (isExecutable(fresh) !== isExecutable(committed)) problems.push(`${path}: mode differs`);
    }
  }
  return problems;
}

// The upstream checkout's commit and plugin, when the manifest names a checkout.
export function upstreamInfo(packageDir, source) {
  const { vendor, upstream } = source;
  if (!upstream) return undefined;
  const checkout = join(packageDir, upstream.checkout);
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).trim();
  const subtreePath = relative(checkout, join(packageDir, vendor)) || ".";
  const hidden = git("ls-files", "-v", "-z", "--", subtreePath).split("\0").filter(entry => /^[a-zS] /.test(entry));
  const changes = [git("-c", "core.fileMode=true", "status", "--porcelain=v1", "--untracked-files=all", "--ignored", "--ignore-submodules=none", "--", subtreePath), ...hidden].filter(Boolean).join("\n");
  if (changes) throw new Error(`${upstream.checkout} has local changes; generation requires clean upstream inputs, including ignored files.\n${changes}`);
  const commit = git("rev-parse", "HEAD");
  const { name, version } = readJson(join(packageDir, vendor, "plugin.json"));
  const subtree = relative(upstream.checkout, vendor).split("\\").join("/");
  return { repository: upstream.repository, commit, subtree, name, version };
}

// The upstream pin the generated tree comes from, as recorded in package.json:
// "<repository>@<commit> <plugin name> <plugin version>".
const pinOf = info => info && `${info.repository}@${info.commit} ${info.name} ${info.version}`;

// The README states the pin between these markers; the generator keeps it current.
const README_PIN = /(<!-- p3stack:upstream -->)[\s\S]*?(<!-- \/p3stack:upstream -->)/g;
const readmePin = info =>
  `\`${info.repository}\` [\`${info.commit.slice(0, 7)}\`](https://github.com/${info.repository}/tree/${info.commit}${info.subtree ? `/${info.subtree}` : ""}), ${info.name} ${info.version}`;
function pinnedReadme(text, info) {
  return info === undefined ? text : text.replace(README_PIN, (_, open, close) => `${open}${readmePin(info)}${close}`);
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node generator/generate.mjs [--check]");
    return 2;
  }
  const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const outDir = mkdtempSync(join(tmpdir(), "p3stack-"));
  try {
    generate({ packageDir, outDir });
    const source = readJson(join(packageDir, "rules/manifest.json")).sources[0];
    const info = upstreamInfo(packageDir, source), pin = pinOf(info), manifestPath = join(packageDir, "package.json");
    const readmePath = join(packageDir, "README.md"), readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;
    if (args[0] === "--check") {
      const problems = drift(packageDir, outDir);
      const recorded = pin === undefined ? undefined : readJson(manifestPath).p3stack?.upstream;
      if (recorded !== pin) problems.push(`package.json p3stack.upstream is "${recorded}", expected "${pin}"`);
      if (readme !== undefined && pinnedReadme(readme, info) !== readme) problems.push("README.md: the upstream pin between the p3stack:upstream markers is stale");
      if (problems.length === 0) return 0;
      console.error(`Generated output differs from a fresh generation. Run node generator/generate.mjs.\n  ${problems.join("\n  ")}`);
      return 1;
    }
    for (const root of generatedRoots(packageDir)) {
      rmSync(join(packageDir, root), { recursive: true, force: true });
      if (existsSync(join(outDir, root))) cpSync(join(outDir, root), join(packageDir, root), { recursive: true });
    }
    if (pin !== undefined) {
      const manifest = readJson(manifestPath);
      manifest.p3stack = { ...manifest.p3stack, upstream: pin };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    if (readme !== undefined && pinnedReadme(readme, info) !== readme) writeFileSync(readmePath, pinnedReadme(readme, info));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
