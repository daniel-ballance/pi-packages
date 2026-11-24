import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { evaluate, index, modelInvokedSkills } from "./static-routing/run.mjs";

const skills = [
  { name: "pr", text: "Use when writing a pull request description." },
  { name: "release", text: "Prepare release notes and a version bump." },
  { name: "tdd", text: "Test-driven development with red-green-refactor." },
];
const suite = {
  rankOneFloor: 1, collisionThreshold: 0.99, pending: [],
  heldOut: skills.map(({ name }) => ({ skill: name, prompt: `Try ${name}` })),
  cases: skills.map(({ name }, i) => {
    const owner = skills[(i + 1) % skills.length].name;
    return { skill: name, positive: [{ prompt: name }], negative: [{ prompt: owner, owner }] };
  }),
};

test("stop words supply no evidence and inflected vocabulary matches its owner", () => {
  const scorer = index([{ name: "docs", text: "Catalog the libraries" }, { name: "check", text: "Tests the code" }]);
  assert.ok(scorer.rank("the").every(r => r.score === 0));
  for (const [prompt, owner] of [["library", "docs"], ["testing", "check"]]) {
    const [first, next] = scorer.rank(prompt);
    assert.equal(first.name, owner);
    assert.ok(first.score > next.score);
  }
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
  const pending = expires => ({ ...suite, pending: [{ skill: "new-thing", expires }] });
  const today = "2026-11-24";
  assert.deepEqual(evaluate(extra, pending("2026-11-25"), today).failures, []);
  for (const expires of ["2026-11-24", "2026-11-23", "2027-02-30", undefined]) {
    assert.match(evaluate(extra, pending(expires), today).failures.join("\n"), /expir/);
  }
});

for (const key of ["rankOneFloor", "collisionThreshold"]) {
  test(`description lint requires ${key} in [0,1]`, () => {
    for (const value of [undefined, -0.01, 1.01, "0.5", NaN]) {
      const config = { ...suite, [key]: value };
      if (value === undefined) delete config[key];
      assert.match(evaluate(skills, config).failures.join("\n"), new RegExp(key));
    }
  });
}

test("top_k must be a positive integer, including in a pending case", () => {
  for (const top_k of [-2, 0, 1.5]) {
    const config = { ...suite, pending: [{ skill: "later", expires: "2099-01-01" }], cases: [...suite.cases, { skill: "later", positive: [{ prompt: "later", top_k }] }] };
    assert.match(evaluate(skills, config).failures.join("\n"), /top_k/);
  }
});

test("evaluate rejects unknown owners, misplaced positives and negatives, low rank-1 share and collisions", () => {
  const withCase = (extra) => ({ ...suite, cases: [...suite.cases, { skill: "tdd", ...extra }] });
  assert.deepEqual(evaluate(skills, withCase({ negative: [{ prompt: "release", owner: "release" }] })).failures, []);
  assert.match(evaluate(skills, withCase({ negative: [{ prompt: "release", owner: "typo" }] })).failures.join("\n"), /unknown owner typo/);
  const misplaced = evaluate(skills, withCase({ positive: [{ prompt: "Prepare release notes", top_k: 1 }], negative: [{ prompt: "red-green-refactor please", owner: "release" }] })).failures.join("\n");
  assert.match(misplaced, /positive tdd: no vocabulary evidence/);
  assert.match(misplaced, /negative tdd: owner release must outscore/);
  assert.match(misplaced, /rank-1 share 75\.0%/);
  assert.match(evaluate(skills, withCase({ negative: [{ prompt: "tdd" }] })).failures.join("\n"), /negative tdd: missing owner/);
  assert.match(evaluate([...skills, { name: "pr-copy", text: skills[0].text }], { ...suite, collisionThreshold: 0.7 }).failures.join("\n"), /collision pr ~ pr-copy/);
});

test("each skill needs a held-out paraphrase and a boundary owned by a different skill", () => {
  const missing = evaluate(skills, { ...suite, heldOut: [], cases: suite.cases.map(({ negative, ...c }) => c) });
  assert.match(missing.failures.join("\n"), /no owned negative case for pr/);
  assert.match(missing.failures.join("\n"), /no held-out paraphrase for pr/);
  const self = evaluate(skills, { ...suite, cases: [...suite.cases, { skill: "pr", negative: [{ prompt: "pr", owner: "pr" }] }] });
  assert.match(self.failures.join("\n"), /different owner/);
});

test("alphabetical order never supplies evidence for zero scores or owned ties", () => {
  const zero = { prompt: "wombat" };
  const result = evaluate(skills, { ...suite, heldOut: [{ skill: "pr", ...zero }, ...suite.heldOut], cases: [...suite.cases,
    { skill: "pr", positive: [zero] }, { skill: "tdd", negative: [{ ...zero, owner: "pr" }] }] });
  assert.equal(result.first, 3);
  assert.equal(result.positives, 4);
  assert.equal(result.zeroTies, 1);
  assert.equal(result.negativeZeroTies, 1);
  assert.equal(result.heldOut.first, 3);
  assert.equal(result.heldOut.topThree, 3);
  assert.equal(result.heldOut.zeroTies, 1);
  assert.match(result.failures.join("\n"), /zero-score tie/);
  assert.match(result.failures.join("\n"), /owner pr must outscore/);
});

test("the index uses frontmatter from the registry and the nested skill directory, not body text", t => {
  const root = mkdtempSync(join(tmpdir(), "description-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function put(path, text) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  put("registry/skills.json", JSON.stringify([{ action: "emit", invocation: "model", name: "pr" }, { action: "reference", invocation: "model", name: "codebase-design", owner: "architect" }]));
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
