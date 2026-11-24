import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import test, { after } from "node:test";
import { walk } from "../generator/source-paths.mjs";

// Use the skill linter's Markdown parser under both npm and pnpm.
const { fromMarkdown } = createRequire(new URL("../../../scripts/lint-skill/package.json", import.meta.url))("mdast-util-from-markdown");
const cwd = dirname(import.meta.dirname);
const consumer = mkdtempSync(join(tmpdir(), "p3stack-consumer-")), installed = join(consumer, "node_modules/p3stack");
after(() => rmSync(consumer, { recursive: true, force: true }));
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", consumer, "--json", "--offline", "--ignore-scripts", "--workspaces=false"], { cwd, encoding: "utf8" }));
mkdirSync(installed, { recursive: true });
execFileSync("tar", ["-xf", join(consumer, pack.filename), "--strip-components=1", "-C", installed]);
const readInstalled = file => readFileSync(join(installed, file), "utf8");
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
    const tree = fromMarkdown(readInstalled(file));
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

// These operands refer to the maintainer checkout or report a diagnostic, not an installed resource.
const external = new Map([
  ["skills/maintain-p3stack/references/failure-classes.md", ["references/missing", "packages/p3stack/generator/check-registry.mjs"]],
  ["skills/poteto-help/SKILL.md", ["scripts/lint-skill", "./packages/p3stack"]],
  ["skills/poteto-mode/references/host-terminal.md", ["scripts/lint-skill/lint-skill.mjs"]],
]);

function* codeNodes(node) {
  // A link label is not another operand; its destination is checked above.
  if (["link", "linkReference"].includes(node.type)) return;
  if (["inlineCode", "code"].includes(node.type)) yield node;
  for (const child of node.children ?? []) yield* codeNodes(child);
}

function missingOperands(file, text) {
  const [base] = linkBases(file), missing = [];
  const check = (path, line) => {
    const target = posix.join(base, path);
    if (!files.has(target) || !statSync(join(installed, target), { throwIfNoEntry: false })?.isFile()) missing.push(`${file}:${line}: ${path}`);
  };
  for (const node of codeNodes(fromMarkdown(text))) {
    if (node.type === "code" && ![undefined, "sh", "shell", "bash", "md", "text"].includes(node.lang)) continue;
    for (const [i, line] of node.value.split("\n").entries()) {
      const at = node.position.start.line + i + (node.type === "code" ? 1 : 0);
      // The generated help index spells out a playbook invocation, not a file link.
      const play = /^\/skill:([\w-]+) use the ([\w-]+) playbook$/.exec(line);
      if (play) check(`../${play[1]}/playbooks/${play[2]}.md`, at);
      if (/\bgit show \S+:(?:pstack\/|packages\/p3stack\/)skills\/[\w-]+\//.test(line)) missing.push(`${file}:${at}: bundled skill read from consumer Git`);
      const normalized = line.replaceAll("<skill dir>/", "./").replace(/<([\w-]+)(?:-dir| directory)>\/(?=(?:\.\.\/|scripts\/))/g, "../$1/");
      let previous;
      for (const word of normalized.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
        const path = word.replace(/^["']|["']$/g, "").replace(/[.,;]$/, "").split(/#|:\d+$/)[0];
        const script = /^(?:node|bash|sh|python3?)$/.test(previous) && /\.(?:[cm]?js|ts|sh|py)$/.test(path);
        previous = word;
        if (!/^[\w./ -]+$/.test(path) || path.endsWith("/") || external.get(file)?.includes(path)) continue;
        // Maintenance explicitly runs these commands in a pi-packages checkout.
        if (file.startsWith("skills/maintain-p3stack/") && /^(?:\.\/scripts\/|generator\/)/.test(path)) {
          const root = path.startsWith("generator/") ? cwd : join(cwd, "../..");
          assert.ok(statSync(join(root, path), { throwIfNoEntry: false })?.isFile(), `${file}:${at}: ${path}`);
          continue;
        }
        if (line.includes(path + " in the installed skills")) { check("../" + path, at); continue; }
        // Consumer inputs (e.g. GLOSSARY.md or src/app.ts) aren't bundled. A file beside a
        // nested reference, however, must still be addressed from the skill root, not that reference.
        const sibling = node.type === "inlineCode" && path.endsWith(".md") && files.has(posix.join(posix.dirname(file), path));
        if (script || sibling || /^(?:\.\.?\/|(?:[\w-]+\/)?(?:references|playbooks|scripts|workflows)\/)/.test(path)) check(path, at);
      }
    }
  }
  return missing;
}

test("concrete read and script operands resolve from the installed skill, not the producer checkout", () => {
  const pages = [...files].filter(file => /^(?:skills|agents)\/.*\.md$/.test(file));
  assert.deepEqual(pages.flatMap(file => missingOperands(file, readInstalled(file))), []);
});

test("missing operands fail even in command examples and generated playbook rows", () => {
  const file = "skills/poteto-mode/playbooks/babysit.md";
  const sample = 'Run `node "<poteto-mode-dir>/scripts/gone.mjs"` and read `../why/references/missing.md`.\n```sh\nbash scripts/missing.sh --test\n```\n| Review | `/skill:poteto-mode use the absent playbook` |';
  assert.deepEqual(missingOperands(file, sample), [":1: ../poteto-mode/scripts/gone.mjs", ":1: ../why/references/missing.md", ":3: scripts/missing.sh", ":5: ../poteto-mode/playbooks/absent.md"].map(s => file + s));
});

test("the installed reference index expands to the registered owner paths", () => {
  const file = "skills/poteto-mode/SKILL.md", refs = registry.filter(row => row.action === "reference");
  const [, template, groups] = /For a reference, read `([^`]+)`: (.+)\.$/m.exec(readInstalled(file));
  const targets = [];
  for (const [, owner, list] of groups.matchAll(/([\w-]+) \(([^)]+)\)/g)) {
    const names = list.split(", ").flatMap(name => name === "principle-*" ? refs.filter(row => row.owner === owner && row.name.startsWith("principle-")).map(row => row.name) : name);
    for (const name of names) {
      const path = posix.join(linkBases(file)[0], template.replace("<owner>", owner).replace("<name>", name));
      assert.ok(files.has(path), path);
      targets.push(path);
    }
  }
  assert.deepEqual(targets.sort(), refs.map(({ owner, name }) => `skills/${owner}/references/${name}.md`).sort());
});

test("every reference is packed under its owner's skill, not discoverable as a command", () => {
  const refs = registry.filter(row => row.action === "reference");
  assert.equal(refs.length, 43);
  for (const { name, owner } of refs) {
    assert.ok(!files.has(`skills/${name}/SKILL.md`), name);
    assert.ok(files.has(`skills/${owner}/references/${name}.md`), name);
    const skill = readInstalled(`skills/${owner}/SKILL.md`);
    assert.ok(skill.includes(name.startsWith("principle-") ? "references/principle-<title>.md" : `references/${name}.md`), `${owner}: ${name}`);
  }
});

const removedCommands = new Set(registry.filter(row => row.action !== "emit").flatMap(row => {
  const name = row.name ?? posix.basename(posix.dirname(row.path));
  return [`/${name}`, `/skill:${name}`];
}));

function leftoverCommands(line) {
  const words = line.split(/[\s`"'()[\],;!*<>]+/).map(word => word.replace(/[.?:]$/, ""));
  return words.filter(word => removedCommands.has(word));
}

test("the independent leftover scan recognizes wrapped commands but not path segments", () => {
  for (const [literal, expected] of [["Run `(/skill:unslop)`.", "/skill:unslop"], ["<instruction></teach>", "/teach"], ["Use **/sharpen**!", "/sharpen"]]) {
    assert.deepEqual(leftoverCommands(literal), [expected], literal);
  }
  assert.deepEqual(leftoverCommands("docs/teach /teach.md /sharpen/file https://example.test/teach"), []);
});

test("no emitted file contains a removed command or a path to a retired skill directory", () => {
  const names = [...registry.filter(row => row.action === "reference").map(row => row.name), "automate-me", "grill-with-docs", "ketchup-video"];
  const oldPath = new RegExp(`(?:\\.\\./|\\bskills/)(?:${names.join("|")})/`);
  const problems = [];
  for (const root of ["skills", "agents"]) {
    for (const path of walk(join(cwd, root))) {
      const file = join(root, path), text = readFileSync(join(cwd, file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const hits = leftoverCommands(line), pathHit = line.match(oldPath);
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
