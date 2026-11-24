#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAt, gitEnv, requireCleanCheckout } from "./git-env.mjs";
import { chainSlots, checkRegistry, frontmatterBlock, loadRegistry, skillFrontmatter, targetPath } from "./check-registry.mjs";
import { lintHosts } from "./lint-hosts.mjs";
import { sourcePathClassifier, sourcesOf } from "./source-paths.mjs";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot load ${path}: ${error.message}`, { cause: error }); }
}

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

function applyTokens(files, owners, rules, expanders, problems, sectionRewrites) {
  const skillNames = [...files.keys()]
    .flatMap(path => /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.slice(1) ?? [])
    .sort().map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)";
  for (const rule of rules) {
    if (rule.source !== undefined && !expanders.has(rule.source)) {
      problems.push(`token rule ${rule.id}: unknown source "${rule.source}"`);
      continue;
    }
    let scope, pattern;
    try {
      scope = rule.files ? new RegExp(rule.files) : undefined;
      pattern = new RegExp(rule.find.replaceAll("{{skills.names}}", () => skillNames), `g${rule.flags ?? ""}`);
    } catch (error) {
      problems.push(`rules/tokens.json: token rule ${rule.id}: ${error.message}`);
      continue;
    }
    let count = 0;
    for (const [path, text] of files) {
      if (typeof text !== "string" || (rule.source !== undefined && owners.get(path) !== rule.source) || (scope && !scope.test(path))) continue;
      const matches = text.match(pattern)?.length ?? 0;
      if (matches === 0) continue;
      count += matches;
      const replacement = expanders.get(owners.get(path))(rule.replace, `token rule ${rule.id}`);
      files.set(path, text.replace(pattern, replacement));
      sectionRewrites.get(path)?.push([pattern, replacement]);
    }
    if (count < (rule.min ?? 0)) problems.push(`token rule ${rule.id}: ${count} matches, expected at least ${rule.min} after earlier token rewrites (source: ${rule.source ?? "all sources"}; files: ${rule.files ?? "all files"}). Review its scope and upstream text.`);
  }
}

const { fromMarkdown } = createRequire(new URL("../../../scripts/lint-skill/package.json", import.meta.url))("mdast-util-from-markdown");

function sectionView(text) {
  const lines = text.split("\n"), header = frontmatterBlock(text)?.[0] ?? "";
  const offset = header.split("\n").length - 1;
  // Only document headings delimit an overlay, not examples in fences or blockquotes.
  const headings = fromMarkdown(text.slice(header.length)).children.filter(node => node.type === "heading").map(node => {
    const start = offset + node.position.start.line - 1, last = offset + node.position.end.line - 1;
    // For Setext headings the rule names the title, without the underline.
    const title = lines.slice(start, Math.max(start + 1, last)).join("\n").replace(/\r$/gm, "");
    return { start, title, level: node.depth };
  });
  return { lines, headings };
}

function findSection({ lines, headings }, title) {
  const matches = headings.filter(node => node.title === title);
  if (matches.length !== 1) return { error: matches.length ? `found ${matches.length} times` : "not found" };
  const [{ start, level }] = matches, children = [];
  for (const next of headings) {
    if (next.start <= start) continue;
    if (next.level <= level) return { start, end: next.start, children };
    children.push(next.title);
  }
  return { start, end: lines.length, children };
}

function sectionText(lines, { start, end }) {
  return lines.slice(start, end).join("\n") + (end < lines.length ? "\n" : "");
}

function hashSection(lines, section) {
  const body = sectionText(lines, section).trimEnd() + "\n";
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

// Hash the untranslated section, never its rewritten text.
export function sectionHash(text, heading) {
  const view = sectionView(text), section = findSection(view, heading);
  return section.error ? undefined : hashSection(view.lines, section);
}

function applySections(files, upstream, sections, sectionRewrites, overlaysDir, expand, problems) {
  for (const [file, rules] of Map.groupBy(sections, rule => rule.file)) {
    const text = files.get(file);
    if (typeof text !== "string") { problems.push(`section rule: ${file} is not an emitted text file`); continue; }
    const raw = sectionView(upstream.get(file)), rewritten = sectionView(text), edits = [];
    for (const { heading, upstreamHeading = heading, overlay, upstream: expected } of rules) {
      const section = findSection(rewritten, heading);
      if (section.error) { problems.push(`section rule: ${file}: heading "${heading}" ${section.error} after token rewrites.`); continue; }
      const original = findSection(raw, upstreamHeading);
      if (original.error) { problems.push(`section rule: ${file}: upstream heading "${upstreamHeading}" ${original.error}.`); continue; }
      const children = [...new Set([...original.children, ...section.children])];
      if (children.length) {
        const listed = children.map(line => `"${line}"`).join(", ");
        problems.push(`section rule: ${file}: "${heading}" is not a leaf; it contains ${listed}. Replace each child. Put text before the first child in a token anchored on "${heading}". A sibling with no rule is emitted.`);
        continue;
      }
      const actual = hashSection(raw.lines, original);
      if (!/^[0-9a-f]{12}$/.test(expected ?? "")) {
        problems.push(`section rule: ${file}: "${heading}": expected a 12-digit upstream hash. Review the overlay against the raw section (hash ${actual}).`);
        continue;
      }
      if (actual !== expected) {
        problems.push(`section rule: ${file}: section "${heading}" changed upstream (was ${expected}, now ${actual}). Review the overlay, then update its hash.`);
        continue;
      }
      // A sibling can also disappear without becoming a child. Replace only the
      // translation of the raw span we hashed, not surrounding unreviewed text.
      const translated = sectionRewrites.get(file).reduce((span, [pattern, replacement]) => span.replace(pattern, replacement), sectionText(raw.lines, original));
      if (translated !== sectionText(rewritten.lines, section)) {
        problems.push(`section rule: ${file}: "${heading}" changed boundary during token rewrites. Keep each rewrite inside or outside the reviewed section.`);
        continue;
      }
      if (edits.some(edit => edit.start === section.start)) { problems.push(`Duplicate section rule: ${file}: "${heading}"`); continue; }
      const replacement = expand(readFileSync(join(overlaysDir, overlay), "utf8"), `overlay ${overlay}`, file);
      edits.push({ ...section, replacement });
    }
    // All offsets refer to the same after-tokens view, never to an earlier overlay's text.
    for (const { start, end, replacement } of edits.sort((a, b) => b.start - a.start)) {
      rewritten.lines.splice(start, end - start, ...replacement.trimEnd().split("\n"), "");
    }
    files.set(file, rewritten.lines.join("\n"));
  }
}

function addExtras(dir, put) {
  for (const path of walk(dir)) {
    const input = join(dir, path);
    put(path.split("\\").join("/"), readFileSync(input), isExecutable(input));
  }
}

function renderRegistry(files, { routes, chains }, put) {
  for (const [playbook, rows] of Map.groupBy(chains, row => row.playbook)) {
    const path = `skills/poteto-mode/${playbook}`, text = files.get(path)?.toString() ?? "";
    const slots = chainSlots(text, rows), newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(newline);
    // Splice backwards so a new step never becomes an anchor or shifts a later slot.
    for (const [line, steps] of [...slots].sort(([a], [b]) => b - a)) {
      const notes = steps.map(({ skill, when }) => {
        // A playbook can also be reached from a sibling skill. Keep the link valid from either skill root.
        return `> **p3stack only:** [${posix.basename(skill, ".md")}](../${targetPath(skill)}) — ${when}`;
      });
      const before = lines[line - 1]?.trim() ? [""] : [], after = lines[line]?.trim() ? [""] : [];
      lines.splice(line, 0, ...before, notes.join(newline + newline), ...after);
    }
    files.set(path, lines.join(newline));
  }
  const template = "skills/p3stack-mode/SKILL.md.tmpl";
  if (!files.has(template)) return;
  const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
  const table = ["| Request | Grant | Read |", "| --- | --- | --- |", ...routes.map(({ request, grant, target }) =>
    `| ${cell(request)} | ${cell(grant)} | \`${targetPath(target)}\` |`)];
  put("skills/p3stack-mode/SKILL.md", files.get(template).toString().replace("{{routes}}", () => table.join("\n")));
  files.delete(template);
}

// Roots replaced wholesale by installGenerated, even if a source stops supplying one.
const GENERATED_ROOTS = ["LICENSE", "LICENSE-agent-skills", "LICENSE-matt-pocock", "LICENSE-superpowers", "agents", "skills"];

function checkOutputPath(path) {
  const parts = path.split("/");
  if (!GENERATED_ROOTS.includes(parts[0]) || path.includes("\\") || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error(`${path}: not an installed output path. Move it to a slash-separated path under a generated root, or explicitly declare its root in GENERATED_ROOTS.`);
  }
}

function writeFiles(files, executables, outDir) {
  for (const [path, contents] of files) {
    checkOutputPath(path);
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), contents);
    chmodSync(join(outDir, path), executables.has(path) ? 0o755 : 0o644);
  }
}

function applyPatches(patchesDir, outDir, problems) {
  for (const name of walk(patchesDir).filter(file => file.endsWith(".patch"))) {
    const patch = join(patchesDir, name);
    try {
      const apply = ["-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"];
      const options = { cwd: outDir, stdio: "pipe", env: gitEnv() };
      execFileSync("git", [...apply, "--check", patch], options);
      execFileSync("git", [...apply, patch], options);
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
  const sections = readJson(join(rules, "sections.json"), []);
  const sectionRewrites = new Map(sections.map(({ file }) => [file, []]));
  applyTokens(files, owners, readJson(join(rules, "tokens.json"), []), expanders, problems, sectionRewrites);
  applySections(files, upstream, sections, sectionRewrites, join(packageDir, "overlays"), expand, problems);
  if (registry) {
    for (const row of registry.skills.filter(row => row.action === "emit" && row.source !== "p3stack")) {
      const path = `skills/${row.name}/SKILL.md`, text = files.get(path);
      if (typeof text !== "string") { problems.push(`Registry skill ${row.name} is not mapped to ${path}`); continue; }
      files.set(path, skillFrontmatter(text, path).withInvocation(row.invocation === "user"));
    }
  }
  const put = by => (path, contents, executable = false) => {
    const from = owners.get(path);
    if (from !== undefined && !manifest.overwrites?.some(rule => rule.file === path && rule.from === from && rule.by === by)) {
      problems.push(`${path}: ${from} and ${by} both emit this path. Remove the duplicate or declare {file, from, by} in rules/manifest.json overwrites.`);
      return;
    }
    files.set(path, contents);
    owners.set(path, by);
    if (executable) executables.add(path);
    else executables.delete(path);
  };
  for (const dir of ["extra", "authored"]) addExtras(join(packageDir, dir), put(dir));
  if (registry) renderRegistry(files, registry, put("registry"));
  if (problems.length) throw new Error(problems.join("\n"));
  writeFiles(files, executables, outDir);
  applyPatches(join(packageDir, "patches"), outDir, problems);
  if (problems.length) throw new Error(problems.join("\n"));
  // Patches are rewritten under the caller's umask; keep only the executable bit.
  for (const path of walk(outDir)) {
    checkOutputPath(path.split(sep).join("/"));
    chmodSync(join(outDir, path), isExecutable(join(outDir, path)) ? 0o755 : 0o644);
  }
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

function drift(packageDir, outDir) {
  const problems = [];
  for (const root of GENERATED_ROOTS) {
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
  requireCleanCheckout(checkout, relative(checkout, join(packageDir, vendor)) || ".");
  const commit = gitAt(checkout, "rev-parse", "HEAD");
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
    for (const root of GENERATED_ROOTS) {
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
      const gitlinks = infos.flatMap(info => gitlinkDrift(packageDir, sources.find(source => source.name === info.source), info));
      if (readme !== undefined && infos.length) {
        if ([...readme.matchAll(README_PIN)].length !== 1) problems.push("README.md: expected one pair of p3stack:upstream pin markers");
        else if (pinnedReadme(readme, infos) !== readme) problems.push(`README.md: the upstream pins for ${infos.map(info => info.source).join(", ")} between the p3stack:upstream markers are stale`);
      }
      if (!gitlinks.length && !problems.length) {
        const paths = walk(outDir);
        console.log(`Generated output is current. ${paths.length} files, ${paths.reduce((bytes, path) => bytes + statSync(join(outDir, path)).size, 0)} bytes.`);
        return 0;
      }
      if (gitlinks.length) console.error(`${gitlinks.join("\n")}\nConfirm the intended ref first. Restore the checkout to the staged pin, or stage the candidate gitlink if that update was authorized.`);
      if (problems.length) console.error(`Generated output differs from a fresh generation. Run node generator/generate.mjs after confirming the pins.\n  ${problems.join("\n  ")}`);
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
