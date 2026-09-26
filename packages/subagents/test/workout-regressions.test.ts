import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isCancellationError, SubagentManager } from "../src/manager.js";
import { NoticeScheduler } from "../src/notifications.js";
import { summarizeAgents } from "../src/usage.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function setup(maxChildren = 4) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-workout-"));
  const manager = new SubagentManager(join(dir, "manager"), undefined, undefined, maxChildren);
  const options = { name: "workout", cwd: dir, executable: process.execPath, executableArgs: [fixture] };
  return { dir, manager, options, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("cancellation recognition is narrow, not a substring error suppressor", () => {
  for (const text of ["The operation was aborted.", "This operation was aborted", "Request aborted", "AbortError: The operation was aborted."]) assert.ok(isCancellationError(text));
  for (const text of [undefined, "429 quota exceeded", "Transaction aborted due to corruption", "The operation was aborted. Billing failed."]) assert.equal(isCancellationError(text), false);
});

for (const task of ["slow-codex", "slow-native", "slow-on-clear", "accept-before-start"]) {
  test(`${task}: explicit abort is idle/cancelled, not failed; next run has no inherited intent`, async () => {
    const s = await setup();
    try {
      const a = await s.manager.spawn({ ...s.options, task });
      const cancelled = await s.manager.abort(a.id);
      assert.equal(cancelled.status, "idle");
      assert.equal(cancelled.aborted, true);
      assert.equal(cancelled.error, undefined);
      assert.match(cancelled.activity!, /aborted/);
      assert.equal(s.manager.pendingNotices().at(-1)?.kind, "aborted");
      const updates = s.manager.read(a.id).updates;
      assert.ok(updates.some(u => u.kind === "aborted"));
      assert.ok(!updates.some(u => u.kind === "error"));
      await s.manager.send(a.id, "unrequested-cancel-error");
      await s.manager.wait([a.id], "all", 2000);
      assert.equal(s.manager.summary(a.id).status, "failed");
      assert.equal(s.manager.summary(a.id).aborted, false);
      assert.equal(s.manager.summary(a.id).error, "The operation was aborted.");
      assert.equal(s.manager.pendingNotices().at(-1)?.kind, "failure");
      const stopped = await s.manager.close(a.id);
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.error, undefined);
      assert.equal(stopped.lastError, "The operation was aborted.");
      assert.ok(s.manager.read(a.id).updates.some(u => u.kind === "error"));
    } finally { await s.cleanup(); }
  });
}

test("genuine provider failure racing abort stays failed and readable", async () => {
  const s = await setup();
  try {
    const a = await s.manager.spawn({ ...s.options, task: "slow-genuine" });
    const result = await s.manager.abort(a.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "429 quota exceeded");
    assert.equal(result.aborted, false);
    assert.equal(s.manager.pendingNotices().at(-1)?.kind, "failure");
    const closed = await s.manager.close(a.id);
    assert.equal(closed.error, undefined);
    assert.equal(closed.lastError, "429 quota exceeded");
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "429 quota exceeded" && u.kind === "error"));
  } finally { await s.cleanup(); }
});

test("another prompt cannot inherit an in-flight abort command", async () => {
  const s = await setup();
  try {
    const a = await s.manager.spawn({ ...s.options, task: "slow-delayed-ack" });
    const pending = s.manager.abort(a.id);
    await assert.rejects(s.manager.send(a.id, "must not run"), /Abort is still in progress/);
    await assert.rejects(s.manager.abort(a.id), /already in progress/);
    await pending;
    await s.manager.send(a.id, "normal follow-up");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.summary(a.id).aborted, false);
    assert.equal(s.manager.summary(a.id).error, undefined);
    const idle = await s.manager.abort(a.id);
    assert.equal(idle.aborted, false); // No invented cancellation of an already completed task.
    await s.manager.send(a.id, "unrequested-cancel-error");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.summary(a.id).status, "failed");
  } finally { await s.cleanup(); }
});

test("explicit close dismisses unread notices through reload but leaves results; resume can report anew", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  const sent: string[] = [];
  const scheduler = new NoticeScheduler({ idle: () => true, pending: () => s.manager.pendingNotices(), delayMs: 50,
    send: batch => { sent.push(batch.content); }, error: e => { throw e; } });
  try {
    const a = await s.manager.spawn({ ...s.options, task: "unread result" });
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.pendingNotices().length, 1);
    scheduler.wake();
    await s.manager.close(a.id);
    await s.manager.close(a.id); // Idempotent dismissal even without a live process.
    await sleep(80);
    assert.deepEqual(sent, []);
    assert.equal(s.manager.pendingNotices().length, 0);
    assert.equal(s.manager.get(a.id).readCursor, 0);
    await s.manager.shutdown();
    restored = new SubagentManager(join(s.dir, "manager"));
    assert.equal(restored.pendingNotices().length, 0);
    assert.ok(restored.read(a.id).updates.some(u => u.kind === "assistant" && u.text.includes("unread result")));
    await restored.resume(a.id, "new result");
    await restored.wait([a.id], "all", 2000);
    assert.equal(restored.pendingNotices().length, 1);
  } finally { scheduler.dispose(); await restored?.shutdown(); await s.cleanup(); }
});

for (const task of ["slow-codex", "accept-before-start"]) test(`close of ${task} classifies cancellation without a stale error or late notice`, async () => {
  const s = await setup();
  try {
    const a = await s.manager.spawn({ ...s.options, task });
    const result = await s.manager.close(a.id);
    assert.equal(result.status, "stopped");
    assert.equal(result.aborted, true);
    assert.equal(result.error, undefined);
    assert.equal(result.lastError, undefined);
    assert.deepEqual(s.manager.pendingNotices(), []);
  } finally { await s.cleanup(); }
});

test("report counters exclude lifecycle/sent echoes; overview sums cumulative cost across close/resume", async () => {
  const s = await setup();
  try {
    const a = await s.manager.spawn({ ...s.options, task: "slow-codex", env: { TEST_COST: "0.25" } });
    assert.equal(a.unread, 0);
    assert.equal(a.unreadAssistant, 0);
    assert.equal(a.unreadUpdates, 2);
    assert.equal(s.manager.overview().totals.missingCost, 0); // Startup now fetches a baseline snapshot.
    assert.equal(s.manager.overview().totals.reportedCost, 0.25);
    await s.manager.abort(a.id);
    await s.manager.close(a.id);
    const b = await s.manager.spawn({ ...s.options, task: "answer", env: { TEST_COST: "0.5" } });
    await s.manager.wait([b.id], "all", 2000);
    await s.manager.close(b.id); // Final snapshots avoid racing asynchronous stats requests.
    assert.equal(s.manager.summary(b.id).unread, 1);
    assert.equal(s.manager.summary(b.id).unreadAssistant, 1);
    assert.equal(s.manager.overview().totals.reportedCost, 0.75);
    assert.equal(s.manager.overview().totals.live, 0);
    assert.equal(s.manager.overview().totals.missingCost, 0);
    s.manager.read(b.id);
    assert.equal(s.manager.summary(b.id).unread, 0);
    await s.manager.resume(a.id, "follow-up", { TEST_COST: "0.375" });
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.overview().totals.live, 1);
    await s.manager.close(a.id);
    assert.equal(s.manager.overview().totals.reportedCost, 0.875); // Replace, don't add, a session snapshot.
    assert.equal(s.manager.overview().totals.tracked, 2);
  } finally { await s.cleanup(); }
});

test("aggregate reports missing/invalid cost instead of pretending unknown means free", () => {
  const totals = summarizeAgents([
    { status: "idle", usage: { cost: 0 }, pid: 1 }, { status: "stopped", usage: { cost: 0.5 } },
    ...[undefined, { cost: NaN }, { cost: -1 }, { cost: Infinity }, { cost: "1" }].map(usage => ({ status: "failed", usage })),
  ]);
  assert.equal(totals.reportedCost, 0.5);
  assert.equal(totals.missingCost, 5);
  assert.equal(totals.live, 1);
});

test("cap/CLI/cwd/policy rejections create no records; actual launch failures stay diagnostic", async () => {
  const s = await setup(1);
  try {
    const a = await s.manager.spawn({ ...s.options, task: "slow-codex" });
    await assert.rejects(s.manager.spawn({ ...s.options, task: "cap" }), /Live-child limit/);
    assert.equal(s.manager.list(true).length, 1);
    await s.manager.close(a.id);
    await assert.rejects(s.manager.spawn({ ...s.options, task: "invalid", cliArgs: ["--session=other"] }), /manager-owned/);
    await assert.rejects(s.manager.spawn({ ...s.options, task: "invalid", cwd: join(s.dir, "absent") }));
    assert.equal(s.manager.list(true).length, 1);
    const policy = new SubagentManager(join(s.dir, "denied"), undefined, undefined, 1, () => { throw new Error("Policy denied"); });
    await assert.rejects(policy.spawn({ ...s.options, task: "invalid" }), /Policy denied/);
    assert.deepEqual(policy.list(true), []);
    await policy.shutdown();
    await assert.rejects(s.manager.spawn({ ...s.options, task: "launch", executable: join(s.dir, "no-executable") }));
    const failed = s.manager.list().find(r => r.status === "failed")!;
    assert.ok(failed.error);
    assert.equal(s.manager.list(true).length, 2);
    assert.equal(s.manager.overview().totals.live, 0);
    const next = await s.manager.spawn({ ...s.options, task: "capacity is free" });
    assert.ok(next.pid); // Neither closed nor failed records consume live slots.
  } finally { await s.cleanup(); }
});

test("legacy never-started cap records are hidden by default, but inspectable explicitly", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    await assert.rejects(s.manager.spawn({ ...s.options, task: "launch", executable: join(s.dir, "no-executable") }));
    await s.manager.shutdown();
    const registry = join(s.dir, "manager", "registry.json");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    stored.agents.push({ ...stored.agents[0], id: "legacy-cap", error: "Error: Live-child limit (4) reached; close an idle child first." });
    await writeFile(registry, JSON.stringify(stored));
    restored = new SubagentManager(join(s.dir, "manager"));
    assert.equal(restored.list().length, 1);
    assert.equal(restored.list(true).length, 2);
    assert.equal(restored.overview(true).totals.tracked, 1);
    assert.equal(restored.summary("legacy-cap").rejected, true);
    assert.equal(restored.read("legacy-cap").id, "legacy-cap");
    assert.equal((await restored.wait([], "all", 0)).agents.length, 1);
  } finally { await restored?.shutdown(); await s.cleanup(); }
});
