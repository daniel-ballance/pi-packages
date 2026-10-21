import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager, type AgentRecord, type Notice } from "../extensions/subagents/src/manager.js";
import { treeOrder } from "../extensions/subagents/src/inspector-data.js";
import { fitDelegatedReply } from "../extensions/subagents/src/nesting.js";
import { formatSubagentSummary } from "../extensions/subagents/src/footer.js";
import { tempRoot } from "./support/temp-root.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

// A coordinator A, its Child B, and B's Child C: the tree the root Manager keeps.
async function settledTree(authorize?: (config: AgentRecord["config"], depth: number) => AgentRecord["config"], notice: (notice: Notice) => void = () => {}) {
  const dir = tempRoot("subagent-nesting-");
  const manager = new SubagentManager(dir, notice, () => {}, parseChildLimit(4), authorize);
  const spawn = async (name: string, parentId?: string) => (await manager.spawn({ name, task: name, cwd: dir, executable: process.execPath, executableArgs: [fixture], parentId })).id;
  const a = await spawn("A"), b = await spawn("B", a), c = await spawn("C", b);
  assert.equal((await manager.wait([a, b, c], "all", 5000)).wake, "settled");
  // Stop only B, as if its process had exited: C stays live under a stopped intermediate.
  const stopOnly = (id: string) => (manager as any).closeOne(manager.get(id), false);
  return { dir, manager, a, b, c, stopOnly, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("closing a coordinator closes descendants below a stopped intermediate", async () => {
  const t = await settledTree();
  try {
    await t.stopOnly(t.b);
    assert.notEqual(t.manager.get(t.c).status, "stopped");
    await t.manager.close(t.a);
    for (const id of [t.a, t.b, t.c]) assert.equal(t.manager.get(id).status, "stopped", id);
  } finally { await t.cleanup(); }
});

test("a coordinator and its subtree delegate nothing while it is being closed or cancelled", async () => {
  const t = await settledTree();
  try {
    const open = (id: string) => (t.manager as any).assertDelegationOpen(t.manager.get(id));
    open(t.c);
    const closing = t.manager.close(t.b); // The fence is set before the first await.
    assert.throws(() => open(t.b), /being cancelled or closed/);
    assert.throws(() => open(t.c), /being cancelled or closed/);
    open(t.a);
    await closing;
    assert.equal(t.manager.get(t.c).status, "stopped");
  } finally { await t.cleanup(); }
});

test("a human hold covers the whole subtree, saved descendants included", async () => {
  const t = await settledTree();
  try {
    await t.stopOnly(t.b);
    await t.manager.intervene(t.a, "halt");
    for (const id of [t.a, t.b, t.c]) assert.equal(t.manager.get(id).hold?.kind, "halt", id);
    assert.equal(t.manager.get(t.b).hold?.outcome, "confirmed", "a saved conversation is held without a process");
    // Releasing a descendant first does not free it while its coordinator is held.
    t.manager.releaseHold(t.c);
    await assert.rejects(t.manager.send(t.c, "more"), /under human halt hold; release it first/);
    t.manager.releaseHold(t.a);
    await assert.rejects(t.manager.resume(t.b, "go"), /under human halt hold/);
  } finally { await t.cleanup(); }
});

test("a human kill of a coordinator kills live descendants and holds saved ones", async () => {
  const t = await settledTree();
  try {
    await t.stopOnly(t.b);
    await t.manager.intervene(t.a, "kill");
    assert.equal(t.manager.get(t.c).hold?.kind, "kill");
    assert.equal(t.manager.get(t.c).hold?.outcome, "confirmed");
    assert.equal(t.manager.get(t.b).hold?.kind, "halt", "nothing to kill; the saved conversation is held");
  } finally { await t.cleanup(); }
});

test("resume revalidates a nested Child at its own depth", async () => {
  const depths: number[] = [];
  const t = await settledTree((config, depth) => { depths.push(depth); return config; });
  try {
    await t.manager.close(t.a);
    depths.length = 0;
    await t.manager.resume(t.c);
    assert.ok(depths.length && depths.every(depth => depth === 3), JSON.stringify(depths));
  } finally { await t.cleanup(); }
});

test("a nested Child's input request reaches the root; its ordinary reports do not", async () => {
  const t = await settledTree();
  try {
    const announce = (kind: string, cursor: number) => (t.manager as any).announce(t.manager.get(t.c), kind, "text", cursor);
    announce("completed", 1001);
    announce("input_requested", 1002);
    const kinds = t.manager.pendingNotices().filter(notice => notice.id === t.c).map(notice => notice.kind);
    assert.deepEqual(kinds, ["input_requested"]);
  } finally { await t.cleanup(); }
});

test("inspector groups order each nested Child after its nearest listed ancestor", () => {
  const agent = (id: string, parentId?: string) => ({ id, parentId }) as AgentRecord;
  const everyone = [agent("x"), agent("a"), agent("b", "a"), agent("c", "b"), agent("d", "a"), agent("e", "z")];
  const ids = (list: AgentRecord[]) => list.map(entry => entry.id);
  assert.deepEqual(ids(treeOrder([everyone[3]!, everyone[0]!, everyone[1]!, everyone[4]!, everyone[5]!], everyone)), ["x", "a", "c", "d", "e"]);
  assert.deepEqual(ids(treeOrder(everyone)), ["x", "a", "b", "c", "d", "e"]);
});

test("a coordinator's read leaves its Child's input request for the root; the root's read settles it", async () => {
  const t = await settledTree();
  try {
    const receipt = t.manager.read(t.c, undefined, false);
    const cursor = receipt.updates.at(-1)!.cursor;
    (t.manager as any).announce(t.manager.get(t.c), "input_requested", "confirm?", cursor, "request-1");
    const withRequest = { ...receipt, uiRequests: [{ id: "request-1" }] } as typeof receipt;
    t.manager.acknowledgeRead(withRequest, true, false);
    assert.deepEqual(t.manager.pendingNotices().filter(n => n.id === t.c).map(n => n.kind), ["input_requested"]);
    t.manager.acknowledgeRead(withRequest, true, true);
    assert.deepEqual(t.manager.pendingNotices().filter(n => n.id === t.c), []);
  } finally { await t.cleanup(); }
});

test("a nested report waits for its parent, and reaches the root if that parent stops first", async () => {
  const wakes: Notice[] = [];
  const t = await settledTree(undefined, notice => wakes.push(notice));
  try {
    assert.equal(t.manager.pendingNotices().some(n => n.id === t.c), false, "B is live: B drains it");
    assert.equal(wakes.some(n => n.id === t.c), false, "the root is not woken for it");
    wakes.length = 0;
    await t.stopOnly(t.b);
    assert.deepEqual(t.manager.pendingNotices().filter(n => n.id === t.c).map(n => n.kind), ["completed"]);
    assert.ok(wakes.length > 0, "the root is woken once B is gone");
  } finally { await t.cleanup(); }
});

test("a delegated call still running when its caller exits is cancelled", async () => {
  const t = await settledTree();
  try {
    const call = new AbortController();
    (t.manager as any).callerCalls.set(t.b, new Set([call]));
    await t.stopOnly(t.b);
    assert.equal(call.signal.aborted, true);
  } finally { await t.cleanup(); }
});

test("a subtree abort or close reports descendants it could not confirm", async () => {
  const t = await settledTree();
  const manager = t.manager as any;
  try {
    const abortOne = manager.abortOne.bind(manager);
    manager.abortOne = async (record: AgentRecord) => { if (record.id === t.c) throw new Error("abort timed out"); return abortOne(record); };
    const aborted = await t.manager.abort(t.a) as { subtreeFailures?: string[] };
    assert.deepEqual(aborted.subtreeFailures, [`${t.c}: Error: abort timed out`]);
    const closeOne = manager.closeOne.bind(manager);
    manager.closeOne = async (record: AgentRecord, preserve: boolean) => { if (record.id === t.b) throw new Error("stop failed"); return closeOne(record, preserve); };
    const closed = await t.manager.close(t.a) as { subtreeFailures?: string[] };
    assert.deepEqual(closed.subtreeFailures, [`${t.b}: Error: stop failed`]);
  } finally { delete manager.abortOne; delete manager.closeOne; await t.cleanup(); }
});

test("a delegated reply always fits one pipe frame", () => {
  const small = { agents: [{ id: "a" }] };
  assert.equal(fitDelegatedReply(small), small);
  const big = { agents: Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, task: "\"quoted\"\n".repeat(4000) })) };
  const fitted = fitDelegatedReply(big) as { truncated: boolean; preview: string };
  assert.equal(fitted.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify({ id: 1, success: true, data: fitted })) < 64 * 1024);
});

test("a subtree abort awaits a descendant's abort already in flight and reports its failure", async () => {
  const t = await settledTree();
  const manager = t.manager as any;
  try {
    let fail!: (error: Error) => void;
    manager.abortRuns.set(t.c, new Promise((_resolve, reject) => { fail = reject; }));
    const aborting = t.manager.abort(t.a);
    setTimeout(() => fail(new Error("abort timed out")), 20);
    const aborted = await aborting as { subtreeFailures?: string[] };
    assert.deepEqual(aborted.subtreeFailures, [`${t.c}: Error: abort timed out`]);
  } finally { manager.abortRuns.clear(); await t.cleanup(); }
});

test("the footer summary counts and costs every level of the tree", async () => {
  const dir = tempRoot("subagent-nesting-cost-");
  const manager = new SubagentManager(dir, () => {}, () => {}, parseChildLimit(4));
  const spawn = async (name: string, cost: string, parentId?: string) => (await manager.spawn({
    name, task: name, cwd: dir, executable: process.execPath, executableArgs: [fixture], parentId, env: { TEST_COST: cost },
  })).id;
  try {
    const a = await spawn("A", "1", undefined), b = await spawn("B", "2", a), c = await spawn("C", "4", b);
    await manager.refreshUsageSnapshots();
    assert.match(formatSubagentSummary(manager.list(), manager.capacity().limit), /^subagents: \d(\(\+\d\))?\/4 of 3 • \$7\.000$/, "a grandchild is tracked and costed");
    await manager.close(b);
    assert.equal(manager.get(c).status, "stopped");
    assert.match(formatSubagentSummary(manager.list(), manager.capacity().limit), /^subagents: \d(\(\+\d\))?\/4 of 3 • \$7\.000$/, "closed descendants stay tracked and keep their cost");
  } finally { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); }
});
