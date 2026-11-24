import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { evaluate, index, modelInvokedSkills, stem, tokens } from "./static-routing/run.mjs";

const skills = [
  { name: "pr", text: "Use when writing a pull request description." },
  { name: "release", text: "Prepare release notes and a version bump." },
  { name: "tdd", text: "Test-driven development with red-green-refactor." },
];
const suite = {
  rankOneFloor: 1, collisionThreshold: 0.99, pending: [],
  cases: skills.map(({name}) => ({ skill: name, positive: [{ prompt: name }] })),
};

test("tokens drop stop words and stem plural and -ing forms", () => {
  assert.deepEqual(tokens("Writing the tests for releases"), ["writ", "test", "releas"]);
  assert.equal(stem("libraries"), "library");
});

test("ranking puts the matching description first", () => {
  assert.equal(index(skills).rank("Cut a release and bump the version")[0].name, "release");
  assert.equal(index(skills).rank("Draft the pull request description")[0].name, "pr");
});

test("description lint distinguishes a complete case set from empty, skipped and uncovered sets", () => {
  assert.deepEqual(evaluate(skills, suite).failures, []);
  assert.match(evaluate(skills, { ...suite, cases: [] }).failures.join("\n"), /no positive/i);
  assert.match(evaluate([], suite).failures.join("\n"), /no positive/i);
  const extra = [...skills, { name: "new-thing", text: "frobnicate bazquux" }];
  assert.match(evaluate(extra, suite).failures.join("\n"), /new-thing/);
  assert.deepEqual(evaluate(extra, { ...suite, pending: ["new-thing"] }).failures, []);
});

test("evaluate rejects unknown owners, misplaced positives and negatives, low rank-1 share and collisions", () => {
  const withCase = (extra) => ({ ...suite, cases: [...suite.cases, { skill: "tdd", ...extra }] });
  assert.deepEqual(evaluate(skills, withCase({ negative: [{ prompt: "release", owner: "release" }] })).failures, []);
  assert.match(evaluate(skills, withCase({ negative: [{ prompt: "release", owner: "typo" }] })).failures.join("\n"), /unknown owner typo/);
  const misplaced = evaluate(skills, withCase({ positive: [{ prompt: "Prepare release notes", top_k: 1 }], negative: [{ prompt: "red-green-refactor please", owner: "release" }] })).failures.join("\n");
  assert.match(misplaced, /positive tdd: rank 3 > 1/);
  assert.match(misplaced, /negative tdd: owner release ranks/);
  assert.match(misplaced, /rank-1 share 75\.0%/);
  assert.match(evaluate(skills, withCase({ negative: [{ prompt: "tdd" }] })).failures.join("\n"), /negative tdd: ranks first/);
  assert.match(evaluate([...skills, { name: "pr-copy", text: skills[0].text }], { ...suite, collisionThreshold: 0.7 }).failures.join("\n"), /collision pr ~ pr-copy/);
});

test("the index uses frontmatter from the registry and the nested skill directory, not body text", t => {
  const root = mkdtempSync(join(tmpdir(), "description-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function put(path, text) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  put("registry/skills.json", JSON.stringify([{ action: "emit", invocation: "model", name: "pr" }]));
  put("skills/pr/SKILL.md", '---\nname: pr\ndescription: "Write a PR: description" # comment\n---\n');
  put("subagents/skills/workflows/SKILL.md", '---\nname: workflows\ndescription: >-\n  Supervise bounded\n  workflows.\n---\ndescription: not me\n');
  // Pi hides a skill only for YAML boolean true, not for a quoted scalar.
  put("subagents/skills/subagents/SKILL.md", '---\nname: subagents\ndescription: Manage children.\ndisable-model-invocation: "false"\n---\n');
  put("subagents/skills/manual/SKILL.md", '---\nname: manual\ndescription: Manual only.\ndisable-model-invocation: true\n---\n');
  assert.deepEqual(modelInvokedSkills(root).sort((a,b) => a.name.localeCompare(b.name)), [
    { name: "pr", text: "Write a PR: description" },
    { name: "subagents", text: "Manage children." },
    { name: "workflows", text: "Supervise bounded workflows." },
  ]);
});
