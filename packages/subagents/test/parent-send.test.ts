import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager, type Notice } from "../extensions/subagents/src/manager.js";
import { noticeBatch } from "../extensions/subagents/src/notifications.js";
import { parsePolicy } from "../extensions/subagents/src/policy.js";
import { waitReport } from "../extensions/subagents/src/wait.js";
import { parseWorkflow } from "../extensions/subagents/src/workflow-definition.js";
import { tempRoot } from "./support/temp-root.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

// parent_send arrives over the private pipe; these tests call its manager handler directly.
async function setup(limit = 3) {
  const dir = tempRoot("subagent-parent-send-");
  const notices: Notice[] = [];
  const manager = new SubagentManager(dir, notice => notices.push(notice), () => {}, parseChildLimit(4), undefined, 0, limit);
  const spawn = async (name: string, task: string, parentId?: string) =>
    (await manager.spawn({ name, task, cwd: dir, executable: process.execPath, executableArgs: [fixture], parentId })).id;
  const tell = (id: string, message: string) => (manager as any).messageParent(manager.get(id), message);
  return { manager, notices, spawn, tell, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("a message from a working child ends the parent's wait and is collected as a report", async () => {
  const t = await setup();
  try {
    const id = await t.spawn("scout", "slow scouting");
    assert.equal(t.manager.get(id).status, "working");
    assert.equal((await t.manager.wait([id], "all", 50)).wake, "timeout");
    assert.deepEqual(t.tell(id, "The API is v2: change of plan."), { delivery: "queued", to: "parent", remaining: 2 });
    assert.equal(t.notices.at(-1)?.kind, "message");
    assert.ok(t.manager.pendingNotices().some(notice => notice.kind === "message"));
    const end = await t.manager.wait([id], "all", 1000);
    assert.equal(end.wake, "child_message");
    assert.equal(t.manager.get(id).status, "working", "the child keeps working");
    const { report, receipts } = waitReport(t.manager, end, true);
    assert.deepEqual(report.agents[0].reports, [{ kind: "message", text: "The API is v2: change of plan." }]);
    for (const receipt of receipts) t.manager.acknowledgeRead(receipt, true);
    assert.equal(t.manager.pendingNotices().some(notice => notice.kind === "message"), false, "collecting acknowledges it");
    assert.equal((await t.manager.wait([id], "all", 50)).wake, "timeout", "a collected message does not wake the next wait");
    // collect:false acknowledges nothing, so the next wait wakes again, like a pending input request.
    t.tell(id, "Second thing.");
    const peek = await t.manager.wait([id], "all", 1000);
    waitReport(t.manager, peek, false);
    assert.equal((await t.manager.wait([id], "all", 50)).wake, "child_message");
  } finally { await t.cleanup(); }
});

test("the parent's report batch labels the message and says how to answer it", () => {
  const batch = noticeBatch([{ id: "sa-1", name: "scout", kind: "message", text: "Need a decision.", cursor: 4, key: "sa-1:4:message" }]);
  assert.match(batch.content, /\[message\]: "Need a decision\."/);
  assert.match(batch.content, /subagent_send/);
  assert.doesNotMatch(noticeBatch([{ id: "sa-1", name: "scout", kind: "completed", text: "Done.", cursor: 5, key: "sa-1:5:completed" }]).content, /\[message\] was sent/);
});

test("the message limit counts per assignment and a new assignment resets it", async () => {
  const t = await setup(2);
  try {
    const id = await t.spawn("worker", "slow first task");
    t.tell(id, "one"); t.tell(id, "two");
    assert.throws(() => t.tell(id, "three"), /Message limit reached for this assignment \(2\)/);
    assert.equal(t.manager.get(id).updates.filter(update => update.kind === "message").length, 2);
    await t.manager.abort(id);
    await t.manager.wait([id], "all", 2000);
    await t.manager.send(id, "slow second task");
    assert.equal(t.tell(id, "fresh").remaining, 1);
  } finally { await t.cleanup(); }
});

test("a nested child's message goes to the coordinator that spawned it, and to the root once that coordinator stops", async () => {
  const t = await setup();
  try {
    const a = await t.spawn("coordinator", "slow coordinating");
    const b = await t.spawn("leaf", "slow leaf work", a);
    assert.equal(t.tell(b, "leaf finding").to, a);
    assert.equal(t.manager.pendingNotices().some(notice => notice.id === b), false, "not the root's report");
    assert.equal((await t.manager.wait([b], "all", 100)).wake, "timeout", "the root's wait ignores it");
    assert.equal((await t.manager.wait([b], "all", 1000, undefined, undefined, a)).wake, "child_message", "the coordinator's wait ends");
    await (t.manager as any).closeOne(t.manager.get(a), false);
    assert.ok(t.manager.pendingNotices().some(notice => notice.id === b && notice.kind === "message"), "an orphaned message reaches the root");
    assert.equal((await t.manager.wait([b], "all", 1000)).wake, "child_message");
  } finally { await t.cleanup(); }
});

test("held children and workflow workers cannot message the parent", async () => {
  const t = await setup();
  try {
    const id = await t.spawn("held", "slow work");
    await t.manager.intervene(id, "halt");
    assert.throws(() => t.tell(id, "after the halt"), /under human halt hold/);
    const worker = await t.spawn("worker", "slow work");
    t.manager.get(worker).workflow = "run-1";
    assert.throws(() => t.tell(worker, "hello"), /workflow runtime/);
  } finally { await t.cleanup(); }
});

test("parentMessageLimit is off unless set and is bounded", () => {
  const base = { version: 1, models: [] };
  assert.equal(parsePolicy(base).parentMessageLimit, 0);
  assert.equal(parsePolicy({ ...base, parentMessageLimit: 5 }).parentMessageLimit, 5);
  for (const bad of [-1, 1001, 1.5, "5"]) assert.throws(() => parsePolicy({ ...base, parentMessageLimit: bad }), /parentMessageLimit/);
});

test("workflow workers and agent validators cannot select parent_send", () => {
  const worker = (tools: string[]) => ({ model: "test/model:high", tools });
  const definition = (taskTools: string[], validatorTools: string[]) => ({
    version: 1, name: "w", cwd: "/tmp", limits: { concurrency: 1, maxAttempts: 2, timeoutSeconds: 60 },
    steps: [
      { id: "a", kind: "task", worker: worker(taskTools), instructions: "Do it." },
      { id: "b", kind: "check", input: "a", validator: { kind: "agent", worker: worker(validatorTools), instructions: "Judge it." } },
    ],
  });
  assert.doesNotThrow(() => parseWorkflow(definition(["read"], ["read"])));
  assert.throws(() => parseWorkflow(definition(["parent_send"], ["read"])), /cannot select parent_send/);
  assert.throws(() => parseWorkflow(definition(["read"], ["parent_send"])), /cannot select parent_send/);
});
