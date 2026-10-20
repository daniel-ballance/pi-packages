import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cardsFromDetails } from "../extensions/subagents/src/card.js";
import { parseChildLimit, type ChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { messageLatch, waitReport, withCurrentReviews, type WaitEnd } from "../extensions/subagents/src/wait.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

async function setup(limit: ChildLimit = parseChildLimit(4), parentMessageLimit = 0) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-wait-"));
  const manager = new SubagentManager(dir, () => {}, () => {}, limit, undefined, 0, parentMessageLimit);
  const spawn = async (name: string, task = name, parentId?: string) => {
    const child = await manager.spawn({ name, task, cwd: dir, executable: process.execPath, executableArgs: [fixture], parentId });
    await manager.wait([child.id], "all", 2000);
    return child.id;
  };
  const settled = (...ids: string[]): WaitEnd => ({ wake: "settled", ids });
  const acknowledge = (receipts: ReturnType<typeof waitReport>["receipts"], byRoot = true) => {
    for (const receipt of receipts) manager.acknowledgeRead(receipt, true, byRoot);
  };
  const printedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2));
  return { manager, spawn, settled, acknowledge, printedBytes, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("a default report returns new reports inline without echoes, and acknowledging it ends the child's notices", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("alpha");
    assert.ok(s.manager.pendingNotices().some(notice => notice.id === id), "a routine report is waiting to wake the parent");
    const { report, receipts } = waitReport(s.manager, s.settled(id), true);
    assert.ok(s.manager.read(id, undefined, false).updates.length, "building the report acknowledges nothing");
    assert.deepEqual(report.agents[0].reports, [{ kind: "assistant", text: "1:alpha" }]);
    assert.equal(report.agents[0].unread, 0);
    assert.equal(cardsFromDetails(report.agents, "summary")[0].state, "unread", "nothing is reviewed before acknowledgement");
    s.acknowledge(receipts);
    assert.equal(cardsFromDetails(withCurrentReviews(s.manager, report).agents, "summary")[0].state, "reviewed");
    assert.deepEqual(s.manager.pendingNotices().filter(notice => notice.id === id), [], "no SUBAGENT REPORTS turn follows");
    assert.deepEqual(s.manager.read(id).updates, [], "the task echo was acknowledged with the report");
    assert.equal(s.manager.get(id).resultReview?.status, "reviewed");
  } finally { await s.cleanup(); }
});

test("collect false returns status only and acknowledges nothing", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("alpha");
    const before = s.manager.pendingNotices();
    const { report, receipts } = waitReport(s.manager, s.settled(id), false);
    assert.deepEqual(receipts, []);
    assert.equal(report.agents[0].reports, undefined);
    assert.equal(report.agents[0].unread, 1);
    assert.deepEqual(s.manager.pendingNotices(), before);
  } finally { await s.cleanup(); }
});

test("final keeps the last assistant report and acknowledges the rest", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("alpha");
    await s.manager.send(id, "mid");
    await s.manager.wait([id], "all", 2000);
    await s.manager.send(id, "done");
    await s.manager.wait([id], "all", 2000);
    const { report, receipts } = waitReport(s.manager, s.settled(id), true, undefined, undefined, true);
    assert.deepEqual(report.agents[0].reports, [{ kind: "assistant", text: "3:done" }]);
    assert.equal(report.agents[0].unread, 0);
    s.acknowledge(receipts);
    assert.deepEqual(s.manager.read(id, undefined, false).updates, []);
    assert.deepEqual(s.manager.pendingNotices().filter(notice => notice.id === id), []);
  } finally { await s.cleanup(); }
});

test("final returns a human intervention when that is the last update", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("held");
    const record = s.manager.get(id);
    record.updates.push({ cursor: record.cursor + 1, kind: "human_intervention", text: "halt", time: record.updatedAt });
    record.cursor += 1;
    const { report, receipts } = waitReport(s.manager, { wake: "hold", ids: [id] }, true, undefined, undefined, true);
    assert.deepEqual(report.agents[0].reports, [{ kind: "human_intervention", text: "halt" }]);
    s.acknowledge(receipts);
    assert.equal(s.manager.read(id, undefined, false).updates.some(update => update.kind === "assistant"), false);
  } finally { await s.cleanup(); }
});

test("final returns the error report when that is the last update", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("broken", "error");
    const { report, receipts } = waitReport(s.manager, s.settled(id), true, undefined, undefined, true);
    assert.deepEqual(report.agents[0].reports?.map(item => item.kind), ["error"]);
    s.acknowledge(receipts);
    assert.equal(s.manager.read(id, undefined, false).updates.some(update => update.kind === "assistant"), false);
  } finally { await s.cleanup(); }
});

test("final returns an input request and leaves a working sibling unread", async () => {
  const s = await setup();
  try {
    const asking = await s.spawn("asking", "ui");
    const busy = await s.spawn("busy", "until-abort");
    const record = s.manager.get(busy);
    record.updates.push({ cursor: record.cursor + 1, kind: "assistant", text: "still going", time: record.updatedAt });
    record.cursor += 1;
    const end = await s.manager.wait([asking, busy], "all", 50);
    assert.equal(end.wake, "input");
    const { report, receipts } = waitReport(s.manager, end, true, undefined, undefined, true);
    assert.equal(report.wake, "input");
    assert.deepEqual(report.agents[0].reports?.map(item => item.kind), ["input_requested"]);
    assert.equal(report.agents[1].reports, undefined);
    assert.equal(receipts.some(receipt => receipt.id === busy), false);
    s.acknowledge(receipts);
    assert.equal(s.manager.read(busy, undefined, false).updates.some(update => update.text === "still going"), true);
    assert.equal(s.manager.read(asking, undefined, false).updates.some(update => update.kind === "input_requested"), false);
  } finally { await s.cleanup(); }
});

test("final still returns a message from a working child and acknowledges it", async () => {
  const s = await setup(parseChildLimit(4), 3);
  try {
    const id = await s.spawn("scout", "until-abort");
    (s.manager as unknown as { messageParent(record: unknown, message: string): void }).messageParent(s.manager.get(id), "change of plan");
    const end = await s.manager.wait([id], "all", 1000);
    assert.equal(end.wake, "child_message");
    const { report, receipts } = waitReport(s.manager, end, true, undefined, undefined, true);
    assert.deepEqual(report.agents[0].reports, [{ kind: "message", text: "change of plan" }]);
    s.acknowledge(receipts);
    assert.equal((await s.manager.wait([id], "all", 50)).wake, "timeout");
  } finally { await s.cleanup(); }
});

test("collect false returns status only even when final is true", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("alpha");
    await s.manager.send(id, "later");
    await s.manager.wait([id], "all", 2000);
    const before = s.manager.pendingNotices();
    const { report, receipts } = waitReport(s.manager, s.settled(id), false, undefined, undefined, true);
    assert.deepEqual(receipts, []);
    assert.equal(report.agents[0].reports, undefined);
    assert.equal(report.agents[0].unread, 2);
    assert.deepEqual(s.manager.pendingNotices(), before);
  } finally { await s.cleanup(); }
});

test("a final report that does not fit stays unread and earlier reports are acknowledged", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("long", "x".repeat(2000));
    await s.manager.send(id, "y".repeat(2000));
    await s.manager.wait([id], "all", 2000);
    const limits = { bytes: s.printedBytes(waitReport(s.manager, s.settled(id), false).report) + 500, lines: 750 };
    const { report, receipts } = waitReport(s.manager, s.settled(id), true, undefined, limits, true);
    assert.equal(report.agents[0].reports, undefined);
    assert.equal(report.agents[0].unread, 1);
    s.acknowledge(receipts);
    assert.deepEqual(s.manager.read(id, undefined, false).updates.filter(update => update.kind === "assistant").map(update => update.text), [`2:${"y".repeat(2000)}`]);
  } finally { await s.cleanup(); }
});

test("final does not charge earlier reports against the cap", async () => {
  const s = await setup(parseChildLimit(6));
  try {
    const ids = [];
    for (const name of ["a", "b", "c"]) {
      const id = await s.spawn(name, `${name}:${"z".repeat(1500)}`);
      await s.manager.send(id, "done");
      await s.manager.wait([id], "all", 2000);
      ids.push(id);
    }
    const limits = { bytes: s.printedBytes(waitReport(s.manager, s.settled(...ids), false).report) + 800, lines: 750 };
    const open = waitReport(s.manager, s.settled(...ids), true, undefined, limits);
    const closed = waitReport(s.manager, s.settled(...ids), true, undefined, limits, true);
    assert.ok(s.printedBytes(closed.report) <= limits.bytes);
    assert.deepEqual(closed.report.agents.map(agent => agent.reports?.map(item => item.text)), [["2:done"], ["2:done"], ["2:done"]]);
    assert.ok((open.report.agents.reduce((sum, agent) => sum + (agent.reports?.length ?? 0), 0)) < 3);
  } finally { await s.cleanup(); }
});

test("a child spawned with a 2 KB task has a wait entry without the task or its session file", async () => {
  const s = await setup();
  try {
    const task = "t".repeat(2048);
    const id = await s.spawn("big", task);
    const entry = JSON.stringify(waitReport(s.manager, s.settled(id), false).report.agents[0]);
    assert.equal(entry.includes(task), false);
    assert.equal(entry.includes(s.manager.get(id).sessionFile), false);
    assert.ok(Buffer.byteLength(entry) < 400, entry);
  } finally { await s.cleanup(); }
});

test("reports fill the room the status entries leave, as a contiguous prefix with the rest unread", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("long", "x".repeat(2000));
    await s.manager.send(id, "y".repeat(2000));
    await s.manager.wait([id], "all", 2000);
    const limits = { bytes: s.printedBytes(waitReport(s.manager, s.settled(id), false).report) + 2500, lines: 750 };
    const first = waitReport(s.manager, s.settled(id), true, undefined, limits);
    assert.deepEqual(first.report.agents[0].reports?.map(report => report.text), [`1:${"x".repeat(2000)}`]);
    assert.equal(first.report.agents[0].unread, 1);
    assert.ok(s.printedBytes(first.report) <= limits.bytes);
    s.acknowledge(first.receipts);
    const second = waitReport(s.manager, s.settled(id), true, undefined, limits);
    assert.deepEqual(second.report.agents[0].reports?.map(report => report.text), [`2:${"y".repeat(2000)}`]);
    assert.equal(second.report.agents[0].unread, 0);
  } finally { await s.cleanup(); }
});

test("a first report too large for the room is not returned and stays unread", async () => {
  const s = await setup();
  try {
    const id = await s.spawn("long", "x".repeat(2000));
    const limits = { bytes: s.printedBytes(waitReport(s.manager, s.settled(id), false).report) + 500, lines: 750 };
    const { report, receipts } = waitReport(s.manager, s.settled(id), true, undefined, limits);
    assert.equal(report.agents[0].reports, undefined);
    assert.equal(report.agents[0].unread, 1);
    s.acknowledge(receipts);
    assert.ok(s.manager.pendingNotices().some(notice => notice.id === id));
    assert.ok(s.manager.read(id, undefined, false).updates.some(update => update.kind === "assistant"));
  } finally { await s.cleanup(); }
});

test("a large selection trims reports to stay inside the limit instead of spilling", async () => {
  const s = await setup(parseChildLimit(6));
  try {
    const ids = await Promise.all(["a", "b", "c", "d", "e", "f"].map(name => s.spawn(name, `${name}:${"z".repeat(1500)}`)));
    const limits = { bytes: 6000, lines: 750 };
    const { report } = waitReport(s.manager, s.settled(...ids), true, undefined, limits);
    const returned = report.agents.reduce((sum, agent) => sum + (agent.reports?.length ?? 0), 0);
    assert.ok(s.printedBytes(report) <= limits.bytes);
    assert.ok(returned >= 1 && returned < ids.length, String(returned));
    assert.equal(returned + report.agents.reduce((sum, agent) => sum + agent.unread, 0), ids.length);
  } finally { await s.cleanup(); }
});

test("a root wait leaves a live coordinator's child to it, and the coordinator's wait collects that child", async () => {
  const s = await setup();
  try {
    const coordinator = await s.spawn("coordinator");
    const worker = await s.spawn("worker", "worker", coordinator);
    const root = waitReport(s.manager, s.settled(coordinator, worker), true);
    assert.deepEqual(root.report.agents.map(agent => agent.reports?.map(report => report.text)), [["1:coordinator"], undefined]);
    assert.equal(root.report.agents[1].unread, 1);
    s.acknowledge(root.receipts);
    assert.ok(s.manager.read(worker, undefined, false).updates.some(update => update.text === "1:worker"), "still unread for the coordinator");
    const delegated = waitReport(s.manager, s.settled(worker), true, coordinator);
    assert.deepEqual(delegated.report.agents[0].reports, [{ kind: "assistant", text: "1:worker" }]);
    s.acknowledge(delegated.receipts, false);
    assert.deepEqual(s.manager.read(worker, undefined, false).updates, []);
  } finally { await s.cleanup(); }
});

test("the message latch reports each queued batch once and re-arms when the queue empties", () => {
  const latch = messageLatch();
  assert.deepEqual([false, true, true, true, false, true, true].map(latch), [false, true, false, false, false, true, false]);
});
