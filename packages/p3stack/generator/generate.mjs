#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAt, gitEnv, requireCleanCheckout } from "./git-env.mjs";
import { chainSlots, checkRegistry, frontmatterBlock, loadRegistry, skillFrontmatter, targetPath } from "./check-registry.mjs";
import { lintHosts } from "./lint-hosts.mjs";
import { BUDGETS, rolesFor } from "../extensions/p3stack/src/role-definitions.ts";
import { byName, isLink, referenceMoves, referencePath, sourcePathClassifier, sourcesOf, walk } from "./source-paths.mjs";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot load ${path}: ${error.message}`, { cause: error }); }
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

// Rewrite only visible Markdown text and inline command spans. Source offsets
// preserve fence contents, raw HTML, link destinations and all original bytes around them.
function mapProse(text, pattern, rewrite, skipped) {
  let result = "", offset = 0;
  function visit(node) {
    if (node.type === "text" || node.type === "inlineCode") {
      const { start, end } = node.position;
      result += text.slice(offset, start.offset);
      offset = start.offset;
      // The Markdown node may contain only `/name`; its HTTP method or shell
      // command can be in the preceding node. Consult the document at the match.
      for (const hit of text.slice(start.offset, end.offset).matchAll(pattern)) {
        const at = start.offset + hit.index, next = at + hit[0].length;
        if (!pathOperand(text.slice(0, at), text.slice(next))) continue;
        skipped?.(hit[0], at);
        result += rewrite(text.slice(offset, at)) + hit[0];
        offset = next;
      }
      result += rewrite(text.slice(offset, end.offset));
      offset = end.offset;
    } else node.children?.forEach(visit);
  }
  visit(fromMarkdown(text));
  return result + text.slice(offset);
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
      if (!text.match(pattern)) continue;
      const replacement = expanders.get(owners.get(path))(rule.replace, `token rule ${rule.id}`);
      const rewrite = (input, tally = false) => {
        const replace = span => {
          if (tally) count += span.match(pattern)?.length ?? 0;
          return span.replace(pattern, replacement);
        };
        if (rule.frontmatter) {
          const header = frontmatterBlock(input)?.[0];
          return header ? replace(header) + input.slice(header.length) : input;
        }
        if (!rule.markdownProse) return replace(input);
        return mapProse(input, pattern, replace, tally ? (command, at) => {
          const accepted = rule.allowPaths?.some(({ file, text }) => {
            const i = text.indexOf(command);
            return file === path && i >= 0 && at >= i && input.startsWith(text, at - i);
          });
          if (!accepted) problems.push(`${path}:${input.slice(0, at).split("\n").length}: untranslated prose command ${command} (treated as a path)`);
        } : undefined);
      };
      files.set(path, rewrite(text, true));
      sectionRewrites.get(path)?.push(rewrite);
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
      const translated = sectionRewrites.get(file).reduce((span, rewrite) => rewrite(span), sectionText(raw.lines, original));
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

const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");

function renderRegistry(files, { routes, chains }, put) {
  for (const [playbook, rows] of Map.groupBy(chains, row => row.playbook)) {
    const path = `skills/poteto-mode/${playbook}`, text = files.get(path)?.toString() ?? "";
    if (text.includes("\r\n") && /(?<!\r)\n/.test(text)) throw new Error(`${path}: mixed line endings; normalize before inserting chain rows`);
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
  // Each row names both reads. A live eval showed a model going straight from the table to
  // the target when the poteto-mode read was stated only above the table.
  const table = ["| Request | Grant | Read in this order, or do |", "| --- | --- | --- |", ...routes.map(({ request, grant, target, action }) =>
    `| ${cell(request)} | ${cell(grant)} | ${typeof target === "string" ? `\`../poteto-mode/SKILL.md\`, then \`../${targetPath(target)}\`` : cell(action)} |`)];
  put("skills/p3stack-mode/SKILL.md", files.get(template).toString().replace("{{routes}}", () => table.join("\n")));
  files.delete(template);
}

function renderSetupExample(files) {
  const path = "skills/setup-pstack/SKILL.md", text = files.get(path);
  if (typeof text !== "string") return;
  const { name, level } = BUDGETS.find(budget => budget.name === "large");
  const roles = rolesFor(`example/code:${level}`, `example/judge:${level}`);
  files.set(path, text.replace("{{role-example}}", JSON.stringify({ host: "terminal", budget: `${name} (${level})`, roles }, null, 2))
    .replace("{{budget-options}}", BUDGETS.map(({ label }) => `- \`${label}\``).join("\n")));
}

// Keep both user-facing indexes in step with the registry, not a second catalog.
function renderCatalog(files, { skills, routes }, helpJobs) {
  const help = "skills/poteto-help/SKILL.md", mode = "skills/poteto-mode/SKILL.md";
  const grouped = Map.groupBy(skills.filter(row => row.action === "reference").sort(byName), row => row.owner);
  const labels = (owner, link) => [...new Set((grouped.get(owner) ?? []).map(row => {
    if (row.name.startsWith("principle-") && owner === "poteto-mode") return link ? "[principle-*](../poteto-mode/SKILL.md#principles)" : "principle-*";
    return link ? `[${row.name}](../${referencePath(row)})` : row.name;
  }))].join(", ");
  const modeText = files.get(mode)?.toString();
  if (modeText?.includes("{{reference-index}}")) {
    const owners = [...grouped.keys()].sort().map(owner => `${owner} (${labels(owner, false)})`);
    files.set(mode, modeText.replace("{{reference-index}}", () => owners.join("; ")));
  }
  const helpText = files.get(help)?.toString();
  if (helpText?.includes("{{skill-catalog}}")) {
    const command = name => `[\`${name === "p3stack-mode" ? "/p3stack on" : `/skill:${name}`}\`](../${name}/SKILL.md)`;
    const table = ["| Request | What to type or ask for |", "| --- | --- |"];
    for (const { request, grant, target } of routes) {
      const setting = grant === "any" ? "" : ` (router: ${grant === "full-autonomy" ? "autonomous" : "default"})`;
      let next = "Ask directly; no skill needed.";
      if (target && !target.includes("/")) next = command(target);
      else if (target) {
        const label = posix.basename(target, ".md"), path = targetPath(target), link = `[${label}](../${path})`;
        // The skill that holds a playbook loads it with routing off; a bare playbook name loads nothing.
        // No link: the skill linter would read the playbook's own links as the help skill's.
        next = target.includes("/references/") ? `${command(target.split("/")[0])} using ${link}` : `\`/skill:${path.split("/")[0]} use the ${label} playbook\``;
      }
      table.push(`| ${cell(request)} | ${next}${setting} |`);
    }
    table.push("", "### Other standalone jobs", "");
    const routed = new Set(routes.map(row => row.target));
    for (const { name } of skills.filter(row => row.action === "emit" && !routed.has(row.name)).sort(byName)) {
      const path = `${name}/SKILL.md`, { description } = skillFrontmatter(files.get(`skills/${path}`).toString(), path);
      const job = helpJobs[name] ?? description.split(/(?<=[.!?])\s+/)[0].replace(/\.$/, "");
      table.push(`- ${job} — ${command(name)}`);
    }
    table.push("", "### References by owner", "", "Ask the owner for the named procedure. For a decision log, ask to read the reference itself.", "");
    for (const owner of [...grouped.keys()].sort()) table.push(`- [${owner}](../${owner}/SKILL.md): ${labels(owner, true)}`);
    files.set(help, helpText.replace("{{skill-catalog}}", () => table.join("\n")));
  }
}

// Roots replaced wholesale by installGenerated, even if a source stops supplying one.
const GENERATED_ROOTS = ["LICENSE", "LICENSE-agent-skills", "LICENSE-dyl-stack", "LICENSE-matt-pocock", "LICENSE-superpowers", "LICENSE-thermos", "agents", "skills"];

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
      const apply = ["-c", "core.autocrlf=false", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"];
      const options = { cwd: outDir, stdio: "pipe", env: gitEnv() };
      execFileSync("git", [...apply, "--check", patch], options);
      execFileSync("git", [...apply, patch], options);
    } catch (error) {
      problems.push(`patch ${name} no longer applies; rebase it: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function referenceBody(text, path, name) {
  const { description, name: declared } = skillFrontmatter(text, path);
  if (declared !== name || typeof description !== "string" || !description.trim()) throw new Error(`${path}: reference needs its registered name and description`);
  const body = text.slice(frontmatterBlock(text)[0].length).replace(/^(?:\r?\n)+/, "");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const heading = fromMarkdown(body).children.find(node => node.type === "heading" && node.depth === 1);
  const title = heading ? body.slice(heading.position.start.offset, heading.position.end.offset) : `# ${name}`;
  const rest = heading ? body.slice(0, heading.position.start.offset) + body.slice(heading.position.end.offset) : body;
  const ownCommand = new RegExp(`(?<![\\w./-])/(?:skill:)?${escapeRegex(name)}(?![\\w/-])`);
  const offersTrigger = sentence => ownCommand.test(sentence) || /^Use when the user (?:says|asks|wants)\b/i.test(sentence) ||
    /^Use for\b/i.test(sentence) && (sentence.includes(name) || /["']|\bor\b/.test(sentence));
  const summary = description.trim().split(/(?<=[.!?])\s+/).filter(sentence => !offersTrigger(sentence)).join(" ");
  return [title, summary, rest.replace(/^(?:\r?\n)+/, "")].filter(Boolean).join(newline.repeat(2));
}

// Link whole names and command spans, not substrings of a shell command. Keep
// existing labels, headings and code examples intact when linking prose names.
function linkReferenceMentions(text, references, linkTo, output) {
  const edits = [];
  function visit(node, inLink = false, inHeading = false) {
    inLink ||= node.type === "link" || node.type === "linkReference";
    inHeading ||= node.type === "heading";
    const code = node.type === "inlineCode", command = code && node.value.startsWith("/skill:");
    const label = command ? node.value.slice(7) : code ? node.value : node.type === "strong" && node.children.length === 1 ? node.children[0].value : undefined;
    const ref = references.get(label), { start, end } = node.position ?? {};
    const suffix = ref && !command && /^(['’]s)? (?:principle )?skill(s?)\b/.exec(text.slice(end.offset));
    // A one-word name in bold is also plain emphasis: "**implement** it" names no skill.
    if (ref && (command ? ref.name === label : !inLink && !inHeading && (code || suffix || label.includes("-")))) {
      const target = `skills/${referencePath(ref)}`;
      const link = `[${label}](${linkTo(target)})`;
      edits.push([start.offset, end.offset + (suffix ? suffix[0].length : 0),
        command && (inLink || target === output) ? label : link + (suffix ? `${suffix[1] ?? ""} reference${suffix[2]}` : "")]);
    } else {
      // Inline HTML anchor tags are siblings of their label in mdast.
      let anchor = false;
      for (const child of node.children ?? []) {
        if (child.type === "html" && /^<a(?:\s[^<>]*)?>$/i.test(child.value)) anchor = true;
        if (child.type === "html" && /^<\/a\s*>$/i.test(child.value)) anchor = false;
        visit(child, inLink || anchor, inHeading);
      }
    }
  }
  const header = frontmatterBlock(text)?.[0] ?? "";
  text = text.slice(header.length);
  visit(fromMarkdown(text));
  for (const [start, end, replacement] of edits.reverse()) text = text.slice(0, start) + replacement + text.slice(end);
  return header + text;
}

const linkBase = path => path.startsWith("skills/") ? path.split("/").slice(0, 2).join("/") : posix.dirname(path);

// A link to the retired skill directory now opens the reference, even when
// there are no companion files. Links to subdirectories keep browsing them.
function resourceTargets(moves) {
  const targets = new Map(moves);
  for (const [old, dest] of moves) {
    const root = linkBase(old);
    if (old === `${root}/SKILL.md`) targets.set(root, dest);
    for (let dir = posix.dirname(old), to = posix.dirname(dest); dir !== root; dir = posix.dirname(dir), to = posix.dirname(to)) {
      targets.set(dir, to);
    }
  }
  return targets;
}

function rebaseResources(text, path, output, moves, targets, linkTo) {
  const before = linkBase(path), aliases = new Map(), own = [];
  for (const [old, dest] of moves) {
    const operand = posix.relative(before, old), replacement = linkTo(dest);
    aliases.set(operand, replacement);
    if (old.startsWith(before + "/")) {
      const qualified = "../" + old.slice("skills/".length);
      aliases.set("./" + operand, replacement);
      aliases.set(qualified, replacement);
      own.push("./" + operand, qualified, old);
      if (operand !== "SKILL.md") own.push(operand); // the bare name also denotes Pi's convention
    }
  }
  if (path !== output) {
    for (const dir of targets.keys()) {
      if (moves.has(dir) || linkBase(dir) !== before) continue;
      own.push(`../${dir.slice("skills/".length)}/`, `${dir}/`);
      if (dir !== before) own.push(posix.relative(before, dir) + "/", "./" + posix.relative(before, dir) + "/");
    }
  }
  const alternatives = keys => [...keys].map(escapeRegex).join("|");
  const operands = new RegExp("(?<![^\\s`(<'\"])" + `(${alternatives(aliases.keys())})(:\\d+)?` + "(?=$|[\\s`)>#?'\",;]|[.!](?!\\w))", "g");
  const stale = own.length && new RegExp(`(?<![\\w./-])(?:${alternatives(own)})(?![\\w/-]|\\.\\w)`, "g");
  const edits = [];
  function guard(span, start, type, language) {
    if (!stale) return;
    for (const bad of span.matchAll(stale)) {
      const operand = bad[0], prefix = span.slice(span.lastIndexOf("\n", bad.index - 1) + 1, bad.index);
      const qualified = operand.startsWith("../") || operand.startsWith(before + "/");
      const address = /(?:\]\(\s*<?|(?:href|src|--[\w-]+)=)["']?$/i.test(prefix);
      // "Keep scripts/ small" doesn't address a directory. An href to scripts/ does.
      if (operand.endsWith("/") && !qualified && !address && type !== "destination") continue;
      // A shell output operand or a cell in an example log is consumer data. Keep
      // checking inputs even to unfamiliar commands, and all qualified addresses.
      const sampleData = />[ \t]*["']?$/.test(prefix) || ["csv", "tsv"].includes(language) || prefix.includes("\t") && !language;
      if (type === "code" && !qualified && !address && sampleData) continue;
      const line = text.slice(0, start).split("\n").length + span.slice(0, bad.index).split("\n").length - 1;
      throw new Error(`${output}:${line}: unrebased resource path ${operand}`);
    }
  }
  function visit(node) {
    const { start, end } = node.position, span = text.slice(start.offset, end.offset);
    if (typeof node.url === "string") {
      if (/^(?:[a-z][a-z\d+.-]*:\/\/|[/?#])/i.test(node.url)) return;
      const [, operand, line, fragment = ""] = /^([^?#]+?)(?::(\d+))?([?#].*)?$/.exec(node.url) ?? [];
      const target = operand && targets.get(posix.join(before, operand).replace(/\/$/, ""));
      if (target) {
        // Start after the label: it can contain the same filename as the URL.
        const labelEnd = node.children?.at(-1)?.position.end.offset ?? start.offset;
        const delimiter = /\](?:\(\s*|:\s*)<?/.exec(text.slice(labelEnd, end.offset));
        const at = delimiter && labelEnd + delimiter.index + delimiter[0].length;
        if (at && text.startsWith(node.url, at)) edits.push([at, at + node.url.length, linkTo(target) + (line ? `#L${line}` : fragment)]);
        else guard(span, start.offset);
      } else guard(node.url, start.offset, "destination");
      return; // link labels and titles are not operands
    }
    if (node.type === "linkReference" || node.type === "imageReference") return;
    if (node.children) return node.children.forEach(visit);
    const rewritten = node.type === "inlineCode" || node.type === "text" ? span.replace(operands, (match, operand, line) =>
      (line || operand !== "SKILL.md") ? aliases.get(operand) + (line ?? "") : match) : span;
    guard(rewritten, start.offset, node.type, node.lang);
    if (rewritten !== span) edits.push([start.offset, end.offset, rewritten]);
  }
  if (path.endsWith(".md")) visit(fromMarkdown(text));
  else guard(text, 0);
  for (const [start, end, replacement] of edits.reverse()) text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}

function relocateReferences(outDir, skills, owners) {
  const paths = walk(outDir).map(path => path.split(sep).join("/")), moves = referenceMoves(paths, skills);
  if (!moves.size) return;
  const targets = resourceTargets(moves);
  const references = new Map(skills.filter(row => row.action === "reference").flatMap(row =>
    row.name.startsWith("principle-") ? [[row.name, row], [row.name.slice("principle-".length), row]] : [[row.name, row]]));
  for (const path of paths) {
    const output = moves.get(path) ?? path, oldFile = join(outDir, path), file = join(outDir, output);
    const before = linkBase(path), after = linkBase(output);
    // Playbooks and references can be read from a sibling skill. Qualify
    // their links so they resolve from either that reader or the owner.
    const shared = output.startsWith("skills/") && output !== `${after}/SKILL.md`;
    const linkTo = dest => shared ? "../" + dest.slice("skills/".length) : posix.relative(after, dest);
    const contents = decode(readFileSync(oldFile));
    if (file !== oldFile) {
      mkdirSync(dirname(file), { recursive: true });
      renameSync(oldFile, file); // also preserves the mode and binary resources
    }
    if (contents === undefined) continue;
    let text = contents;
    if (path !== output && path.endsWith("/SKILL.md")) {
      text = referenceBody(text, path, posix.basename(before));
    }
    text = rebaseResources(text, path, output, moves, targets, linkTo);
    if (owners.has(path) && !["extra", "authored", "registry"].includes(owners.get(path)) && path.endsWith(".md")) {
      text = linkReferenceMentions(text, references, linkTo, output);
    }
    if (text !== contents) writeFileSync(file, text);
  }
  for (const { name } of skills.filter(row => row.action === "reference")) rmSync(join(outDir, "skills", name), { recursive: true, force: true });
}

export function removedCommandPattern(skills) {
  const emitted = new Set(skills.filter(row => row.action === "emit").map(row => row.name));
  const names = skills.map(row => row.name ?? posix.basename(posix.dirname(row.path))).filter(name => !emitted.has(name));
  if (!names.length) return undefined;
  // A whole command token, not a segment of a URL, route or filename.
  return new RegExp(`(?:/skill:|(?<![\\w./:-])(?<!\\][(:][ \\t]*<?)/)(?:${[...new Set(names)].map(escapeRegex).join("|")})(?![\\w/-]|[.?#][\\w/])`, "g");
}

// Bare /name is also a valid HTTP or filesystem operand, even inside an example.
function pathOperand(before, after) {
  const prefix = before.replace(/[`*"']+$/, ""), suffix = after.replace(/^[`*"']+/, "");
  return /\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)[ \t]+$/.test(prefix) ||
    /\b(?:cd|pushd|ls|cat|mkdir|curl)(?:[ \t]+-[\w-]*)*[ \t]+$/.test(prefix) ||
    /\b(?:route|endpoint|path|directory|mount(?:ed)?)(?: (?:at|under|to|is))?[ \t]+$/i.test(prefix) ||
    /^(?:[ \t]+HTTP\/\d|[ \t]+(?:endpoint|directory|route)\b)/i.test(suffix) ||
    /(?:\]\(\s*<?|\b(?:href|src)\s*=\s*)$/i.test(prefix);
}

function* bareCommands(line, names) {
  if (!names.size) return;
  for (const hit of line.matchAll(/(?<![\w./:-])\/([\w-]+)(?![\w/-]|[.?#][\w/])/g)) {
    if (names.has(hit[1]) && !pathOperand(line.slice(0, hit.index), line.slice(hit.index + hit[0].length))) yield hit[0];
  }
}

function lintFencedCommands(text, path, names, problems) {
  function visit(node) {
    if (node.type !== "code") return node.children?.forEach(visit);
    const start = node.position.start;
    const fenced = /^(?:`{3,}|~{3,})/.test(text.slice(start.offset));
    node.value.split("\n").forEach((line, i) => {
      for (const command of bareCommands(line, names)) problems.push(`${path}:${start.line + Number(fenced) + i}: untranslated fenced command ${command}`);
    });
  }
  visit(fromMarkdown(text));
}

function lint(outDir, checks, problems, skills) {
  const removed = skills && removedCommandPattern(skills), deniedCommands = new Set(checks.denyCommands);
  const upstream = new Set(skills?.filter(row => row.source !== "p3stack").flatMap(row => [row.name, posix.basename(posix.dirname(row.path))]));
  for (const path of walk(outDir)) {
    const text = decode(readFileSync(join(outDir, path)));
    if (text === undefined) continue;
    if (upstream.size && path.endsWith(".md")) lintFencedCommands(text, path, upstream, problems);
    text.split("\n").forEach((line, index) => {
      for (const hit of removed ? line.matchAll(removed) : []) {
        if (hit[0].startsWith("/skill:") || !pathOperand(line.slice(0, hit.index), line.slice(hit.index + hit[0].length))) {
          problems.push(`${path}:${index + 1}: removed skill command ${hit[0]}`);
        }
      }
      for (const command of bareCommands(line, deniedCommands)) problems.push(`${path}:${index + 1}: ${command}`);
      for (const token of checks.deny) if (line.includes(token)) problems.push(`${path}:${index + 1}: ${token}`);
    });
  }
}

function lintResources(packageDir, outDir) {
  const skills = join(outDir, "skills");
  const directories = readdirSync(skills, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(skills, entry.name, "SKILL.md")))
    .map(entry => join(skills, entry.name)).sort();
  if (!directories.length) throw new Error("No generated skills found; refusing an empty resource check.");
  try {
    const report = execFileSync(process.execPath, [join(packageDir, "../../scripts/lint-skill/lint-skill.mjs"), "--resource-root", skills, ...directories], { encoding: "utf8" });
    // Keep warnings visible without listing every resolved dependency.
    process.stdout.write(report.split("\n").filter(line => !/^\s+(exists|Dependencies:)/.test(line)).join("\n"));
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
    for (const row of registry.skills.filter(row => row.action !== "drop" && row.source !== "p3stack")) {
      const path = `skills/${row.name}/SKILL.md`, text = files.get(path);
      if (typeof text !== "string") { problems.push(`Registry skill ${row.name} is not mapped to ${path}`); continue; }
      files.set(path, skillFrontmatter(text, path).withRegistry(row));
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
  if (registry) renderCatalog(files, registry, readJson(join(rules, "help-jobs.json"), {}));
  renderSetupExample(files);
  writeFiles(files, executables, outDir);
  applyPatches(join(packageDir, "patches"), outDir, problems);
  if (problems.length) throw new Error(problems.join("\n"));
  if (registry) relocateReferences(outDir, registry.skills, owners);
  // Patches are rewritten under the caller's umask; keep only the executable bit.
  for (const path of walk(outDir)) {
    checkOutputPath(path.split(sep).join("/"));
    chmodSync(join(outDir, path), isExecutable(join(outDir, path)) ? 0o755 : 0o644);
  }
  const lintProblems = [], checks = readJson(join(rules, "lint.json"), { deny: [] });
  lint(outDir, checks, lintProblems, registry?.skills);
  for (const { file, contains } of checks.require ?? []) {
    const text = existsSync(join(outDir, file)) ? readFileSync(join(outDir, file), "utf8") : "";
    for (const dependency of contains) if (!text.includes(dependency)) lintProblems.push(`${file}: lost ${dependency} dependency link`);
  }
  if (lintProblems.length) throw new Error(`Coupling lint: untranslated tokens or missing dependencies; add a rule, never edit the output.\n${lintProblems.join("\n")}`);
  const hostProblems = lintHosts(outDir);
  if (hostProblems.length) throw new Error(`Host lint failed. Keep tool names in the host map.\n${hostProblems.join("\n")}`);
  if (registry) checkRegistry({ packageDir, outDir, registry });
  if (checks.resources) lintResources(packageDir, outDir);
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
