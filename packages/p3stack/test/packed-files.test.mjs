import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import test from "node:test";

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
  // Markdown links start at the file. Pi also accepts paths from the skill root.
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

test("the runtime package leaves maintainer instructions and skill tests in the checkout", () => {
  assert.ok(!files.has("AGENTS.md"));
  const testFile = /(?:\.test(?:-helper)?\.[^/]+|\/(?:bun-test|bun-compat|types\.compile)\.ts)$/;
  assert.deepEqual([...files].filter(file => file.startsWith("skills/") && testFile.test(file)), []);
});
