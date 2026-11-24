import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DefaultPackageManager, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import { walk } from "../generator/source-paths.mjs";

// Use the skill linter's Markdown parser under both npm and pnpm.
const { fromMarkdown } = createRequire(new URL("../../../scripts/lint-skill/package.json", import.meta.url))("mdast-util-from-markdown");
const cwd = dirname(import.meta.dirname);
const [pack] = Object.values(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--offline", "--ignore-scripts", "--workspaces=false"], { cwd, encoding: "utf8" })));
const files = new Set(pack.files.map(file => file.path));

function* destinations(node) {
  if (["link", "image", "definition"].includes(node.type)) yield node;
  for (const child of node.children ?? []) yield* destinations(child);
}

function linkBases(file) {
  // Inside p3stack skills, Pi resolves both playbook and reference links from the skill root.
  if (file.startsWith("skills/")) return [file.split("/").slice(0, 2).join("/")];
  // Also check ordinary package docs and the nested packages.
  const base = posix.dirname(file);
  for (let dir = base; dir !== "."; dir = posix.dirname(dir)) {
    if (files.has(`${dir}/SKILL.md`)) return [base, dir];
  }
  return [base];
}

test("relative Markdown links resolve inside the packed p3stack", () => {
  assert.equal(pack.name, "p3stack");
  const entries = new Set(files); // npm lists files but a link can also name a directory.
  for (const file of files) {
    for (let dir = posix.dirname(file); !entries.has(dir); dir = posix.dirname(dir)) entries.add(dir);
  }
  const missing = [];
  for (const file of files) {
    if (!/\.(?:md|markdown)$/i.test(file)) continue;
    const tree = fromMarkdown(readFileSync(join(cwd, file), "utf8"));
    for (const { url, position } of destinations(tree)) {
      if (/^(?:[a-z][a-z\d+.-]*:|[/?#]|$)/i.test(url)) continue;
      const path = decodeURIComponent(url.split(/[?#]/, 1)[0]);
      if (!linkBases(file).some(base => entries.has(posix.join(base, path).replace(/\/$/, "")))) {
        missing.push(`${file}:${position.start.line}: ${url}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

const registry = JSON.parse(readFileSync(join(cwd, "registry/skills.json"), "utf8"));

async function checkCatalog(root) {
  const options = { cwd: root, agentDir: dirname(root) };
  const pm = new DefaultPackageManager({ ...options, settingsManager: SettingsManager.inMemory() });
  const resources = await pm.resolveExtensionSources([root]);
  const { skills, diagnostics } = loadSkills({ ...options, includeDefaults: false, skillPaths: resources.skills.filter(r => r.enabled).map(r => r.path) });
  assert.deepEqual(diagnostics, []);
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  assert.deepEqual(new Set(byName.keys()), new Set(registry.filter(r => r.action === "emit").map(r => r.name)));
  for (const { name, owner } of registry.filter(row => row.action === "reference")) {
    const skill = byName.get(owner), path = `references/${name}.md`;
    assert.ok(skill && existsSync(join(skill.baseDir, path)), `${owner}/${path}`);
    assert.ok(readFileSync(skill.filePath, "utf8").includes(name.startsWith("principle-") ? "references/principle-<title>.md" : path), `${owner}: ${name}`);
  }
}

test("Pi discovers the registry's commands and their references in the packed package", async t => {
  const temp = mkdtempSync(join(tmpdir(), "packed-catalog-")), root = join(temp, "package");
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(cwd, path), join(root, path));
  }
  await checkCatalog(root);
  // An equivalent resource root is fine; a missing reference or leaking terminal-only skills is not.
  renameSync(join(root, "skills"), join(root, "handbook"));
  const path = join(root, "package.json"), manifest = JSON.parse(readFileSync(path));
  manifest.pi.skills = ["handbook/"];
  writeFileSync(path, JSON.stringify(manifest));
  await checkCatalog(root);
  manifest.pi.skills.push("subagents/skills");
  writeFileSync(path, JSON.stringify(manifest));
  await assert.rejects(checkCatalog(root), /subagents/);
  manifest.pi.skills.pop();
  writeFileSync(path, JSON.stringify(manifest));
  rmSync(join(root, "handbook/tdd/references/regression-test.md"));
  await assert.rejects(checkCatalog(root), /tdd\/references\/regression-test\.md/);
});

test("the packlist includes every mapped upstream license", () => {
  const { sources } = JSON.parse(readFileSync(join(cwd, "rules/manifest.json")));
  for (const { map } of sources) for (const { from, to } of map) {
    if (from === "LICENSE") assert.ok(files.has(to), to);
  }
});

test("no emitted file contains a removed command or a path to a retired skill directory", () => {
  const emitted = new Set(registry.filter(row => row.action === "emit").map(row => row.name));
  const names = registry.filter(row => row.action !== "emit").map(row => row.name ?? posix.basename(posix.dirname(row.path))).filter(name => !emitted.has(name));
  const oldPath = new RegExp(`(?:\\.\\./|\\bskills/)(?:${names.join("|")})/`);
  const commands = new Set(names.flatMap(name => [`/${name}`, `/skill:${name}`]));
  const problems = [];
  for (const root of ["skills", "agents"]) {
    for (const path of walk(join(cwd, root))) {
      const file = join(root, path), text = readFileSync(join(cwd, file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const words = line.split(/[\s`"'()[\],;!]+/).map(word => word.replace(/[.?:]$/, ""));
        const hits = words.filter(word => commands.has(word)), pathHit = line.match(oldPath);
        if (pathHit) hits.push(pathHit[0]);
        for (const hit of hits) problems.push(`${file}:${i + 1}: ${hit}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the runtime package leaves maintainer instructions and skill tests in the checkout", () => {
  assert.ok(!files.has("AGENTS.md"));
  const testFile = /(?:\.test(?:-helper)?\.[^/]+|\/(?:bun-test|bun-compat|types\.compile)\.ts)$/;
  assert.deepEqual([...files].filter(file => file.startsWith("skills/") && testFile.test(file)), []);
});
