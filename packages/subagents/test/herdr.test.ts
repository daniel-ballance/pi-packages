import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { HerdrStatus } from "../extensions/subagents/src/herdr.js";
import { tempRoot } from "./support/temp-root.js";

type Request = { id: string; method: string; params: Record<string, any> };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(now = () => 1_000_000) {
  const sent: Request[] = [];
  const status = new HerdrStatus("w1:p1", async request => { sent.push(request as Request); },
    () => ({ agent_session_path: "/sessions/parent.jsonl" }), now);
  const states = () => sent.filter(r => r.method === "pane.report_agent").map(r => r.params.state);
  const metadata = () => sent.filter(r => r.method === "pane.report_metadata").map(r => r.params);
  return { status, sent, states, metadata };
}

test("stays silent, leaving herdr's integration in charge, until a subagent runs", async () => {
  const { status, sent } = fixture();
  status.start(false);
  status.parent(true);
  status.blocked({ active: true, label: "approve" });
  status.blocked({ active: false });
  status.parent(false);
  status.subagents({ children: 0, workflows: 0 });
  await flush();
  assert.deepEqual(sent, []);
});

test("keeps a settled parent working while subagents run, then mirrors the integration", async () => {
  const { status, states, metadata, sent } = fixture();
  status.start(true);
  status.subagents({ children: 2, workflows: 0 });
  await flush();
  status.parent(false);
  await flush();
  assert.deepEqual(states(), ["working"]); // Settling with children running is not a change.
  const report = sent[0].params;
  assert.deepEqual({ ...report, seq: undefined }, {
    pane_id: "w1:p1", source: "herdr:pi", agent: "pi", state: "working", message: undefined, seq: undefined,
    agent_session_path: "/sessions/parent.jsonl",
  });
  assert.deepEqual(metadata().map(m => m.state_labels), [{ working: "working + 2 subagents" }, { working: "2 subagents" }]);
  assert.ok(metadata().every(m => m.source === "pi-subagents" && m.applies_to_source === "herdr:pi"));

  for (const step of [
    () => status.blocked({ active: true, label: "approve rm -rf" }),
    () => status.subagents({ children: 1, workflows: 1 }),
    () => status.blocked({ active: false }),
    () => status.subagents({ children: 0, workflows: 0 }),
  ]) { step(); await flush(); }
  assert.deepEqual(states(), ["working", "blocked", "working", "idle"]);
  assert.equal(sent.find(r => r.params.state === "blocked")?.params.message, "approve rm -rf");
  assert.deepEqual(metadata().at(-2)?.state_labels, { working: "1 subagent, 1 workflow" });
  assert.deepEqual(metadata().at(-1), {
    pane_id: "w1:p1", source: "pi-subagents", applies_to_source: "herdr:pi", seq: metadata().at(-1)?.seq,
    clear_state_labels: true, tokens: { subagents: null },
  });

  // Engaged reports outrank the integration for the runtime, so parent turns must still be mirrored.
  status.parent(true);
  status.parent(false);
  await flush();
  assert.deepEqual(states(), ["working", "blocked", "working", "idle", "working", "idle"]);
});

test("seqs outrank the integration's load-time counter and never repeat on a frozen clock", async () => {
  const loadedAt = 1_000_000;
  const { status, sent } = fixture(() => loadedAt);
  status.subagents({ children: 1, workflows: 0 });
  status.subagents({ children: 2, workflows: 0 });
  status.subagents({ children: 0, workflows: 0 });
  await flush();
  const seqs = sent.map(r => r.params.seq);
  assert.ok(seqs[0] > loadedAt * 1000 + 100); // Integration: loadedAt * 1000 + reports so far.
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test("coalesces to the latest report while a delivery is in flight", async () => {
  const sent: Request[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const status = new HerdrStatus("w1:p1", async request => { sent.push(request as Request); if (sent.length === 1) await blocked; }, () => ({ agent_session_id: "s" }));
  status.subagents({ children: 1, workflows: 0 });
  status.subagents({ children: 2, workflows: 0 });
  status.subagents({ children: 3, workflows: 0 });
  release();
  await flush(); await flush();
  assert.deepEqual(sent.map(r => r.method), ["pane.report_agent", "pane.report_metadata"]);
  assert.deepEqual(sent[1].params.state_labels, { working: "3 subagents" });
});

test("delivery failures are swallowed and dispose stops reporting", async () => {
  let calls = 0;
  const status = new HerdrStatus("w1:p1", async () => { calls++; throw new Error("socket gone"); }, () => ({ agent_session_id: "s" }));
  status.subagents({ children: 1, workflows: 0 });
  await flush();
  assert.equal(calls, 2);
  await status.dispose(); // Clearing the shown label fails quietly too.
  assert.equal(calls, 3);
  status.subagents({ children: 0, workflows: 0 });
  status.parent(true);
  await status.dispose();
  await flush();
  assert.equal(calls, 3);
});

test("dispose clears labels and tokens that would outlive the runtime", async () => {
  const { status, metadata, states } = fixture();
  await status.dispose();
  assert.deepEqual(metadata(), []); // Never engaged: still silent.

  const engaged = fixture();
  engaged.status.subagents({ children: 2, workflows: 0 });
  await flush();
  await engaged.status.dispose();
  assert.deepEqual(engaged.metadata().at(-1), {
    pane_id: "w1:p1", source: "pi-subagents", applies_to_source: "herdr:pi", seq: engaged.metadata().at(-1)?.seq,
    clear_state_labels: true, tokens: { subagents: null },
  });
  assert.ok(engaged.metadata().at(-1)!.seq > engaged.metadata()[0].seq);
  assert.deepEqual(engaged.states(), ["working"]); // State is left for the next runtime or process exit.

  const finished = fixture();
  finished.status.subagents({ children: 1, workflows: 0 });
  finished.status.subagents({ children: 0, workflows: 0 });
  await flush();
  const sent = finished.sent.length;
  await finished.status.dispose();
  assert.equal(finished.sent.length, sent); // Already cleared.
  assert.deepEqual(states(), []);
});

test("only enabled inside a herdr pane", () => {
  const ref = () => ({ agent_session_id: "s" });
  assert.equal(HerdrStatus.fromEnv({}, ref), undefined);
  assert.equal(HerdrStatus.fromEnv({ HERDR_ENV: "0", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" }, ref), undefined);
  assert.equal(HerdrStatus.fromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, ref), undefined);
  assert.ok(HerdrStatus.fromEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" }, ref));
});

test("writes newline-delimited JSON requests to herdr's socket", { skip: process.platform === "win32" }, async () => {
  const dir = tempRoot("subagents-herdr-");
  const socket = join(dir, "herdr.sock");
  const received: Request[] = [];
  const server = createServer(connection => connection.on("data", data => {
    for (const line of String(data).split("\n").filter(Boolean)) received.push(JSON.parse(line));
    connection.end(`${JSON.stringify({ id: received.at(-1)!.id, result: { type: "ok" } })}\n`);
  }));
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const status = HerdrStatus.fromEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w9:p2" }, () => ({ agent_session_id: "s" }))!;
    status.subagents({ children: 1, workflows: 0 });
    for (let i = 0; i < 100 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(received.map(r => [r.method, r.params.pane_id]), [["pane.report_agent", "w9:p2"], ["pane.report_metadata", "w9:p2"]]);
    assert.notEqual(received[0].id, received[1].id);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
