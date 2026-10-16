import assert from "node:assert/strict";
import { test } from "node:test";
import { cardsFromDetails, listingLine } from "../extensions/subagents/src/card.js";
import { formatFooterStats, noteAssistantCacheHit, noteAutoCompaction, retainFooterExtras } from "../extensions/subagents/src/usage.js";

const record = { id: "subagent-123", name: "reviewer", status: "working", model: "openai-codex/gpt-5.6-luna", thinking: "medium" };
const listing = (item: Record<string, unknown>) => listingLine(cardsFromDetails([item], "summary")[0]).text;

test("command listing includes state, thinking, turns and cumulative cost", () => {
  assert.equal(listing({ ...record, usage: { assistantMessages: 3, cost: 0.125 } }),
    "● reviewer (subagent-123) · working · openai-codex/gpt-5.6-luna:medium · 3 turns · $0.125");
  assert.match(listing({ ...record, usage: { assistantMessages: 1, cost: 0 } }), /· 1 turn · \$0\.000$/);
  assert.match(listing({ ...record, usage: { assistantMessages: 0, cost: 0 } }), /· 0 turns · \$0\.000$/);
  assert.equal(listing({ ...record, status: "idle", model: undefined, unread: 1, aborted: true }),
    "* reviewer (subagent-123) · unread · no model · cancelled · turns unknown · cost unknown");
});

test("command listing strips terminal controls from child text", () => {
  const text = listing({ ...record, name: "Evil\x1b[2J\x1b]0;title\x07\nName", activity: "Tool: \x1b[31mbash" });
  assert.equal(text, "● evil name (subagent-123) · working · openai-codex/gpt-5.6-luna:medium · Tool: bash · turns unknown · cost unknown");
});

test("missing or invalid usage is not presented as zero", () => {
  for (const usage of [undefined, {}, { assistantMessages: -1, cost: NaN }]) {
    assert.match(listing({ ...record, usage }), /· turns unknown · cost unknown$/);
  }
});

const footerUsage = {
  assistantMessages: 3,
  cost: 0.125,
  tokens: { input: 1200, output: 340, cacheRead: 12000, cacheWrite: 800, total: 14340 },
  cacheHitRate: 85.2,
  contextUsage: { tokens: 33728, contextWindow: 272000, percent: 12.4 },
  autoCompaction: true,
};

test("command listing inlines the bottom-left footer stats", () => {
  assert.equal(listing({ ...record, usage: footerUsage }),
    "● reviewer (subagent-123) · working · openai-codex/gpt-5.6-luna:medium · 3 turns · ↑1.2k ↓340 R12k W800 CH85.2% $0.125 12.4%/272k (auto)");
});

test("footer stats omit zero parts and do not invent missing context, cache hit, or auto-compaction", () => {
  assert.equal(formatFooterStats({
    assistantMessages: 1,
    cost: 0,
    tokens: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 },
    contextUsage: { tokens: 100, contextWindow: 32000, percent: 0.312 },
    autoCompaction: false,
  }), "↓20 0.3%/32k");
  assert.equal(formatFooterStats({
    assistantMessages: 2,
    cost: 0.01,
    tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    contextUsage: { tokens: null, contextWindow: 200000, percent: null },
  }), "↑100 ↓20 $0.010 ?/200k");
  assert.equal(formatFooterStats({
    assistantMessages: 1, cost: 0.001,
    tokens: { input: 1, output: 1, cacheRead: 10, cacheWrite: 0 },
  }), "↑1 ↓1 R10 $0.001");
  assert.equal(formatFooterStats({
    assistantMessages: 1, cost: 0.5, tokens: { input: -1, output: "x" }, contextUsage: { percent: 10, contextWindow: 0 },
  }), "$0.500");
});

test("footer token compaction matches Pi", () => {
  const stats = (input: number) => formatFooterStats({ assistantMessages: 1, cost: 0.001, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.match(stats(999), /↑999 /);
  assert.match(stats(1500), /↑1\.5k /);
  assert.match(stats(9999), /↑10\.0k /);
  assert.match(stats(10000), /↑10k /);
  assert.match(stats(1_500_000), /↑1\.5M /);
  assert.match(stats(12_000_000), /↑12M /);
});

test("invalid cost stays unknown even when token stats exist", () => {
  assert.match(listing({ ...record, usage: {
    assistantMessages: -1,
    cost: NaN,
    tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextUsage: { percent: 1, contextWindow: 1000 },
  } }), /· turns unknown · ↑10 ↓1 1\.0%\/1\.0k · cost unknown$/);
});

test("cache hit and auto-compaction survive a session-stats replacement", () => {
  const noted = noteAutoCompaction(noteAssistantCacheHit(undefined, {
    usage: { input: 100, output: 40, cacheRead: 300, cacheWrite: 20 },
  }), true);
  assert.equal((noted as { cacheHitRate: number }).cacheHitRate, (300 / 420) * 100);
  const replaced = retainFooterExtras(noted, { assistantMessages: 1, cost: 0, tokens: { input: 1200, output: 340, cacheRead: 12000, cacheWrite: 800 } });
  assert.equal((replaced as { autoCompaction: boolean }).autoCompaction, true);
  assert.equal((replaced as { cacheHitRate: number }).cacheHitRate, (300 / 420) * 100);
  const cleared = noteAssistantCacheHit(replaced, { usage: { input: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal("cacheHitRate" in (cleared as object), false);
  assert.equal(noteAssistantCacheHit(replaced, {}), replaced);
  assert.equal(retainFooterExtras(replaced, null), null);
});
