import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import { removedCommandPattern } from "../generator/generate.mjs";
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

test("every reference is packed under its owner's skill, not discoverable as a command", () => {
  const refs = registry.filter(row => row.action === "reference");
  assert.equal(refs.length, 43);
  for (const { name, owner } of refs) {
    assert.ok(!files.has(`skills/${name}/SKILL.md`), name);
    assert.ok(files.has(`skills/${owner}/references/${name}.md`), name);
    const skill = readFileSync(join(cwd, `skills/${owner}/SKILL.md`), "utf8");
    assert.ok(skill.includes(name.startsWith("principle-") ? "references/principle-<title>.md" : `references/${name}.md`), `${owner}: ${name}`);
  }
});

test("no emitted file contains a removed command or a path to a retired skill directory", () => {
  const names = [...registry.filter(row => row.action === "reference").map(row => row.name), "automate-me", "grill-with-docs", "ketchup-video"];
  const oldPath = new RegExp(`(?:\\.\\./|\\bskills/)(?:${names.join("|")})/`), command = removedCommandPattern(registry);
  const problems = [];
  for (const root of ["skills", "agents"]) {
    for (const path of walk(join(cwd, root))) {
      const file = join(root, path), text = readFileSync(join(cwd, file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const hits = line.match(command) ?? [], pathHit = line.match(oldPath);
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
