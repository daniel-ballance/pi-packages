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
