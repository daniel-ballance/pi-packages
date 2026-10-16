import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cardFromRecord, cardLines, cardsFromDetails, paint, railLine, runCard, STATES, type AgentCard } from "../extensions/subagents/src/card.js";
import { demoSource } from "./fixtures/inspector-demo.js";

const summary = (item: Record<string, unknown>): AgentCard => cardsFromDetails([{ id: "child", name: "Child", ...item }], "summary")[0];
const read = (item: Record<string, unknown>): AgentCard => cardsFromDetails([{ id: "child", name: "Child", ...item }], "read")[0];
const hold = { kind: "halt", outcome: "confirmed" };

test("one precedence decides the state: hold, then failure, then lifecycle, then review", () => {
  const cases: [Record<string, unknown>, keyof typeof STATES][] = [
    [{ status: "working", hold, error: "boom" }, "held"],
    [{ status: "idle", hold, unread: 2 }, "held"],
    [{ status: "failed" }, "failed"],
    [{ status: "working", error: "boom" }, "failed"],
    [{ status: "waiting_input", error: "boom" }, "failed"],
    [{ status: "waiting_input", unread: 1 }, "waiting"],
    [{ status: "starting" }, "starting"],
    [{ status: "working", unread: 1 }, "working"],
    [{ status: "idle", unread: 1, resultReview: { status: "reviewed" } }, "unread"],
    [{ status: "idle", resultReview: { status: "reviewed" } }, "reviewed"],
    [{ status: "idle" }, "stopped"],
    [{ status: "idle", aborted: true }, "stopped"],
    [{ status: "stopping" }, "stopped"],
    [{ status: "stopped", unread: 1 }, "unread"],
    [{ status: "stopped", resultReview: { status: "reviewed" } }, "stopped"],
  ];
  for (const [facts, state] of cases) assert.equal(summary(facts).state, state, JSON.stringify(facts));
  assert.deepEqual(cardsFromDetails([{ status: "exploded" }, { name: "no status" }, null, "text"], "summary"), []);
});

test("each record shape has its own review rule", () => {
  const agent = () => structuredClone(demoSource().agents()[1]);
  const live = (edit: (record: ReturnType<typeof agent>) => void) => { const record = agent(); edit(record); return cardFromRecord(record, { now: Date.now() }).review; };
  assert.equal(live(record => { record.readCursor = 0; }), "unread", "live: a report past the read cursor");
  assert.equal(live(() => {}), "none", "live: nothing past the read cursor");
  assert.equal(live(record => { record.resultReview = { assignmentId: "a", status: "unreviewed" }; }), "unread");
  assert.equal(live(record => { record.readCursor = 0; record.resultReview = { assignmentId: "a", status: "reviewed" }; }), "reviewed",
    "live: a review settles routine reports");
  assert.equal(live(record => {
    record.resultReview = { assignmentId: "a", status: "reviewed" };
    record.updates.push({ cursor: 7, kind: "input_requested", text: "{}", time: new Date().toISOString() });
  }), "unread", "live: an input request reopens a reviewed result");

  assert.equal(summary({ status: "idle", unread: 2, resultReview: { status: "reviewed" } }).review, "unread", "summary: reports after the review");
  assert.equal(summary({ status: "idle", unread: 0, resultReview: { status: "unreviewed" } }).review, "unread");
  assert.equal(summary({ status: "idle", resultReview: { status: "reviewed" } }).review, "reviewed");
  assert.equal(summary({ status: "idle", unread: 0 }).review, "none");

  assert.equal(read({ status: "idle", hasMore: true, resultReview: { status: "reviewed" } }).review, "unread", "read: more pages remain");
  assert.equal(read({ status: "idle", resultReview: { status: "unreviewed" } }).review, "reviewed", "read: this read acknowledges it");
  assert.equal(read({ status: "idle", unread: 3 }).review, "none");
});

test("badges drop the provider and variant noise but keep the size", () => {
  for (const [full, short] of [
    ["claude-subscription/claude-opus-5-5", "opus-5-5"],
    ["xai/grok-4.7", "grok-4.7"],
    ["openai-codex/gpt-6-luna", "gpt-6-luna"],
    ["halogen/qwen3.8-flash-next-w4b", "qwen3.8-flash"],
    ["ollama/llama-3.1-70b", "llama-3.1-70b"],
    ["anthropic/claude-sonnet-4-20250514", "sonnet-4"],
  ]) {
    const card = summary({ status: "working", model: full, thinking: "high" });
    assert.deepEqual(card.model, { full, short, effort: "high" }, full);
  }
  assert.equal(summary({ status: "working" }).model, undefined);
});

const [, stress] = cardsFromDetails([
  { id: "sec", name: "Security review", status: "working" },
  { id: "args", name: "Trace tool args through every redaction path in the transcript renderer", status: "working",
    parentId: "sec", depth: 2, activity: "bash: npm test", model: "openai-codex/gpt-6-luna", thinking: "medium",
    startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:22Z", usage: { assistantMessages: 2, cost: 0.018 } },
], "summary");
const short = { ...stress, name: "trace tool args" };
const widths = [104, 74, 50, 36, 24];

test("rail rows give way in order: delegator, activity, name, then the whole badge", () => {
  assert.deepEqual(widths.map(columns => railLine(stress, columns).text), [
    "  ▎ ● trace tool args through every redaction path in the transcript renderer [gpt-6-luna medium]",
    "  ▎ ● trace tool args through every redaction path in… [gpt-6-luna medium]",
    "  ▎ ● trace tool args through… [gpt-6-luna medium]",
    "  ▎ ● trace too… [gpt-6-luna medium]",
    "  ▎ ● trace tool args t…",
  ]);
  assert.equal(railLine(short, 104).text, "  ▎ ● trace tool args [gpt-6-luna medium] bash: npm test · from security review");
  assert.equal(railLine(short, 74).text, "  ▎ ● trace tool args [gpt-6-luna medium] bash: npm test");
  for (const card of [stress, short]) for (const columns of widths) {
    const text = railLine(card, columns).text;
    assert.ok(visibleWidth(text) <= columns, `${columns}: ${text}`);
    assert.ok(text.includes("[gpt-6-luna medium]") || !text.includes("["), `badge whole or absent at ${columns}: ${text}`);
    if (text.includes("from security review")) assert.ok(text.includes("bash: npm test"), `delegator outlived activity: ${text}`);
    if (text.includes("bash")) assert.ok(text.includes(card.name), `activity outlived name: ${text}`);
  }
});

test("tool cards give way in order: name, whole badge, delegator, activity, then elapsed and turns before cost", () => {
  assert.deepEqual(widths.map(columns => cardLines(stress, columns).map(line => line.text)), [
    ["  ● trace tool args through every redaction path in the transcript renderer working  gpt-6-luna · medium",
      "  ↳ from security review · bash: npm test · 22s · 2 turns · $0.018"],
    ["  ● trace tool args through every redaction… working   gpt-6-luna · medium",
      "  ↳ from security review · bash: npm test · 22s · 2 turns · $0.018"],
    ["  ● trace tool args… working   gpt-6-luna · medium", "  ↳ bash: npm test · 22s · 2 turns · $0.018"],
    ["  ● trace tool args through… working", "  ↳ bash: npm te… · 2 turns · $0.018"],
    ["  ● trace tool… working", "  ↳ bash: npm… · $0.018"],
  ]);
  for (const card of [stress, short]) for (const columns of widths) for (const { text } of cardLines(card, columns)) {
    assert.ok(visibleWidth(text) <= columns, `${columns}: ${text}`);
    assert.ok(text.includes("gpt-6-luna · medium") || !text.includes("gpt-6"), `badge whole or absent at ${columns}: ${text}`);
  }
  assert.deepEqual(cardLines(summary({ status: "idle" }), 80).map(line => line.text), ["· child stopped"]);
});

test("workflow runs map into the same states and overview groups", () => {
  const source = demoSource(), [running, approval] = source.workflows();
  const workers = source.agents().filter(agent => agent.workflow === running.id);
  assert.equal(runCard(running, workers).state, "working");
  assert.match(runCard(running, workers).activity, /^running · 2\/5 steps · 1 active worker · parent review needed$/);
  assert.equal(runCard(approval, []).state, "waiting");
  assert.equal(STATES[runCard(approval, []).state].group, "attention");
  assert.equal(runCard(running, [{ ...workers[0], hold: { kind: "halt", at: "2026-01-01T00:00:00Z", outcome: "pending" } }]).state, "held");
  assert.equal(runCard({ ...running, status: "succeeded", unread: false }, workers).state, "reviewed");
  assert.equal(runCard({ ...running, status: "cancelled", unread: false }, workers).state, "stopped");
  assert.equal(runCard({ ...running, status: "exhausted" }, workers).state, "failed");
});

test("cards hold sanitized text and selection keeps state colours", () => {
  const card = summary({ status: "working", name: "Evil\x1b[2J\x1b]0;title\x07\nName", activity: "Tool: \x1b[31mbash" });
  assert.equal(card.name, "evil name");
  assert.equal(card.activity, "Tool: bash");
  const theme = { fg: (role: string, text: string) => `<${role}>${text}`, bold: (text: string) => `**${text}**` };
  assert.equal(paint(theme, railLine(card, 80).spans, "accent"), "<accent>▎<accent> <accent>●<accent> **<accent>evil name**<accent> <accent>Tool: bash");
  const reviewed = summary({ status: "idle", resultReview: { status: "reviewed" }, model: "xai/grok-4.7" });
  assert.equal(paint(theme, railLine(reviewed, 80).spans, "accent"), "<success>▎<accent> <success>✓<accent> **<accent>child**<accent> <accent>[grok-4.7]");
});

test("the README status legend is the STATES table", t => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split(/^### Status legend$/m)[1];
  if (section === undefined) return t.skip("README has no ### Status legend heading yet");
  const rows = [...section.split(/^#/m)[0].matchAll(/^\| `(.+?)` \| (\S+) \|/gm)].map(match => `${match[1]} ${match[2]}`);
  assert.deepEqual(rows, Object.values(STATES).map(style => `${style.glyph} ${style.word}`));
});
