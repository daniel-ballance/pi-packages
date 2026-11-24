import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readSequence } from "./routing-eval/reads.mjs";

const recording = readFileSync(new URL("./routing-eval/fixtures/feature.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
const expected = ["p3stack-mode/SKILL.md", "poteto-mode/SKILL.md", "poteto-mode/playbooks/feature.md"];
function replay(events) {
  const probe = readSequence("/project", "/pkg/skills", 4);
  for (const event of events) probe.record(event);
  return probe;
}

test("reads are correlated by id, not completion position; a partial open is recorded as such", () => {
  const result = replay(recording);
  assert.equal(result.matches(expected), true);
  assert.equal(result.reads[0].limit, 30);
  assert.equal(result.reads[0].ok, true);
  assert.deepEqual(result.observed(), expected);
  // More opens after the correct prefix do not change the decision.
  assert.equal(replay([...recording, { type: "tool_execution_start", toolName: "read", toolCallId: "extra", args: { path: "/extra/SKILL.md" } }]).matches(expected), true);
});

test("failed, incomplete and wrong routing reads do not establish the ordered prefix", () => {
  const withoutEnd = recording.filter(e => !(e.toolCallId === "mode" && e.type === "tool_execution_end"));
  for (const events of [withoutEnd,
    recording.map(e => e.toolCallId === "book" ? { ...e, isError: true } : e),
    recording.map(e => e.toolCallId === "book" && e.args ? { ...e, args: { path: "/pkg/skills/triage/SKILL.md" } } : e)]) {
    assert.equal(replay(events).matches(expected), false);
  }
});

test("a row's reads issued as one batch count in start order", () => {
  const withoutEnd = recording.filter(e => !(e.toolCallId === "mode" && e.type === "tool_execution_end"));
  const batched = withoutEnd.concat(recording.find(e => e.toolCallId === "mode" && e.type === "tool_execution_end"));
  assert.equal(replay(batched).matches(expected), true);
});

test("a small-task prompt fails when a read it should skip happens", () => {
  assert.equal(replay(recording).matches(expected.slice(0, 1)), true);
  assert.equal(replay(recording).matches(expected.slice(0, 1), ["poteto-mode/SKILL.md"]), false);
  assert.equal(replay(recording.filter(e => e.toolCallId === recording.find(first => first.type === "tool_execution_start").toolCallId)).matches(expected.slice(0, 1), ["poteto-mode/SKILL.md"]), true);
});

test("discovery grades skill opens under every skills root, and a no-skill row fails on any skill open", () => {
  const read = (id, path) => [
    { type: "tool_execution_start", toolName: "read", toolCallId: id, args: { path } },
    { type: "tool_execution_end", toolName: "read", toolCallId: id, isError: false, result: {} }];
  const probe = (...events) => { const p = readSequence("/project", ["/pkg/skills", "/pkg/subagents/skills"], 3); for (const e of events.flat()) p.record(e); return p; };
  assert.equal(probe(read("a", "cli.mjs"), read("b", "/pkg/subagents/skills/workflows/SKILL.md")).matches(["workflows/SKILL.md"]), true);
  assert.equal(probe(read("a", "cli.mjs")).matches([], [], true), true);
  assert.equal(probe(read("a", "/pkg/skills/tdd/SKILL.md")).matches([], [], true), false);
  assert.equal(probe(read("a", "cli.mjs")).matches([]), false, "an empty expectation passes only as a no-skill row");
});

test("the discovery suite names only real skills, one example and one held-out paraphrase per advertised skill", async () => {
  const { skillPaths } = await import("./routing-eval/receipt.mjs");
  const suite = JSON.parse(readFileSync(new URL("./routing-eval/discovery.json", import.meta.url), "utf8"));
  const cases = JSON.parse(readFileSync(new URL("./static-routing/cases.json", import.meta.url), "utf8")).cases;
  const paths = skillPaths();
  assert.equal(suite.arm, "off");
  for (const row of suite.prompts) for (const path of row.expected) assert.ok(paths.has(path), path);
  for (const { skill } of cases.filter(({ skill }) => !(skill in suite.notListed))) {
    assert.ok(suite.prompts.some(row => row.id === `${skill}-example`), skill);
    assert.ok(suite.prompts.some(row => row.id === `${skill}-held-out`), skill);
  }
  assert.ok(suite.prompts.filter(row => row.none).length >= 2);
});
