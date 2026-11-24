import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../generator/generate.mjs";
import { lintHosts } from "../generator/lint-hosts.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(pkg, path), "utf8");
const rules = name => JSON.parse(read(`rules/${name}.json`));

// Exercise the shipping rewrites in order. Only the whole pin, not a single
// example, is required to meet their aggregate match counts.
function translate(t, source, files) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-translation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  };
  for (const [path, contents] of Object.entries(files)) write("vendor/" + path, contents);
  const map = ["skills/", "agents/"].map(path => ({ from: path, to: path }));
  write("rules/manifest.json", JSON.stringify({ sources: [{ name: source, vendor: "vendor", map }] }));
  write("rules/tokens.json", JSON.stringify(rules("tokens")
    .filter(rule => !rule.source || rule.source === source).map(rule => ({ ...rule, min: 0 }))));
  write("rules/sections.json", JSON.stringify(rules("sections").filter(rule => Object.hasOwn(files, rule.file))));
  symlinkSync(join(pkg, "overlays"), join(root, "overlays"), "dir");
  write("rules/lint.json", JSON.stringify({ deny: rules("lint").deny }));
  const outDir = join(root, "out");
  generate({ packageDir: root, outDir });
  return path => readFileSync(join(outDir, path), "utf8");
}

for (const name of ["AskQuestion", "AskUserQuestion", "create-skill"]) {
  test(`an uncatalogued use of ${name} needs a translation, not a catch-all substitution`, t => {
    const path = "skills/example/SKILL.md";
    assert.throws(() => translate(t, "cursor-plugins", { [path]: `Call \`${name}\` with these arguments.\n` }),
      error => error.message.includes(`${path}:1: ${name}`));
  });
}

const requirements = "skills/dyl-mode/references/requirements.md";
for (const [path, input, sibling] of [
  [requirements, "dyl-stack/" + requirements, "# New requirements"],
  ...["thermo-nuclear-review-subagent", "thermo-nuclear-code-quality-review-subagent"]
    .map(name => [`agents/${name}.md`, `thermos/agents/${name}.md`, "## New procedure"]),
]) {
  test(`the owner replacement in ${path} preserves new siblings and refuses a changed body`, t => {
    const upstream = read("vendor/pstack/" + input);
    const withSibling = translate(t, "owner-plugins", { [path]: upstream + `\n${sibling}\n\nKeep this evidence.\n` });
    assert.ok(withSibling(path).includes(`${sibling}\n\nKeep this evidence.`));
    assert.throws(() => translate(t, "owner-plugins", { [path]: upstream + "\nAlso gather this evidence.\n" }),
      /changed upstream/);
  });
}

test("the review and design instructions resolve delegation through the host map", () => {
  for (const path of ["code-review/SKILL.md", "codebase-design/SKILL.md", "codebase-design/DESIGN-IT-TWICE.md"]) {
    const skill = read("skills/" + path);
    assert.doesNotMatch(skill, /\b(?:subagent_|mcp__t3)/, path);
    assert.match(skill, /\[Delegate\]\(\.\.\/poteto-mode\/references\/host-capabilities\.md#delegate\)/, path);
  }
});

test("host lint catches terminal and T3 calls in agents and skill resources, but not the map or shared tools", t => {
  const root = mkdtempSync(join(tmpdir(), "p3stack-host-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const map = "skills/poteto-mode/references/host-capabilities.md";
  const agent = "agents/reviewer.md", resource = "skills/demo/worker.json";
  for (const [path, contents] of [
    [agent, "Call subagent_spawn, then subagent_wait.\nUse task_cancel."],
    [resource, '{"tool":"subagent_workflow_inspect"}\n{"tool":"mcp__t3_code__delegate_task"}'],
    [map, "subagent_read, mcp__t3-code__delegate_task"],
    ["skills/demo/SKILL.md", "Ask via ask_user. Read with read. Note the last_task_status_code."],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  assert.deepEqual(lintHosts(root), [
    agent + ":1: subagent_spawn", agent + ":1: subagent_wait", agent + ":2: task_cancel",
    resource + ":1: subagent_workflow_inspect", resource + ":2: mcp__t3_code__delegate_task",
  ]);
});

test("slash translation recognizes commands, not URL segments, file paths, or unshipped names", t => {
  const commands = "Run /research. Try [`/research`](../research/SKILL.md), not /wait-what or /research-more.";
  const examples = [
    "Mount the route at `/prototype/<name>` or /research/<name>.",
    "Open https://example.test/research or /research?variant=1#data. See [route](/research).",
    "Read /research.md, /research/output.json, ../research/SKILL.md and docs/research.",
  ];
  const path = "skills/notes/examples.md";
  const output = translate(t, "matt-pocock", {
    "skills/research/SKILL.md": "# Research\n",
    [path]: [commands, ...examples].join("\n"),
  });
  assert.equal(output(path), [
    "Run /skill:research. Try [`/skill:research`](../research/SKILL.md), not /wait-what or /research-more.",
    ...examples,
  ].join("\n"));
});

test("the prototype's throwaway page is an app route", () => {
  assert.ok(read("skills/interactive-prototype/UI.md").includes("route under `/prototype/<name>`"));
});

for (const [skill, file, suffix] of [
  ["architect", "references/rationale-template.md", "arena/SKILL.md"],
  ["poteto-mode", "playbooks/babysit.md", "bugbot-triage.md"],
  ["poteto-mode", "playbooks/multi-phase-plan.md", "bugbot-triage.md"],
  ["poteto-mode", "references/bugbot-triage.md", "playbooks/babysit.md"],
  ["constraints", "SKILL.md", "references/floor.md"],
]) {
  test(`${skill}/${file} reaches ${suffix} from the skill directory`, () => {
    const skillDir = join(pkg, "skills", skill);
    const refs = [...readFileSync(join(skillDir, file), "utf8").matchAll(/`([^`\n]+)`|\]\(([^)\n]+)\)/g)]
      .map(match => match[1] ?? match[2]).filter(path => path.endsWith(suffix));
    assert.ok(refs.length, `no pointer to ${suffix}`);
    for (const ref of refs) assert.ok(existsSync(resolve(skillDir, ref)), `${skill} cannot resolve ${ref}`);
  });
}

test("constraints supplies a floor command runnable from the consumer repository", () => {
  const skillDir = join(pkg, "skills/constraints");
  const operand = read("skills/constraints/SKILL.md").match(/`node "([^"]*floor-check\.mjs)"`/)?.[1];
  assert.ok(operand, "missing quoted checker path");
  assert.equal(resolve(operand.replace("<constraints-dir>", skillDir)), join(pkg, "skills/p3stack-mode/scripts/floor-check.mjs"));
});

test("dyl-review hands results back without prescribing a dropped caller", () => {
  const skill = read("skills/dyl-review/SKILL.md");
  assert.match(skill, /hand the block back to that skill/);
  assert.doesNotMatch(skill, /dyl-ready-pr/);
});

test("the instrumentation checklist points to the shipped skill and the project's launch process", () => {
  const checklist = read("skills/instrumentation/references/observability-checklist.md");
  assert.doesNotMatch(checklist, /observability-and-instrumentation|shipping-and-launch/);
  assert.match(checklist, /\[instrumentation\]\(SKILL\.md\)/);
  assert.match(checklist, /rollback triggers, see your launch process/);
});

test("constraints describes the standards and spec axes and grilling's question rounds", () => {
  const skill = read("skills/constraints/SKILL.md");
  assert.doesNotMatch(skill, /five axes|one-question-at-a-time/);
  assert.match(skill, /code-review[^\n]*standards[^\n]*spec/i);
  assert.match(skill, /rounds[^\n]*grilling|grilling[^\n]*rounds/i);
});
