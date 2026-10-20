#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-env.mjs";
import { checkRegistry, loadRegistry } from "./check-registry.mjs";
import { lintHosts } from "./lint-hosts.mjs";
import { sourcePathClassifier, sourcesOf } from "./source-paths.mjs";

const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;

const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

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

function collect(packageDir, sources, executables, problems, skills) {
  const files = new Map(), owners = new Map();
  for (const source of sources) {
    const vendor = join(packageDir, source.vendor), classify = sourcePathClassifier(source, skills);
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
    for (const path of source.required ?? []) {
      if (owners.get(path) !== source.name) problems.push(`${source.name}: ${path}: required upstream file is missing`);
    }
  }
  return { files, owners };
}

const COMMIT = "{{upstream.commit}}";

function expander(commit, problems) {
  return (text, where) => {
    if (!text.includes(COMMIT)) return text;
    if (commit === undefined) { problems.push(`${where}: uses ${COMMIT}, but rules/manifest.json has no upstream checkout`); return text; }
    return text.replaceAll(COMMIT, commit);
  };
}

function applyTokens(files, owners, rules, expanders, problems) {
  const skillNames = [...files.keys()]
    .flatMap(path => /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.slice(1) ?? [])
    .sort().map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)";
  for (const rule of rules) {
    if (rule.source !== undefined && !expanders.has(rule.source)) {
      problems.push(`token rule ${rule.id}: unknown source "${rule.source}"`);
      continue;
    }
    const scope = rule.files ? new RegExp(rule.files) : undefined;
    const pattern = new RegExp(rule.find.replaceAll("{{skills.names}}", () => skillNames), `g${rule.flags ?? ""}`);
    let count = 0;
    for (const [path, text] of files) {
      if (typeof text !== "string" || (rule.source !== undefined && owners.get(path) !== rule.source) || (scope && !scope.test(path))) continue;
      const matches = text.match(pattern)?.length ?? 0;
      if (matches === 0) continue;
      count += matches;
      files.set(path, text.replace(pattern, expanders.get(owners.get(path))(rule.replace, `token rule ${rule.id}`)));
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
    const replacement = expand(readFileSync(join(overlaysDir, overlay), "utf8"), `overlay ${overlay}`, file);
    lines.splice(section.start, section.end - section.start, ...replacement.trimEnd().split("\n"), "");
    files.set(file, lines.join("\n"));
  }
}

function addExtras(files, extraDir, executables) {
  for (const path of walk(extraDir)) {
    const output = path.split("\\").join("/");
    files.set(output, readFileSync(join(extraDir, path)));
    if (isExecutable(join(extraDir, path))) executables.add(output);
  }
}

function renderRegistry(files, { routes, chains }) {
  const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
  const link = target => `[${target}](${target.startsWith("playbooks/") ? `../poteto-mode/${target}` : `../${target}/SKILL.md`})`;
  const table = (title, columns, rows) => `# ${title}\n\n| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n${rows.map(row => `| ${row.map(cell).join(" | ")} |`).join("\n")}\n`;
  files.set("skills/p3stack-mode/references/routes.md", table("Routes", ["Request", "Grant", "Target"], routes.map(row => [row.request, row.grant, link(row.target)])));
  files.set("skills/p3stack-mode/references/chains.md", table("Chains", ["Id", "Playbook", "Anchor", "Position", "Skill", "When"], chains.map(row => [row.id, link(row.playbook), row.anchor, row.position, link(row.skill), row.when])));
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

function lintResources(packageDir, outDir, owners, sources) {
  const skills = join(outDir, "skills");
  const directories = readdirSync(skills, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && sources.includes(owners.get(`skills/${entry.name}/SKILL.md`)))
    .map(entry => join(skills, entry.name)).sort();
  if (!directories.length) throw new Error("No generated skills found; refusing an empty resource check.");
  try {
    execFileSync(process.execPath, [join(packageDir, "../../scripts/lint-skill/lint-skill.mjs"), "--resource-root", skills, ...directories], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`Staged skills failed lint-skill.\n${String(error.stdout ?? "")}\n${String(error.stderr ?? error.message)}`);
  }
}

export function generate({ packageDir, outDir }) {
  const rules = join(packageDir, "rules");
  const manifest = readJson(join(rules, "manifest.json")), sources = sourcesOf(manifest);
  const infos = sources.map(source => upstreamInfo(packageDir, source)).filter(Boolean);
  const registry = manifest.registry ? loadRegistry(packageDir, sources) : undefined;
  const problems = [], executables = new Set();
  const { files, owners } = collect(packageDir, sources, executables, problems, registry?.skills);
  const expanders = new Map(sources.map(source => [source.name, expander(infos.find(info => info.source === source.name)?.commit, problems)]));
  const expand = (text, where, path) => expanders.get(owners.get(path))(text, where);
  const upstream = new Map(files);
  applyTokens(files, owners, readJson(join(rules, "tokens.json"), []), expanders, problems);
  applySections(files, upstream, readJson(join(rules, "sections.json"), []), join(packageDir, "overlays"), expand, problems);
  if (registry) {
    for (const row of registry.skills.filter(row => row.action === "emit")) {
      const path = `skills/${row.name}/SKILL.md`, text = files.get(path);
      if (typeof text !== "string") { problems.push(`Registry skill ${row.name} is not mapped to ${path}`); continue; }
      const hidden = /^disable-model-invocation:\s*true\s*$/m.test(text);
      if (hidden === (row.invocation === "user")) continue;
      const visible = text.replace(/^disable-model-invocation:.*\n/gm, "");
      files.set(path, row.invocation === "user" ? visible.replace(/^---\n/, "---\ndisable-model-invocation: true\n") : visible);
    }
  }
  addExtras(files, join(packageDir, "extra"), executables);
  if (registry) renderRegistry(files, registry);
  if (problems.length) throw new Error(problems.join("\n"));
  writeFiles(files, executables, outDir);
  applyPatches(join(packageDir, "patches"), outDir, problems);
  if (problems.length) throw new Error(problems.join("\n"));
  // Patches are rewritten under the caller's umask; keep only the executable bit.
  for (const path of walk(outDir)) chmodSync(join(outDir, path), isExecutable(join(outDir, path)) ? 0o755 : 0o644);
  const lintProblems = [], checks = readJson(join(rules, "lint.json"), { deny: [] });
  lint(outDir, checks.deny, lintProblems);
  for (const { file, contains } of checks.require ?? []) {
    const text = existsSync(join(outDir, file)) ? readFileSync(join(outDir, file), "utf8") : "";
    for (const dependency of contains) if (!text.includes(dependency)) lintProblems.push(`${file}: lost ${dependency} dependency link`);
  }
  if (lintProblems.length) throw new Error(`Coupling lint: untranslated tokens or missing dependencies; add a rule, never edit the output.\n${lintProblems.join("\n")}`);
  const hostProblems = lintHosts(outDir);
  if (hostProblems.length) throw new Error(`Host lint failed. Keep tool names in the host map.\n${hostProblems.join("\n")}`);
  if (registry) checkRegistry({ packageDir, outDir, registry });
  if (checks.resources?.length) lintResources(packageDir, outDir, owners, checks.resources);
  return infos;
}

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
  const { name, version } = readJson(join(packageDir, vendor, "plugin.json"), {});
  const subtree = relative(upstream.checkout, vendor).split("\\").join("/");
  return { source: source.name, repository: upstream.repository, commit, subtree, name, version };
}

const pluginVersion = info => info.name && info.version ? ` ${info.name} ${info.version}` : "";
const pinOf = info => info && `${info.repository}@${info.commit}${pluginVersion(info)}`;

const README_PIN = /(<!-- p3stack:upstream -->)[\s\S]*?(<!-- \/p3stack:upstream -->)/g;
const readmePin = info =>
  `\`${info.repository}\` [\`${info.commit.slice(0, 7)}\`](https://github.com/${info.repository}/tree/${info.commit}${info.subtree ? `/${info.subtree}` : ""})${pluginVersion(info) ? `,${pluginVersion(info)}` : ""}`;
function pinnedReadme(text, infos) {
  return infos.length === 0 ? text : text.replace(README_PIN, (_, open, close) => `${open}${infos.map(readmePin).join("; ")}${close}`);
}

function gitlinkDrift(packageDir, source, info) {
  const checkout = join(packageDir, source.upstream.checkout);
  const superproject = execFileSync("git", ["-C", checkout, "rev-parse", "--show-superproject-working-tree"], { encoding: "utf8", env: gitEnv() }).trim();
  if (!superproject) return [];
  const staged = execFileSync("git", ["-C", superproject, "ls-files", "--stage", "--", relative(superproject, checkout)], { encoding: "utf8", env: gitEnv() }).trim();
  const pin = /^160000 ([0-9a-f]+) 0\t/.exec(staged)?.[1];
  return pin === info.commit ? [] : [`${source.name}: checkout pin ${info.commit} differs from gitlink ${pin ?? "missing"}`];
}

const BACKUPS = ".backups";

export function installGenerated({ packageDir, outDir, copy = cpSync }) {
  const backupsDir = join(outDir, BACKUPS), changed = [];
  mkdirSync(backupsDir);
  try {
    for (const root of generatedRoots(packageDir)) {
      const destination = join(packageDir, root);
      const backup = existsSync(destination) || isLink(destination) ? join(backupsDir, root) : undefined;
      if (backup) renameSync(destination, backup);
      changed.push({ destination, backup });
      if (existsSync(join(outDir, root))) copy(join(outDir, root), destination, { recursive: true });
    }
  } catch (error) {
    const failures = [];
    for (const { destination, backup } of changed.reverse()) {
      try {
        rmSync(destination, { recursive: true, force: true });
        if (backup) renameSync(backup, destination);
      } catch (restoreError) { failures.push(`${destination}: ${restoreError.message}`); }
    }
    if (failures.length) throw new Error(`${error.message}\n${failures.join("\n")}\nrecovery copies retained at ${backupsDir}`, { cause: error });
    rmSync(backupsDir, { recursive: true, force: true });
    throw error;
  }
  rmSync(backupsDir, { recursive: true, force: true });
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node generator/generate.mjs [--check]");
    return 2;
  }
  const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const stagingParent = args[0] === "--check" ? tmpdir() : packageDir;
  const outDir = mkdtempSync(join(stagingParent, ".p3stack-"));
  try {
    const infos = generate({ packageDir, outDir });
    const sources = readJson(join(packageDir, "rules/manifest.json")).sources;
    const pin = pinOf(infos.find(info => info.source === "cursor-plugins")), manifestPath = join(packageDir, "package.json");
    const readmePath = join(packageDir, "README.md"), readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;
    if (args[0] === "--check") {
      const problems = drift(packageDir, outDir);
      const recorded = pin === undefined ? undefined : readJson(manifestPath).p3stack?.upstream;
      if (recorded !== pin) problems.push(`package.json p3stack.upstream is "${recorded}", expected "${pin}"`);
      for (const info of infos) problems.push(...gitlinkDrift(packageDir, sources.find(source => source.name === info.source), info));
      if (readme !== undefined && infos.length) {
        if ([...readme.matchAll(README_PIN)].length !== 1) problems.push("README.md: expected one pair of p3stack:upstream pin markers");
        else if (pinnedReadme(readme, infos) !== readme) problems.push(`README.md: the upstream pins for ${infos.map(info => info.source).join(", ")} between the p3stack:upstream markers are stale`);
      }
      if (problems.length === 0) {
        const paths = walk(outDir);
        console.log(`Generated output is current. ${paths.length} files, ${paths.reduce((bytes, path) => bytes + statSync(join(outDir, path)).size, 0)} bytes.`);
        return 0;
      }
      console.error(`Generated output differs from a fresh generation. Run node generator/generate.mjs.\n  ${problems.join("\n  ")}`);
      return 1;
    }
    installGenerated({ packageDir, outDir });
    if (pin !== undefined) {
      const manifest = readJson(manifestPath);
      manifest.p3stack = { ...manifest.p3stack, upstream: pin };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    if (readme !== undefined && pinnedReadme(readme, infos) !== readme) writeFileSync(readmePath, pinnedReadme(readme, infos));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    if (!existsSync(join(outDir, BACKUPS))) rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
