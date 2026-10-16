import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SubagentManager, type Notice } from "../extensions/subagents/src/manager.js";
import { cardsFromDetails, listingLine } from "../extensions/subagents/src/card.js";
import { JsonlDecoder, RpcChild } from "../extensions/subagents/src/rpc.js";
import { managerWorkflowHost, type AgentJob } from "../extensions/subagents/src/workflow-host.js";
import type { SubagentPolicy } from "../extensions/subagents/src/policy.js";
const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
async function setup(limit = 4) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-test-"));
  const notices: Notice[] = [];
  const costs: number[] = [];
  const manager = new SubagentManager(dir, n => notices.push(n), () => costs.push(manager.overview().totals.reportedCost), limit);
  const spawn = (task: string) => manager.spawn({ name: task, task, cwd: dir, executable: process.execPath, executableArgs: [fixture] });
  return { dir, manager, spawn, notices, costs, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("JSONL framing preserves Unicode separators and split records", () => {
  const packets: unknown[] = [];
  const decoder = new JsonlDecoder(packet => packets.push(packet));
  decoder.push('{"text":"a\u2028b\u2029');
  decoder.push('c"}\r\n\n{"n":2}\n');
  assert.deepEqual(packets, [{ text: "a\u2028b\u2029c" }, { n: 2 }]);
  assert.throws(() => new JsonlDecoder(() => {}, 8).push("123456789"), /exceeded/);
});

test("UI response transport awaits stdin write callback errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-rpc-write-"));
  const rpc = new RpcChild({
    executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: dir, env: process.env,
    event() {}, stderr() {}, exit() {},
  });
  const stdin = rpc.child.stdin as typeof rpc.child.stdin & { write: (...args: any[]) => boolean };
  const originalWrite = stdin.write;
  try {
    stdin.write = ((_chunk: string, callback: (error?: Error | null) => void) => {
      setImmediate(() => callback(new Error("simulated stdin failure")));
      return true;
    }) as typeof stdin.write;
    await assert.rejects(rpc.respond({ type: "extension_ui_response", id: "ui-1", confirmed: false }), /simulated stdin failure/);
  } finally {
    stdin.write = originalWrite;
    await rpc.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("human SIGKILL rejects signal failure and unconfirmed close, then permits retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-rpc-kill-"));
  const rpc = new RpcChild({
    executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: dir, env: process.env,
    event() {}, stderr() {}, exit() {},
  });
  const target = rpc as unknown as { signal: (signal: NodeJS.Signals, strict?: boolean) => Error | undefined };
  const originalSignal = target.signal.bind(rpc);
  try {
    target.signal = () => new Error("EPERM: signal rejected");
    await assert.rejects(rpc.kill(20), /EPERM/);
    assert.equal(rpc.child.exitCode, null);
    target.signal = () => undefined; // Simulate accepted signal with a wedged process that never closes.
    await assert.rejects(rpc.kill(25), /process close was not confirmed/);
    assert.equal(rpc.child.exitCode, null);
    target.signal = originalSignal;
    await rpc.kill();
    assert.equal(rpc.child.signalCode, "SIGKILL");
  } finally {
    target.signal = originalSignal;
    await rpc.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel children, incremental read, follow-up and usage", async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([s.spawn("alpha"), s.spawn("beta")]);
    assert.notEqual(a.id, b.id);
    const settled = await s.manager.wait([a.id, b.id], "all", 2000);
    assert.equal(settled.timedOut, false);
    assert.equal(settled.agents.every(a => a.status === "idle"), true);
    const first = s.manager.read(a.id);
    assert.ok(first.updates.some(u => u.text === "1:alpha"));
    assert.equal(s.manager.read(a.id).updates.length, 0);
    await s.manager.send(a.id, "follow-up");
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "2:follow-up"));
    assert.equal(s.notices.filter(n => n.kind === "completed").length, 3);
    assert.equal(s.manager.read(a.id, 0).gap, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((s.manager.get(a.id).usage as { userMessages: number }).userMessages, 2);
  } finally { await s.cleanup(); }
});

test("consumed input restores assignment state and does not leave phantom work", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("CONSUME");
    assert.equal(a.lastSubmission?.disposition, "handled");
    assert.equal(a.assignment, undefined);
    assert.equal(a.status, "idle");
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, false);
    await s.manager.send(a.id, "complete");
    await s.manager.wait([a.id], "all", 2000);
    const assignment = structuredClone(s.manager.get(a.id).assignment);
    assert.equal((await s.manager.send(a.id, "CONSUME")).disposition, "handled");
    assert.deepEqual(s.manager.get(a.id).assignment, assignment);
    await s.manager.send(a.id, "slow-native");
    const running = structuredClone(s.manager.get(a.id).assignment);
    for (const behavior of ["steer", "followUp"] as const) {
      assert.equal((await s.manager.send(a.id, "CONSUME", behavior)).disposition, "handled");
      assert.deepEqual(s.manager.get(a.id).assignment, running);
      assert.deepEqual(s.manager.get(a.id).queuedAssignments ?? [], []);
      assert.equal(s.manager.get(a.id).status, "working");
    }
  } finally { await s.cleanup(); }
});

test("idle usage entries refresh authoritative costs without an assistant event", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("CONSUME");
    await s.manager.send(a.id, "IDLE USAGE");
    const deadline = Date.now() + 2000;
    while ((s.manager.get(a.id).usage as { cost?: number })?.cost !== 0.25 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(s.manager.get(a.id).status, "idle");
    assert.equal((s.manager.get(a.id).usage as { cost: number }).cost, 0.25);
    assert.equal(s.manager.overview().totals.reportedCost, 0.25);
    assert.equal(s.manager.read(a.id).updates.some(update => update.kind === "assistant"), false);
  } finally { await s.cleanup(); }
});

test("listing keeps footer cache-hit and auto-compaction across usage refresh", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("footer-stats");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.refreshUsageSnapshots();
    const usage = s.manager.get(a.id).usage as { cacheHitRate?: number; autoCompaction?: boolean };
    assert.equal(usage.autoCompaction, true);
    assert.equal(usage.cacheHitRate, (300 / 420) * 100);
    const [card] = cardsFromDetails(s.manager.list().filter(agent => agent.id === a.id), "summary");
    assert.match(listingLine(card).text, new RegExp(`^\\* footer-stats \\(${a.id}\\) · unread · test/fake:medium · completed · \\d+s · 1 turn · ↑1\\.2k ↓340 R12k W800 CH71\\.4% 12\\.4%/272k \\(auto\\)$`));
  } finally { await s.cleanup(); }
});

test("usage and footer refresh before a multi-turn child settles, without double counting", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("live-usage");
    const deadline = Date.now() + 2000;
    while ((s.manager.get(a.id).usage as { cost?: number })?.cost !== 0.125 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(s.manager.get(a.id).status, "working");
    assert.equal((s.manager.get(a.id).usage as { assistantMessages: number }).assistantMessages, 1);
    assert.equal(s.manager.overview().totals.reportedCost, 0.125);
    assert.ok(s.costs.includes(0.125), "UI change callback receives mid-run cost");
    await s.manager.close(a.id);
    assert.equal(s.manager.overview().totals.reportedCost, 0.25);
  } finally { await s.cleanup(); }
});

test("acceptance before agent_start cannot cause a premature idle result", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("accept-before-start");
    assert.equal(a.status, "working");
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, true);
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "late start finished"));
  } finally { await s.cleanup(); }
});

test("abort retains process, redirection works; resuming a live child must not close it", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow initial");
    const pid = a.pid;
    await assert.rejects(s.manager.resume(a.id), /already has a process/);
    assert.equal(s.manager.get(a.id).pid, pid);
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, true);
    await assert.rejects(s.manager.send(a.id, "unqualified"), /Already working/);
    await s.manager.abort(a.id);
    assert.equal(s.manager.get(a.id).status, "idle");
    assert.equal(s.manager.get(a.id).pid, pid);
    await s.manager.send(a.id, "redirect");
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "2:redirect"));
    await s.manager.close(a.id);
    await s.manager.close(a.id);
    assert.equal(s.manager.get(a.id).status, "stopped");
    assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  } finally { await s.cleanup(); }
});

test("human halt persists before synchronous workflow hook, cancels queues, and requires explicit release", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.manager.spawn({ name: "worker", task: "slow-native", cwd: s.dir, workflow: "wf-1", coordination: { owns: ["src/a.ts"], outputs: ["report"] }, executable: process.execPath, executableArgs: [fixture] });
    const pid = a.pid;
    let called = false;
    s.manager.setInterventionHook((record, kind) => {
      called = true;
      assert.equal(kind, "halt");
      assert.equal(record.hold?.outcome, "pending");
      assert.equal(requireRegistry(s.dir).agents[0].hold.kind, "halt");
    });
    const pending = s.manager.intervene(a.id, "halt");
    assert.equal(called, true, "hook runs synchronously before cancellation awaits");
    const requested = s.manager.pendingNotices().find(n => n.kind === "human_intervention")!;
    s.manager.markNoticesDelivered([requested.key]); // An in-flight requested receipt cannot erase confirmation.
    await pending;
    assert.equal(s.manager.get(a.id).hold?.outcome, "confirmed", s.manager.get(a.id).hold?.detail);
    assert.equal(s.manager.get(a.id).assignment?.status, "cancelled");
    assert.match(s.manager.pendingNotices().find(n => n.kind === "human_intervention")!.text, /confirmed/);
    assert.equal(s.manager.get(a.id).pid, pid);
    assert.deepEqual(s.manager.list()[0].coordination, { owns: ["src/a.ts"], outputs: ["report"] });
    assert.equal(s.manager.read(a.id).resultReview?.status, "reviewed");
    assert.equal(s.manager.pendingNotices().filter(n => n.kind === "human_intervention").length, 1);
    await assert.rejects(s.manager.send(a.id, "escape"), /human halt hold/);
    await assert.rejects(s.manager.respond(a.id, "anything", {}), /human halt hold/);
    await s.manager.close(a.id);
    assert.equal(s.manager.pendingNotices().filter(n => n.kind === "human_intervention").length, 1);
    await s.manager.shutdown();
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).hold?.kind, "halt");
    assert.equal(restored.pendingNotices().filter(n => n.kind === "human_intervention").length, 1);
    await assert.rejects(restored.resume(a.id, "escape"), /human halt hold/);
    restored.releaseHold(a.id);
    assert.equal(restored.get(a.id).status, "stopped");
    assert.equal(restored.get(a.id).assignment?.status, "cancelled");
    await restored.resume(a.id, "new assignment");
    await restored.wait([a.id], "all", 2000);
    assert.equal(restored.get(a.id).assignment?.status, "completed");
    assert.equal(restored.get(a.id).resultReview?.status, "unreviewed");
    assert.equal(restored.read(a.id).resultReview?.status, "reviewed");
    const keys = restored.pendingNotices().filter(n => n.kind === "human_intervention").map(n => n.key);
    restored.markNoticesDelivered(keys);
    assert.equal(restored.pendingNotices().filter(n => n.kind === "human_intervention").length, 0);
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

function requireRegistry(dir: string) {
  return JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
}

test("human kill uses immediate SIGKILL, retains a failed hold on cancellation error", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow-native");
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const stop = child.stop.bind(child);
    child.stop = () => { throw new Error("graceful stop must never be called"); };
    await s.manager.intervene(a.id, "kill");
    child.stop = stop;
    assert.equal(s.manager.get(a.id).pid, undefined);
    assert.equal(s.manager.get(a.id).hold?.kind, "kill");
    assert.equal(s.manager.get(a.id).hold?.outcome, "confirmed");
    assert.equal(s.manager.get(a.id).assignment?.status, "cancelled");
    const [requested, final] = s.manager.pendingNotices().filter(n => n.id === a.id && n.kind === "human_intervention");
    assert.ok(requested && final);
    s.manager.markNoticesDelivered([requested.key]);
    assert.equal(s.manager.pendingNotices().find(n => n.key === final.key)?.text.includes("confirmed"), true);
    await assert.rejects(s.manager.resume(a.id), /human kill hold/);
    const b = await s.spawn("slow-native");
    const failing = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(b.id)!;
    const original = failing.kill.bind(failing);
    let rejectKill!: (error: Error) => void;
    failing.kill = () => new Promise((_resolve, reject) => { rejectKill = reject; });
    const attempt = s.manager.intervene(b.id, "kill");
    await assert.rejects(s.manager.intervene(b.id, "kill"), /already under human kill hold/);
    rejectKill(new Error("simulated kill failure"));
    await attempt;
    assert.equal(s.manager.get(b.id).hold?.outcome, "failed");
    assert.equal(s.manager.get(b.id).assignment?.status, "running");
    assert.equal((await s.manager.wait([b.id], "all", 0)).needsHold, true);
    assert.match(s.manager.pendingNotices().findLast(n => n.id === b.id && n.kind === "human_intervention")!.text, /failed.*simulated kill failure/);
    failing.kill = original;
    await s.manager.intervene(b.id, "kill");
    assert.equal(s.manager.get(b.id).hold?.outcome, "confirmed");
    assert.equal(s.manager.get(b.id).pid, undefined);
  } finally { await s.cleanup(); }
});

test("human halt leaves only supervisory notices for routine cancellation through read, close and reload", async () => {
  for (const task of ["slow-native", "slow-on-clear"]) {
    const s = await setup();
    let restored: SubagentManager | undefined;
    try {
      const a = await s.spawn(task);
      await s.manager.intervene(a.id, "halt");
      assert.equal(s.manager.get(a.id).hold?.outcome, "confirmed");
      assert.equal(s.manager.get(a.id).aborted, true);
      assert.deepEqual(s.manager.pendingNotices().filter(n => n.id === a.id).map(n => n.kind),
        ["human_intervention", "human_intervention"], `${task} should not announce an ordinary abort`);
      assert.equal(s.manager.read(a.id).updates.filter(u => u.kind === "human_intervention").length, 2);
      assert.deepEqual(s.manager.pendingNotices().filter(n => n.id === a.id).map(n => n.kind),
        ["human_intervention", "human_intervention"]);
      await s.manager.close(a.id);
      assert.deepEqual(s.manager.pendingNotices().filter(n => n.id === a.id).map(n => n.kind),
        ["human_intervention", "human_intervention"]);
      await s.manager.shutdown();
      restored = new SubagentManager(s.dir);
      assert.deepEqual(restored.pendingNotices().filter(n => n.id === a.id).map(n => n.kind),
        ["human_intervention", "human_intervention"]);
    } finally { await restored?.shutdown(); await s.cleanup(); }
  }
});

test("human halt does not hide a genuine failure racing cancellation", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow-genuine");
    await s.manager.intervene(a.id, "halt");
    assert.equal(s.manager.get(a.id).status, "failed");
    assert.deepEqual(s.manager.pendingNotices().filter(n => n.id === a.id).map(n => n.kind),
      ["human_intervention", "failure", "human_intervention"]);
    assert.match(s.manager.pendingNotices().find(n => n.id === a.id && n.kind === "failure")!.text, /429 quota exceeded/);
  } finally { await s.cleanup(); }
});

test("spawn, list, overview, summary and read return detached model-facing snapshots", async () => {
  const s = await setup();
  try {
    const spawned = await s.manager.spawn({ name: "snapshot", task: "split-settle", cwd: s.dir,
      coordination: { owns: ["src/a.ts"], outputs: ["report"] }, executable: process.execPath, executableArgs: [fixture] });
    const id = spawned.id;
    const listed = s.manager.list()[0];
    const overview = s.manager.overview().agents[0];
    const summary = s.manager.summary(id);
    const read = s.manager.read(id, 0, false);
    for (const view of [spawned, listed, overview, summary]) {
      assert.equal(view.status, "working");
      assert.equal(view.assignment?.status, "running");
    }
    await s.manager.wait([id], "all", 2000);
    assert.equal(spawned.status, "working");
    for (const view of [spawned, listed, overview, summary, read]) {
      assert.equal(view.assignment?.status, "running", "earlier tool result must not change after completion");
    }
    assert.equal(s.manager.get(id).assignment?.status, "completed");

    // Mutating a returned DTO must not write back into the live manager or its registry.
    spawned.assignment!.task = "tampered";
    listed.coordination!.owns![0] = "tampered";
    (overview.usage as { cost: number }).cost = 999;
    summary.resultReview = { assignmentId: "tampered", status: "reviewed" };
    read.updates[0].text = "tampered";
    read.assignment!.task = "tampered";
    assert.equal(s.manager.get(id).assignment?.task, "split-settle");
    assert.equal(s.manager.get(id).config.coordination?.owns?.[0], "src/a.ts");
    assert.notEqual((s.manager.get(id).usage as { cost: number }).cost, 999);
    assert.notEqual(s.manager.get(id).updates[0].text, "tampered");
    assert.equal(s.manager.get(id).resultReview?.assignmentId, s.manager.get(id).assignment?.id);
    const stored = requireRegistry(s.dir).agents[0];
    assert.equal(stored.assignment.task, "split-settle");
    assert.equal(stored.config.coordination.owns[0], "src/a.ts");
  } finally { await s.cleanup(); }
});

test("read detaches UI packets and hold details without changing acknowledgement semantics", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("ui");
    assert.equal((await s.manager.wait([a.id], "all", 2000)).needsInput, true);
    const peek = s.manager.read(a.id, undefined, false);
    assert.equal(s.manager.get(a.id).readCursor, 0);
    peek.uiRequests[0].title = "tampered";
    peek.updates[0].text = "tampered";
    assert.equal(s.manager.get(a.id).uiRequests[0].title, "Confirm test action?");
    assert.notEqual(s.manager.get(a.id).updates[0].text, "tampered");
    const receipt = s.manager.read(a.id);
    assert.ok(s.manager.get(a.id).readCursor > 0);
    assert.equal(s.manager.pendingNotices().some(n => n.id === a.id && n.kind === "input_requested"), false);
    assert.equal(receipt.uiRequests[0].title, "Confirm test action?");
    await s.manager.intervene(a.id, "halt");
    const held = s.manager.read(a.id, 0);
    held.hold!.detail = "tampered";
    held.assignment!.task = "tampered";
    held.resultReview!.assignmentId = "tampered";
    assert.notEqual(s.manager.get(a.id).hold?.detail, "tampered");
    assert.equal(s.manager.get(a.id).assignment?.task, "ui");
    assert.equal(s.manager.get(a.id).resultReview?.assignmentId, s.manager.get(a.id).assignment?.id);
    assert.equal(s.manager.pendingNotices().filter(n => n.id === a.id && n.kind === "human_intervention").length, 2);
  } finally { await s.cleanup(); }
});

test("follow-up assignments remain queued until a new run and are not replayed after abort", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow-native");
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    child.request = async (packet, timeout) => packet.type === "prompt" && packet.streamingBehavior === "followUp"
      ? undefined : request(packet, timeout);
    const original = s.manager.get(a.id).assignment?.id;
    await s.manager.send(a.id, "queued later", "followUp");
    assert.equal(s.manager.get(a.id).assignment?.id, original);
    assert.equal(s.manager.get(a.id).queuedAssignments?.length, 1);
    await s.manager.abort(a.id);
    assert.deepEqual(s.manager.get(a.id).queuedAssignments, []);
    child.request = request;
    await s.manager.send(a.id, "fresh task");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).assignment?.task, "fresh task");
    assert.equal(s.manager.get(a.id).assignment?.status, "completed");
  } finally { await s.cleanup(); }
});

test("close and shutdown discard accepted follow-up metadata without reassigning active work", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    for (const ending of ["close", "shutdown"] as const) {
      const a = await s.spawn("slow-native");
      const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
      const request = child.request.bind(child);
      child.request = async (packet, timeout) => packet.type === "prompt" && packet.streamingBehavior === "followUp"
        ? undefined : request(packet, timeout);
      await s.manager.send(a.id, `discard-${ending}`, "followUp");
      assert.equal(s.manager.get(a.id).queuedAssignments?.length, 1);
      assert.equal(s.manager.get(a.id).assignment?.task, "slow-native");
      if (ending === "close") await s.manager.close(a.id);
      else await s.manager.shutdown();
      assert.deepEqual(s.manager.get(a.id).queuedAssignments, []);
      assert.equal(s.manager.get(a.id).assignment?.task, "slow-native");
      if (ending === "shutdown") {
        restored = new SubagentManager(s.dir);
        assert.deepEqual(restored.get(a.id).queuedAssignments, []);
        assert.deepEqual(requireRegistry(s.dir).agents.find((r: { id: string }) => r.id === a.id).queuedAssignments, []);
      }
    }
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("halt reports failed confirmation if an acknowledged abort still reports streaming", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow-native");
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    child.request = async (packet, timeout) => packet.type === "get_state" ? { isStreaming: true } : request(packet, timeout);
    await s.manager.intervene(a.id, "halt");
    assert.equal(s.manager.get(a.id).hold?.outcome, "failed");
    assert.match(s.manager.get(a.id).hold!.detail!, /still reports streaming/);
    child.request = request;
  } finally { await s.cleanup(); }
});

test("a pending halt can escalate to kill without stale halt completion undoing it", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow-native");
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    child.request = async (packet, timeout) => packet.type === "clear_queue" ? (await gate, request(packet, timeout)) : request(packet, timeout);
    const halt = s.manager.intervene(a.id, "halt");
    assert.equal(s.manager.get(a.id).hold?.outcome, "pending");
    const kill = await s.manager.intervene(a.id, "kill");
    assert.equal(kill.hold?.kind, "kill");
    assert.equal(kill.hold?.outcome, "confirmed");
    unblock();
    await halt;
    assert.equal(s.manager.get(a.id).hold?.kind, "kill");
    assert.equal(s.manager.get(a.id).hold?.outcome, "confirmed");
    assert.match(s.manager.pendingNotices().findLast(n => n.kind === "human_intervention" && /Human halt/.test(n.text))!.text, /Superseded by human kill/);
    await assert.rejects(s.manager.send(a.id, "no"), /human kill hold/);
    child.request = request;
  } finally { await s.cleanup(); }
});

test("a failed halt can escalate to a confirmed kill", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow-native");
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    child.request = async (packet, timeout) => packet.type === "clear_queue" ? Promise.reject(new Error("abort transport failed")) : request(packet, timeout);
    await s.manager.intervene(a.id, "halt");
    assert.equal(s.manager.get(a.id).hold?.outcome, "failed");
    child.request = request;
    await s.manager.intervene(a.id, "kill");
    assert.equal(s.manager.get(a.id).hold?.kind, "kill");
    assert.equal(s.manager.get(a.id).hold?.outcome, "confirmed");
  } finally { await s.cleanup(); }
});

test("restored pending human holds fail closed with a recovery confirmation", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("slow-native");
    await s.manager.shutdown();
    const registry = join(s.dir, "registry.json");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    stored.agents[0].hold = { kind: "halt", at: new Date().toISOString(), outcome: "pending" };
    await writeFile(registry, JSON.stringify(stored));
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).hold?.outcome, "failed");
    assert.match(restored.get(a.id).hold!.detail!, /Parent restarted/);
    assert.match(restored.pendingNotices().findLast(n => n.kind === "human_intervention")!.text, /confirmation interrupted/);
    restored.releaseHold(a.id);
    assert.equal(restored.get(a.id).hold, undefined);
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("held prompt acceptance cannot revive state or create a post-halt assignment", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("initial");
    await s.manager.wait([a.id], "all", 2000);
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    child.request = async (packet, timeout) => {
      if (packet.type !== "prompt") return request(packet, timeout);
      await gate;
      return request(packet, timeout);
    };
    const sending = s.manager.send(a.id, "late work");
    await s.manager.intervene(a.id, "halt");
    assert.equal((await s.manager.wait([a.id], "all", 0)).needsHold, true);
    assert.throws(() => s.manager.releaseHold(a.id), /in flight/);
    release();
    await assert.rejects(sending, /held while prompt acceptance was pending/);
    assert.equal(s.manager.get(a.id).assignment?.task, "late work");
    assert.equal(s.manager.get(a.id).assignment?.status, "cancelled");
    assert.equal(s.manager.get(a.id).hold?.kind, "halt");
    child.request = request;
    const deadline = Date.now() + 2000;
    while (true) {
      try { s.manager.releaseHold(a.id); break; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    assert.equal(s.manager.get(a.id).hold, undefined);
  } finally { await s.cleanup(); }
});

test("timed-out prompt cannot make a halt safely releasable; late timeout downgrades confirmation", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("initial");
    await s.manager.wait([a.id], "all", 2000);
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    let timeOut!: () => void;
    const gate = new Promise<void>(resolve => { timeOut = resolve; });
    child.request = async (packet, timeout) => {
      if (packet.type !== "prompt") return request(packet, timeout);
      await gate;
      throw new Error("RPC prompt timed out; acceptance may be unknown. Inspect state before retrying.");
    };
    const sending = s.manager.send(a.id, "maybe accepted");
    const halted = await s.manager.intervene(a.id, "halt");
    assert.equal(halted.hold?.outcome, "confirmed", "abort acknowledgement is idle, but a prompt request is still pending");
    assert.throws(() => s.manager.releaseHold(a.id), /in flight/);
    timeOut();
    await assert.rejects(sending, /RPC prompt timed out/);
    assert.equal(s.manager.get(a.id).hold?.outcome, "failed");
    assert.ok(s.manager.get(a.id).uncertainSubmission);
    assert.match(s.manager.pendingNotices().findLast(n => n.kind === "human_intervention")!.text, /late run may still start/);
    assert.throws(() => s.manager.releaseHold(a.id), /uncertain prompt acceptance/);
    await assert.rejects(s.manager.send(a.id, "unsafe"), /human halt hold/);
    await s.manager.intervene(a.id, "kill");
    assert.equal(s.manager.get(a.id).uncertainSubmission, undefined);
    s.manager.releaseHold(a.id);
  } finally { await s.cleanup(); }
});

test("preexisting timeout makes halt confirmation fail even after an idle abort acknowledgement", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("initial");
    await s.manager.wait([a.id], "all", 2000);
    const child = (s.manager as unknown as { children: Map<string, RpcChild> }).children.get(a.id)!;
    const request = child.request.bind(child);
    child.request = async (packet, timeout) => packet.type === "prompt"
      ? Promise.reject(new Error("RPC prompt timed out; acceptance may be unknown. Inspect state before retrying."))
      : request(packet, timeout);
    await assert.rejects(s.manager.send(a.id, "maybe accepted"), /RPC prompt timed out/);
    assert.ok(s.manager.get(a.id).uncertainSubmission);
    assert.deepEqual(requireRegistry(s.dir).agents[0].uncertainSubmission, s.manager.get(a.id).uncertainSubmission);
    assert.equal((await s.manager.intervene(a.id, "halt")).hold?.outcome, "failed");
    assert.match(s.manager.get(a.id).hold!.detail!, /acceptance remains unknown/);
    assert.throws(() => s.manager.releaseHold(a.id), /uncertain prompt acceptance/);
    child.request = request;
    await s.manager.close(a.id);
    assert.equal(s.manager.get(a.id).uncertainSubmission, undefined);
    s.manager.releaseHold(a.id);
  } finally { await s.cleanup(); }
});

test("uncertain acceptance survives crash-style reload and cannot be dismissed by closing a detached record", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("initial");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.shutdown();
    const registry = join(s.dir, "registry.json");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    stored.agents[0].uncertainSubmission = { at: new Date().toISOString(), reason: "Prompt acceptance timed out" };
    stored.agents[0].hold = { kind: "halt", at: new Date().toISOString(), outcome: "confirmed" };
    await writeFile(registry, JSON.stringify(stored));
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).hold?.outcome, "failed");
    assert.ok(restored.get(a.id).uncertainSubmission);
    await restored.close(a.id);
    assert.throws(() => restored!.releaseHold(a.id), /uncertain prompt acceptance/);
    await assert.rejects(restored.resume(a.id), /human halt hold/);
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("existing manager state permissions are repaired on reopen", { skip: process.platform === "win32" }, async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("privacy");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.shutdown();
    const registry = join(s.dir, "registry.json");
    await chmod(s.dir, 0o777); await chmod(registry, 0o666);
    restored = new SubagentManager(s.dir);
    assert.equal((await stat(s.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(registry)).mode & 0o777, 0o600);
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("legacy records do not invent successful assignments; active saved assignments recover conservatively", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("slow-native");
    await s.manager.shutdown();
    const registry = join(s.dir, "registry.json");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    delete stored.agents[0].assignment;
    delete stored.agents[0].resultReview;
    await writeFile(registry, JSON.stringify(stored));
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).assignment, undefined);
    await restored.shutdown();
    restored = undefined;
    stored.agents[0].assignment = { id: "prior", task: "unknown", status: "running", at: a.createdAt };
    stored.agents[0].queuedAssignments = [{ id: "stale", task: "do not replay", at: a.createdAt, startAt: 5 }];
    stored.agents[0].status = "working";
    await writeFile(registry, JSON.stringify(stored));
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).assignment?.status, "cancelled");
    assert.deepEqual(restored.get(a.id).queuedAssignments, []);
    assert.deepEqual(requireRegistry(s.dir).agents[0].queuedAssignments, []);
    assert.equal(restored.get(a.id).resultReview?.status, "unreviewed");
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("dangling registry temp and log symlinks are rejected before creating their targets", { skip: process.platform === "win32" }, async () => {
  const s = await setup();
  const registryTarget = `${s.dir}-registry-target`, logTarget = `${s.dir}-log-target`;
  try {
    await symlink(registryTarget, join(s.dir, "registry.json.tmp"));
    assert.throws(() => s.manager.markNoticesDelivered([]), /Unsafe subagent state path/);
    await assert.rejects(access(registryTarget), error => (error as NodeJS.ErrnoException).code === "ENOENT");
    await rm(join(s.dir, "registry.json.tmp"), { force: true });

    const child = await s.spawn("privacy-log");
    await s.manager.wait([child.id], "all", 2000);
    await s.manager.shutdown();
    await rm(s.manager.get(child.id).logFile, { force: true });
    await symlink(logTarget, s.manager.get(child.id).logFile);
    assert.throws(() => new SubagentManager(s.dir), /Unsafe subagent state path/);
    await assert.rejects(access(logTarget), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(registryTarget, { force: true }); await rm(logTarget, { force: true }); await s.cleanup();
  }
});

test("shutdown restores stopped metadata and resumes the saved conversation", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("alpha");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.shutdown();
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).status, "stopped");
    assert.equal(restored.get(a.id).pid, undefined);
    await restored.resume(a.id, "remember");
    await restored.wait([a.id], "all", 2000);
    assert.ok(restored.read(a.id).updates.some(u => u.text === "2:remember"));
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("dialog responses mutate pending UI only after transport queues the write", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("ui");
    const state = await s.manager.wait([a.id], "all", 2000);
    assert.equal(state.needsInput, true);
    assert.equal(s.manager.read(a.id).uiRequests[0].id, "ui-1");
    const child = (s.manager as unknown as { children: Map<string, { respond(packet: Record<string, unknown>): Promise<void> }> }).children.get(a.id)!;
    const originalRespond = child.respond.bind(child);
    let rejectWrite: ((error: Error) => void) | undefined;
    child.respond = () => new Promise((_resolve, reject) => { rejectWrite = reject; });
    const pending = s.manager.respond(a.id, "ui-1", { confirmed: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.manager.get(a.id).status, "waiting_input");
    assert.equal(s.manager.get(a.id).uiRequests[0].id, "ui-1");
    await assert.rejects(s.manager.respond(a.id, "ui-1", { cancelled: true }), /already being submitted/);
    rejectWrite!(new Error("simulated write failure"));
    await assert.rejects(pending, /simulated write failure/);
    assert.equal(s.manager.get(a.id).status, "waiting_input");
    assert.equal(s.manager.get(a.id).uiRequests[0].id, "ui-1");
    child.respond = originalRespond;
    const delivered = await s.manager.respond(a.id, "ui-1", { confirmed: false });
    assert.deepEqual(delivered.responseDelivery, { transport: "queued", receipt: "unconfirmed" });
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "confirmed=false"));
    await assert.rejects(s.manager.respond(a.id, "ui-1", { cancelled: true }), /Unknown/);
  } finally { await s.cleanup(); }
});

test("failed runs stay addressable; crashes and bad protocol are reported", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("error");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).status, "failed");
    await s.manager.send(a.id, "recover");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).status, "idle");
    await assert.rejects(s.spawn("crash"), /Child exited/);
    await assert.rejects(s.spawn("malformed"), /JSON|Unexpected/);
  } finally { await s.cleanup(); }
});

test("concurrency, reserved flags, env persistence, and cancelled waits", async () => {
  const s = await setup(1);
  try {
    const a = await s.manager.spawn({ name: "slow", task: "slow", cwd: s.dir, executable: process.execPath, executableArgs: [fixture], env: { TEST_SECRET: "never-persist-me" } });
    await assert.rejects(s.spawn("over limit"), /limit/);
    const signal = AbortSignal.abort();
    await assert.rejects(s.manager.wait([a.id], "all", 1000, signal), /abort/i);
    assert.equal(s.manager.get(a.id).status, "working");
    const registry = await readFile(join(s.dir, "registry.json"), "utf8");
    assert.equal(registry.includes("never-persist-me"), false);
    await s.manager.close(a.id);
    await assert.rejects(s.manager.resume(a.id), /environment overrides/);
    await assert.rejects(s.manager.spawn({ name: "bad", task: "x", cwd: s.dir, cliArgs: ["--no-session"] }), /manager-owned/);
  } finally { await s.cleanup(); }
});

function workflowJobs(directory: string): AgentJob[] {
  return ["a", "b"].map(step => ({
    step, workflow: "workflow-race", cwd: directory, worker: { model: "test/fake:medium", tools: [] },
    instructions: step, candidate: join(directory, `candidate-${step}`), inputs: {},
    onChild() {}, onActivity() {},
  }));
}

function workflowPolicy(): SubagentPolicy {
  return { compile: (cwd: string) => ({ cwd, executable: process.execPath, executableArgs: [fixture] }) } as unknown as SubagentPolicy;
}

test("workflow group reservation blocks a manual spawn between sequential members", async () => {
  const s = await setup(2);
  const originalSpawn = s.manager.spawn.bind(s.manager);
  let firstStarted!: () => void, continueGroup!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const gate = new Promise<void>(resolve => { continueGroup = resolve; });
  let workflowSpawns = 0;
  s.manager.spawn = async (options, reservation) => {
    const child = await originalSpawn(options, reservation);
    if (options.workflow && ++workflowSpawns === 1) { firstStarted(); await gate; }
    return child;
  };
  const run = managerWorkflowHost(s.manager, workflowPolicy).agents(workflowJobs(s.dir), [], new AbortController().signal);
  try {
    await first;
    assert.deepEqual(s.manager.capacity(), { limit: 2, live: 1, reserved: 1, available: 0 });
    await assert.rejects(s.spawn("manual-racer"), /Live-child limit/);
    assert.equal(s.manager.list().filter(record => record.pid).length, 1);
    continueGroup();
    assert.equal((await run).length, 2);
    assert.equal(s.manager.list().filter(record => record.pid).length, 0);
    assert.deepEqual(s.manager.capacity(), { limit: 2, live: 0, reserved: 0, available: 2 });
  } finally {
    continueGroup();
    await run.catch(() => {});
    s.manager.spawn = originalSpawn;
    await s.cleanup();
  }
});

test("cancelled workflow group releases unused reservation and closes partial setup", async () => {
  const s = await setup(2);
  const originalSpawn = s.manager.spawn.bind(s.manager);
  let firstStarted!: () => void, continueGroup!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const gate = new Promise<void>(resolve => { continueGroup = resolve; });
  let workflowSpawns = 0;
  s.manager.spawn = async (options, reservation) => {
    const child = await originalSpawn(options, reservation);
    if (options.workflow && ++workflowSpawns === 1) { firstStarted(); await gate; }
    return child;
  };
  const controller = new AbortController();
  const run = managerWorkflowHost(s.manager, workflowPolicy).agents(workflowJobs(s.dir), [], controller.signal);
  try {
    await first;
    controller.abort();
    continueGroup();
    await assert.rejects(run, /abort/i);
    assert.equal(workflowSpawns, 1);
    assert.equal(s.manager.list().filter(record => record.pid).length, 0);
    const manual = await s.spawn("capacity-restored");
    assert.ok(manual.pid);
  } finally {
    continueGroup();
    await run.catch(() => {});
    s.manager.spawn = originalSpawn;
    await s.cleanup();
  }
});
