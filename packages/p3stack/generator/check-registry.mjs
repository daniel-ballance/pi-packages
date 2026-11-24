#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceMoves, referencePath, sourcePathClassifier, sourcesOf, walk } from "./source-paths.mjs";

const json = path => JSON.parse(readFileSync(path, "utf8"));
const key = row => `${row.source}/${row.path}`;
// Registry targets resolve from skills/: a skill name, a poteto playbook shorthand, or a qualified file.
export const targetPath = target => target.startsWith("playbooks/") ? `poteto-mode/${target}` : target.includes("/") ? target : `${target}/SKILL.md`;
const { fromMarkdown } = createRequire(new URL("../../../scripts/lint-skill/package.json", import.meta.url))("mdast-util-from-markdown");

// Resolve every anchor against the same document. A prefix may omit the list marker,
// but must start a top-level step, never a later sentence, nested item, or example.
export function chainSlots(text, rows) {
  const steps = fromMarkdown(text).children.flatMap(node => node.type === "list" ? node.children : node.type === "paragraph" ? [node] : []);
  const slots = new Map();
  for (const row of rows) {
    const { id, anchor, position, playbook } = row;
    const count = typeof anchor === "string" && anchor.length ? text.split(anchor).length - 1 : 0;
    if (count !== 1) throw new Error(`Chain ${id} anchor occurs ${count} times in ${playbook}`);
    const at = text.indexOf(anchor);
    const step = steps.find(node => (at === node.position.start.offset ||
      (node.type === "listItem" && node.children[0]?.type === "paragraph" && at === node.children[0].position.start.offset)) &&
      at + anchor.length <= node.position.end.offset);
    if (!step) throw new Error(`Chain ${id} anchor must start a top-level step in ${playbook}: ${anchor}`);
    if (!["before", "after"].includes(position)) throw new Error(`Chain ${id} has invalid position ${position}`);
    const line = position === "before" ? step.position.start.line - 1 : step.position.end.line;
    if (!slots.has(line)) slots.set(line, []);
    slots.get(line).push(row);
  }
  return slots;
}

// Use the same workspace YAML parser as lint-skill, including under isolated pnpm installs.
const { isMap, parseDocument } = createRequire(new URL("../../../scripts/lint-skill/package.json", import.meta.url))("yaml");
const INVOCATION_FLAG = "disable-model-invocation";

export const frontmatterBlock = text => /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)^---[ \t]*\r?$/my.exec(text);

export function skillFrontmatter(text, path) {
  const header = frontmatterBlock(text);
  if (!header) throw new Error(`${path}: expected a leading --- frontmatter block`);
  const [, opening, yaml] = header, doc = parseDocument(yaml);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error(`${path}: invalid frontmatter: ${doc.errors[0]?.message ?? "expected a YAML mapping"}`);
  const fields = doc.toJS(); // Resolve scalar aliases; retain nodes only for source ranges.
  const flag = doc.get(INVOCATION_FLAG, true);
  if (flag && typeof fields[INVOCATION_FLAG] !== "boolean") throw new Error(`${path}: frontmatter ${INVOCATION_FLAG} must be a boolean`);
  const hidden = fields[INVOCATION_FLAG] === true;
  return {
    name: fields.name, description: fields.description, hidden,
    withInvocation(userOnly) {
      if (userOnly === hidden) return text;
      // Edit just the flag, preserving other fields, comments, newlines and the entire body.
      const at = opening.length;
      if (flag) return text.slice(0, at + flag.range[0]) + userOnly + text.slice(at + flag.range[1]);
      const start = doc.contents.range[0];
      const indent = yaml.slice(0, start).split("\n").at(-1);
      const offset = at + start + (doc.contents.flow ? 1 : 0);
      const newline = opening.endsWith("\r\n") ? "\r\n" : "\n";
      const insert = `${INVOCATION_FLAG}: true` + (doc.contents.flow ? ", " : newline + indent);
      return text.slice(0, offset) + insert + text.slice(offset);
    },
  };
}

function skillPaths(root, prefix = "", templates = false) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name;
    if (entry.isDirectory()) return skillPaths(join(root, entry.name), path + "/", templates);
    if (templates && entry.name === "SKILL.md.tmpl") return [path.slice(0, -5)];
    return entry.name === "SKILL.md" ? [path] : [];
  });
}

export function loadRegistry(packageDir, sources) {
  const skills = json(join(packageDir, "registry/skills.json"));
  const routes = json(join(packageDir, "registry/routes.json"));
  const chains = json(join(packageDir, "registry/chains.json"));
  const upstream = new Set(sources.flatMap(source => (source.skillRoots ?? ["skills/"]).flatMap(root =>
    skillPaths(join(packageDir, source.vendor, root)).map(path => `${source.name}/${root}${path}`))));
  for (const path of skillPaths(join(packageDir, "authored/skills"), "", true)) upstream.add(`p3stack/skills/${path}`);
  const rows = new Set(), names = new Set(), problems = [];
  for (const row of skills) {
    const id = key(row);
    if (rows.has(id)) problems.push(`Duplicate registry row ${id}`);
    rows.add(id);
    if (!upstream.has(id)) problems.push(row.source === "p3stack" ? `Missing authored skill authored/${row.path}` : `Stale registry row ${id}`);
    if (row.source === "p3stack" && row.action !== "drop" && row.path !== `skills/${row.name}/SKILL.md`) {
      problems.push(`Authored skill ${id} must emit at ${row.path}`);
    }
    if (typeof row.reason !== "string" || !row.reason.trim()) problems.push(`${id} needs a reason`);
    if (row.action === "drop") continue;
    if (!["emit", "reference"].includes(row.action)) { problems.push(`${id} has invalid action ${row.action}`); continue; }
    if (typeof row.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.name)) problems.push(`${id} has invalid emitted name ${row.name}`);
    if (names.has(row.name)) problems.push(`Duplicate emitted name ${row.name}`);
    names.add(row.name);
    if (row.action === "reference") continue;
    if (!["model", "user"].includes(row.invocation)) problems.push(`${id} has invalid invocation ${row.invocation}`);
    if (!row.phases?.length || !row.roles?.length) problems.push(`${id} needs phases and roles`);
  }
  const emitted = new Set(skills.filter(row => row.action === "emit").map(row => row.name));
  for (const row of skills.filter(row => row.action === "reference")) {
    if (!emitted.has(row.owner)) problems.push(`Reference ${row.name}: owner ${row.owner} must be an emitted skill`);
  }
  for (const path of upstream) if (!rows.has(path)) problems.push(`Unclassified skill ${path}`);
  if (problems.length) throw new Error(problems.join("\n"));
  return { skills, routes, chains };
}

export function checkRegistry({ packageDir, outDir = packageDir, registry }) {
  if (!registry) {
    const sources = sourcesOf(json(join(packageDir, "rules/manifest.json")));
    registry = loadRegistry(packageDir, sources);
    // Standalone check: the installed tree alone cannot reveal two producers of one reference.
    const inputs = sources.flatMap(source => {
      const classify = sourcePathClassifier(source, registry.skills);
      return walk(join(packageDir, source.vendor)).map(file => classify(file.replaceAll("\\", "/")).output).filter(Boolean);
    });
    referenceMoves([...inputs, ...["authored", "extra"].flatMap(dir => walk(join(packageDir, dir)).map(path => path.replaceAll("\\", "/")))], registry.skills);
  }
  const { skills, routes, chains } = registry;
  const emitted = skills.filter(row => row.action === "emit");
  const names = new Set(emitted.map(row => row.name)), problems = [];
  const refs = new Set(skills.filter(row => row.action === "reference").map(row => referencePath(row)));
  const fileExists = path => existsSync(join(outDir, "skills", path));
  for (const path of refs) if (!fileExists(path)) problems.push(`Missing reference ${path}`);
  const targetExists = target => names.has(target) || (typeof target === "string" && (refs.has(target) || /^(?:(?:p3stack-mode\/)?playbooks|(?:poteto|p3stack)-mode\/references)\/[a-z0-9-]+\.md$/.test(target)) && fileExists(targetPath(target)));
  const expected = new Map(emitted.map(row => [`skills/${row.name}/SKILL.md`, row])), outputNames = new Set();
  for (const relative of skillPaths(join(outDir, "skills"))) {
    const path = `skills/${relative}`, row = expected.get(path);
    const { name, description, hidden } = skillFrontmatter(readFileSync(join(outDir, path), "utf8"), path);
    if (outputNames.has(name)) problems.push(`Duplicate emitted name ${name} in ${path}`);
    outputNames.add(name);
    if (!row) { problems.push(`Unregistered emitted skill ${path}`); continue; }
    expected.delete(path);
    if (name !== row.name) problems.push(`${path} has a different frontmatter name`);
    if (typeof description !== "string" || !description.trim()) problems.push(`${path} needs a frontmatter description`);
    if (hidden !== (row.invocation === "user")) problems.push(`${path} has a different invocation`);
  }
  for (const path of expected.keys()) problems.push(`Missing emitted skill ${path}`);
  const routeKeys = new Set(), chainIds = new Set();
  for (const row of routes) {
    if (!["any", "default", "full-autonomy"].includes(row.grant)) problems.push(`Route ${row.request} has invalid grant ${row.grant}`);
    const key = JSON.stringify([row.request, row.grant]);
    if (routeKeys.has(key)) problems.push(`Duplicate route ${row.request} (${row.grant})`);
    routeKeys.add(key);
    if ("action" in row) {
      if ("target" in row || typeof row.action !== "string" || !row.action.trim()) problems.push(`Route ${row.request} needs either a target or a nonempty inline action`);
    } else if (!targetExists(row.target)) problems.push(`Route ${row.request} has missing target ${row.target}`);
  }
  for (const row of chains) {
    if (chainIds.has(row.id)) problems.push(`Duplicate chain id ${row.id}`);
    chainIds.add(row.id);
    if (!targetExists(row.skill)) problems.push(`Chain ${row.id} has missing skill ${row.skill}`);
    if (typeof row.when !== "string" || !row.when.trim()) problems.push(`Chain ${row.id} needs a condition`);
  }
  for (const [playbook, rows] of Map.groupBy(chains, row => row.playbook)) {
    if (!/^playbooks\/[a-z0-9-]+\.md$/.test(playbook)) { problems.push(`Chain ${rows[0].id} has invalid playbook ${playbook}`); continue; }
    const path = join(outDir, "skills", targetPath(playbook));
    try { chainSlots(existsSync(path) ? readFileSync(path, "utf8") : "", rows); }
    catch (error) { problems.push(error.message); }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return `${emitted.length} emitted, ${refs.size} references, ${skills.length - emitted.length - refs.size} dropped, 0 unclassified`;
}

function main() {
  try {
    const packageDir = resolve(process.env.P3STACK_PACKAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
    console.log(checkRegistry({ packageDir }));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
