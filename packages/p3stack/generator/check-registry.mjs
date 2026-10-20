#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcesOf } from "./source-paths.mjs";

const json = path => JSON.parse(readFileSync(path, "utf8"));
const key = row => `${row.source}/${row.path}`;
export const playbookPath = target => target.startsWith("p3stack-mode/") ? `skills/${target}` : `skills/poteto-mode/${target}`;

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
    if (row.source === "p3stack" && row.action === "emit" && row.path !== `skills/${row.name}/SKILL.md`) {
      problems.push(`Authored skill ${id} must emit at ${row.path}`);
    }
    if (typeof row.reason !== "string" || !row.reason.trim()) problems.push(`${id} needs a reason`);
    if (row.action === "drop") continue;
    if (row.action !== "emit") { problems.push(`${id} has invalid action ${row.action}`); continue; }
    if (typeof row.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.name)) problems.push(`${id} has invalid emitted name ${row.name}`);
    if (names.has(row.name)) problems.push(`Duplicate emitted name ${row.name}`);
    names.add(row.name);
    if (!["model", "user"].includes(row.invocation)) problems.push(`${id} has invalid invocation ${row.invocation}`);
    if (!row.phases?.length || !row.roles?.length) problems.push(`${id} needs phases and roles`);
  }
  for (const path of upstream) if (!rows.has(path)) problems.push(`Unclassified skill ${path}`);
  if (problems.length) throw new Error(problems.join("\n"));
  return { skills, routes, chains };
}

export function checkRegistry({ packageDir, outDir = packageDir, registry }) {
  registry ??= loadRegistry(packageDir, sourcesOf(json(join(packageDir, "rules/manifest.json"))));
  const { skills, routes, chains } = registry;
  const emitted = skills.filter(row => row.action === "emit");
  const names = new Set(emitted.map(row => row.name)), problems = [];
  const targetExists = target => names.has(target) || (typeof target === "string" && /^(?:p3stack-mode\/)?playbooks\/[a-z0-9-]+\.md$/.test(target) && existsSync(join(outDir, playbookPath(target))));
  for (const row of emitted) {
    const path = `skills/${row.name}/SKILL.md`, absolute = join(outDir, path);
    if (!existsSync(absolute)) { problems.push(`Missing emitted skill ${path}`); continue; }
    const text = readFileSync(absolute, "utf8");
    if (text.match(/^name:\s*(.+)$/m)?.[1] !== row.name) problems.push(`${path} has a different frontmatter name`);
    const hidden = /^disable-model-invocation:\s*true\s*$/m.test(text);
    if (hidden !== (row.invocation === "user")) problems.push(`${path} has a different invocation`);
  }
  const outputNames = new Set(), expected = new Set(emitted.map(row => `${row.name}/SKILL.md`));
  for (const path of skillPaths(join(outDir, "skills"))) {
    const name = readFileSync(join(outDir, "skills", path), "utf8").match(/^name:\s*(.+)$/m)?.[1];
    if (outputNames.has(name)) problems.push(`Duplicate emitted name ${name} in skills/${path}`);
    outputNames.add(name);
    if (!expected.has(path)) problems.push(`Unregistered emitted skill skills/${path}`);
  }
  for (const row of routes) if (!targetExists(row.target)) problems.push(`Route ${row.request} has missing target ${row.target}`);
  for (const row of chains) {
    if (!/^playbooks\/[a-z0-9-]+\.md$/.test(row.playbook)) problems.push(`Chain ${row.id} has invalid playbook ${row.playbook}`);
    if (!targetExists(row.skill)) problems.push(`Chain ${row.id} has missing skill ${row.skill}`);
    const path = playbookPath(row.playbook), absolute = join(outDir, path);
    const text = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
    const count = typeof row.anchor === "string" && row.anchor.length ? text.split(row.anchor).length - 1 : 0;
    if (count !== 1) problems.push(`Chain ${row.id} anchor occurs ${count} times in ${path}`);
    if (!["before", "after"].includes(row.position)) problems.push(`Chain ${row.id} has invalid position ${row.position}`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return `${emitted.length} emitted, ${skills.length - emitted.length} dropped, 0 unclassified`;
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
