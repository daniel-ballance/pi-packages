import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grade, materialize, trace } from "./behavior-eval/run.mjs";

const suite = JSON.parse(readFileSync(new URL("./behavior-eval/cases.json", import.meta.url), "utf8"));
const events = [
  { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "/x/skills/diagnosing-bugs/SKILL.md" } },
  { type: "tool_execution_end", toolCallId: "1", isError: false },
  { type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "node --test" } },
  { type: "tool_execution_start", toolCallId: "3", toolName: "edit", args: { path: "src/split.js" } },
  { type: "tool_execution_start", toolCallId: "4", toolName: "mcp__context7__query_docs", args: { libraryId: "/vitest-dev/vitest/v3_2_4" } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Fixed; see https://vitest.dev/config/coverage" }] } },
].map(event => JSON.stringify(event)).join("\n") + "\nnot json\n";

test("trace keeps tool calls in order and the last assistant text", () => {
  const seen = trace(events);
  assert.deepEqual(seen.calls.map(call => call.tool), ["read", "bash", "edit", "mcp__context7__query_docs"]);
  assert.equal(seen.calls[0].ok, true);
  assert.match(seen.final, /vitest\.dev/);
});

test("grade checks reads, order, tools with arguments, any-of, and the final reply", () => {
  const seen = trace(events);
  assert.equal(grade({ kind: "read", pattern: "diagnosing-bugs/SKILL\\.md" }, seen), true);
  assert.equal(grade({ kind: "order", first: { kind: "bash", pattern: "node" }, before: { kind: "edit", pattern: "src/split\\.js" } }, seen), true);
  assert.equal(grade({ kind: "order", first: { kind: "bash", pattern: "npm" }, before: { kind: "edit", pattern: "src/split\\.js" } }, seen), false);
  assert.equal(grade({ kind: "tool", pattern: "^mcp__context7__query_docs$", args: "3[._]2" }, seen), true);
  assert.equal(grade({ kind: "any", of: [{ kind: "tool", pattern: "^web_search$" }, { kind: "final", pattern: "https?://\\S*vitest" }] }, seen), true);
  assert.equal(grade({ kind: "final", pattern: "skip" }, seen), false);
});

test("every case's fixture materializes as a committed base with the change left uncommitted, and file and command checks read it", t => {
  for (const row of suite.cases) {
    const root = mkdtempSync(join(tmpdir(), "behavior-fixture-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    materialize(row.fixture, root);
    assert.match(execFileSync("git", ["log", "--oneline"], { cwd: root }).toString(), /base/, row.id);
    for (const check of row.expect) assert.ok(["bash", "read", "edit", "tool", "final", "any", "order", "file", "command"].includes(check.kind), `${row.id}/${check.id}`);
  }
  const root = mkdtempSync(join(tmpdir(), "behavior-floor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  materialize("floor-review", root);
  assert.match(execFileSync("git", ["status", "--short"], { cwd: root }).toString(), /M test\/sum\.test\.js/);
  assert.equal(grade({ kind: "file", pattern: "^test/sum\\.test\\.js$", contains: "test." + "skip(" }, { calls: [], final: "" }, root), true, "the fixture placeholder becomes a real skip");
  assert.equal(grade({ kind: "command", run: "node --test" }, { calls: [], final: "" }, root), true);
});
