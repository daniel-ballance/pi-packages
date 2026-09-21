import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAgentListing } from "../src/usage.js";

const record = { id: "subagent-123", name: "reviewer", status: "working", model: "openai-codex/gpt-5.6-luna", thinking: "medium" };

test("command listing includes thinking, turns and cumulative cost", () => {
  assert.equal(formatAgentListing({ ...record, usage: { assistantMessages: 3, cost: 0.125 } }),
    "subagent-123 · reviewer · working · openai-codex/gpt-5.6-luna:medium · 3 turns · $0.125");
  assert.match(formatAgentListing({ ...record, usage: { assistantMessages: 1, cost: 0 } }), /· 1 turn · \$0\.000$/);
  assert.match(formatAgentListing({ ...record, usage: { assistantMessages: 0, cost: 0 } }), /· 0 turns · \$0\.000$/);
});

test("missing or invalid usage is not presented as zero", () => {
  for (const usage of [undefined, {}, { assistantMessages: -1, cost: NaN }]) {
    assert.match(formatAgentListing({ ...record, usage }), /· turns unknown · cost unknown$/);
  }
});
