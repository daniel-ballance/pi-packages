import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import type { ManagementRequest } from "../extensions/subagents/src/peer-transport.js";
import { asHost } from "./host-env.js";
import { tempRoot } from "./support/temp-root.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

type Manage = (callerId: string, request: ManagementRequest, signal: AbortSignal) => Promise<unknown>;

type Tool = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; details: unknown }>;

async function withWaitTool(run: (tools: {
  manager: SubagentManager;
  confirmStop: (id: string, yes: boolean) => Promise<void>;
  wait: Tool;
  read: Tool;
  worker: string;
  spawn: (task: string, parentId?: string) => Promise<string>;
  delegated: (op: ManagementRequest["op"], args: Record<string, unknown>) => Promise<unknown>;
  delegatedRead: (args: Record<string, unknown>) => Promise<unknown>;
  send: (id: string, task: string) => Promise<unknown>;
  delegatedWait: (args: Record<string, unknown>) => Promise<unknown>;
  queue: (pending: boolean) => void;
  delivered: () => void;
}) => Promise<void>, extraRecords: Record<string, unknown>[] = []) {
  const root = tempRoot("wait-tool-"), agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "subagents", "s"), { recursive: true });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "test/fake:medium" }], tools: ["subagent_wait", "subagent_catalog", "subagent_list"], maxDepth: 2 }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`, { mode: 0o700 });
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, task: id, status: "idle", config: { cwd: root }, createdAt: "now", updatedAt: "now",
    sessionFile: join(root, `${id}.jsonl`), logFile: join(root, `${id}.log`), stderrFile: join(root, `${id}.err`),
    updates: [], cursor: 0, readCursor: 0, uiRequests: [], hadEnvOverrides: false, ...extra,
  });
  writeFileSync(join(agentDir, "subagents", "s", "registry.json"), JSON.stringify({ version: 1, agents: [
    record("coordinator", { config: { cwd: root, selection: { model: "test/fake:medium", tools: ["subagent_wait", "subagent_read", "subagent_catalog"] } } }),
    ...extraRecords.map(extra => record(extra.id as string, extra)),
  ] }));
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>();
  let subagentsCommand!: Function, pending = false;
  const ctx = {
    cwd: root, mode: "rpc", hasUI: false, isIdle: () => false, isProjectTrusted: () => false, hasPendingMessages: () => pending,
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "fake", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {}, reasoning: true }] },
    ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => join(root, "s.jsonl") },
  };
  let manager: SubagentManager | undefined, manage: Manage | undefined;
  const install = SubagentManager.prototype.setManagementHandler;
  SubagentManager.prototype.setManagementHandler = function (this: SubagentManager, handler?: Manage) {
    manager = this; manage = handler;
    install.call(this, handler);
  };
  try {
    asHost("cli", () => {
      subagents({
        registerFlag() {}, getFlag() { return false; },
        on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
        registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, def: any) { if (name === "subagents") subagentsCommand = def.handler; }, sendMessage() {},
        getAllTools: () => [], getCommands: () => [], events: { on: () => () => {} },
      } as unknown as ExtensionAPI);
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    });
    const worker = await manager!.spawn({ name: "worker", task: "until-abort", cwd: root, selection: { model: "test/fake:medium", tools: [] }, parentId: "coordinator" });
    assert.equal(manager!.get(worker.id).status, "working");
    await run({
      manager: manager!,
      confirmStop: (id, yes) => subagentsCommand(`confirm-stopped ${id}`, {...ctx, ui: {...ctx.ui, confirm: async () => yes}}),
      wait: args => tools.get("subagent_wait").execute("c", args, undefined, undefined, ctx),
      read: args => tools.get("subagent_read").execute("c", args, undefined, undefined, ctx),
      worker: worker.id,
      spawn: async (task, parentId) => (await manager!.spawn({ name: task.slice(0, 100), task, cwd: root, parentId, selection: { model: "test/fake:medium", tools: [] } })).id,
      delegated: (op, args) => manage!("coordinator", { op, args }, new AbortController().signal),
      delegatedRead: args => manage!("coordinator", { op: "read", args }, new AbortController().signal),
      send: (id, task) => manager!.send(id, task),
      delegatedWait: args => manage!("coordinator", { op: "wait", args }, new AbortController().signal),
      queue: value => { pending = value; },
      delivered: () => { pending = false; for (const handler of handlers.get("message_start") ?? []) handler({ message: { role: "user" } }, ctx); },
    });
  } finally {
    SubagentManager.prototype.setManagementHandler = install;
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    process.env.PATH = previous.path;
    rmSync(root, { recursive: true, force: true });
  }
}

const wake = (data: unknown) => (data as { wake?: unknown }).wake;

test("the root dispatches only proxies granted to the caller", async () => {
  await withWaitTool(async ({ delegated }) => {
    await assert.rejects(delegated("list", {}), /subagent_list.*not granted/i);
    const catalog = await delegated("catalog", {}) as { features: unknown; tools: string[] };
    assert.deepEqual(catalog.features, { workflows: false, loops: false, peers: false });
    assert.equal(catalog.tools.includes("subagent_wait"), false, "the coordinator can only compose leaves");
  });
});

test("a queued message ends the root's wait once per batch, and never a coordinator's delegated wait", async () => {
  await withWaitTool(async ({ wait, delegatedWait, queue, worker }) => {
    queue(true);
    assert.equal(wake(await delegatedWait({ timeoutSeconds: 1 })), "timeout", "the root operator's message is not for the coordinator");
    assert.equal(wake((await wait({ ids: [worker] })).details), "message");
    assert.equal(wake((await wait({ ids: [worker], timeoutSeconds: 1 })).details), "timeout", "the same queued batch does not end the next wait");
    queue(false);
    assert.equal(wake((await wait({ ids: [worker], timeoutSeconds: 0 })).details), "timeout");
    queue(true);
    assert.equal(wake((await wait({ ids: [worker] })).details), "message", "a new batch after the queue drained");
  });
});

test("delivery between root waits re-arms the message latch without an empty poll", async () => {
  await withWaitTool(async ({ wait, queue, delivered, worker }) => {
    const check = async () => wake((await wait({ ids: [worker], timeoutSeconds: 0 })).details);
    queue(true);
    assert.equal(await check(), "message");
    delivered();
    queue(true);
    assert.equal(await check(), "message");
    assert.equal(await check(), "timeout");
  });
});

test("a default wait returns when a selected child has already settled, so the next wait passes only the ids still working", async () => {
  await withWaitTool(async ({ wait, worker }) => {
    assert.equal(wake((await wait({ ids: ["chatty", worker], timeoutSeconds: 0 })).details), "settled");
    assert.equal(wake((await wait({ ids: ["chatty", worker], timeoutSeconds: 0 })).details), "settled", "the settled id still counts");
    assert.equal(wake((await wait({ ids: [worker], timeoutSeconds: 0 })).details), "timeout", "pass only the id still working");
  }, [chatty]);
});

test("a coordinator's omitted-mode wait returns when one child has already settled", async () => {
  await withWaitTool(async ({ delegatedWait, worker }) => {
    assert.equal(wake(await delegatedWait({ ids: ["settled-child", worker], timeoutSeconds: 0 })), "settled");
    assert.equal(wake(await delegatedWait({ ids: [worker], timeoutSeconds: 0 })), "timeout", "pass only the id still working");
  }, [{ id: "settled-child", parentId: "coordinator", status: "idle" }]);
});

for (const mode of [undefined, "any"] as const) {
  test(`${mode === undefined ? "a default" : "an explicit any"} wait returns when one live child settles and the sibling is still working`, async () => {
    await withWaitTool(async ({ wait, spawn }) => {
      const busy = await spawn("until-abort");
      const first = await spawn("split-settle");
      const result = await wait({ ids: [first, busy], mode, timeoutSeconds: 2 });
      assert.equal(wake(result.details), "settled", JSON.stringify(result.details));
      assert.equal(wake((await wait({ ids: [first, busy], mode, timeoutSeconds: 0 })).details), "settled", "the settled id still counts");
      assert.equal(wake((await wait({ ids: [busy], mode, timeoutSeconds: 0 })).details), "timeout", "pass only the id still working");
    });
  });
}

test("explicit all keeps waiting while a selected child is still working", async () => {
  await withWaitTool(async ({ wait, worker }) => {
    assert.equal(wake((await wait({ ids: ["chatty", worker], mode: "all", timeoutSeconds: 0 })).details), "timeout");
  }, [chatty]);
});

test("a queued message ends a wait while every selected child is still working", async () => {
  await withWaitTool(async ({ wait, queue, spawn, worker }) => {
    const other = await spawn("until-abort");
    const waiting = wait({ ids: [worker, other], timeoutSeconds: 1 });
    queue(true);
    assert.equal(wake((await waiting).details), "message");
  });
});

test("a preview is not a review; delegation-only reads can replay each complete assignment", async () => {
  await withWaitTool(async ({ wait, read, spawn, send, delegatedRead }) => {
    const task = "a".repeat(3997) + "🚲" + "é".repeat(10000) + " END-VERDICT";
    const id = await spawn(task, "coordinator");
    const report = (await wait({ ids: [id], final: true })).details as any;
    const preview = report.agents[0].reports[0];
    assert.equal(preview.text.length, 12000);
    assert.equal(preview.truncated, true);
    assert.equal(preview.fullLength, task.length + 2);
    assert.equal(report.agents[0].resultReview.status, "unreviewed");
    const readPage = (await read({ id, since: 0 })).details as any;
    assert.ok(readPage.truncated || readPage.updates.some((u: any) => u.truncated));
    assert.equal(((await read({ id })).details as any).resultReview.status, "unreviewed");
    await send(id, "next");
    await wait({ ids: [id], collect: false });
    let full = "", args = preview.readFull;
    assert.equal(args.id, id);
    do {
      const page = await delegatedRead(args) as any;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 30_000);
      assert.equal(page.fullLength, preview.fullLength);
      full += page.text; args = page.nextRead;
    } while (args);
    assert.equal(full, "1:" + task);
    assert.equal(((await read({ id, since: 9999 })).details as any).resultReview.status, "unreviewed", "cannot review a later assignment with an old receipt");
  });
});

test("only the human's confirmation clears a detached live-PID slot", async () => {
  await withWaitTool(async ({ manager, confirmStop, worker }) => {
    const live = manager.capacity().live;
    assert.equal((await manager.close("detached")).outcome, "unconfirmed");
    await confirmStop("detached", false);
    assert.equal(manager.capacity().live, live);
    await assert.rejects(confirmStop(worker, true), /detached/);
    await confirmStop("detached", true);
    assert.equal(manager.capacity().live, live - 1);
    assert.equal(manager.get("detached").status, "stopped");
    assert.ok(manager.get("detached").hold, "manual stop confirmation never releases a hold");
  }, [{ id: "detached", pid: process.pid, unconfirmedStop: "pending", hold: {kind: "kill", at: "now", outcome: "failed"} }]);
});

test("a fully paged result is no longer advertised as a pending full read", async () => {
  await withWaitTool(async ({read, manager, spawn}) => {
    const id = await spawn("文".repeat(13000)); await manager.wait([id], "all", 2000);
    let args = manager.get(id).updates.at(-1)!.readFull as any;
    assert.ok(args);
    do { const page = (await read(args)).details as any; args = page.nextRead; } while (args);
    const after = (await read({id})).details as any;
    assert.equal(after.resultReview.status, "reviewed"); assert.equal(after.readFull, undefined);
  });
});

test("overflow keeps supervision and every omitted report handle without skipping any result", async () => {
  await withWaitTool(async ({ read, manager, worker: id }) => {
    await read({ id });
    const r = manager.get(id), before = r.readCursor;
    r.uiRequests = [{ id: "d", method: "confirm", title: "OK?" }];
    r.hold = { kind: "halt", outcome: "failed", at: "now" }; r.error = "stop failed";
    const reports = ["甲","乙","丙"].map(c => (manager as any).update(r, "assistant", c.repeat(12000)));
    const out = (await read({id})).details as any;
    assert.equal(out.status, r.status); assert.deepEqual(out.uiRequests, r.uiRequests);
    assert.deepEqual(out.hold, r.hold); assert.equal(out.error, r.error);
    assert.equal(out.nextCursor, before);
    assert.deepEqual(out.omittedReports.map((u: any) => u.cursor), reports.map(u => u.cursor));
    // Page out of order: consuming C must not skip A or B.
    for (const i of [2, 0, 1]) {
      let args = out.omittedReports[i].readFull, text = "";
      do { assert.equal(typeof args.page, "string"); const page = (await read(args)).details as any; text += page.text; args = page.nextRead; } while (args);
      assert.equal(text, reports[i].text);
      if (i === 2) assert.equal(r.readCursor, before);
    }
    assert.deepEqual(((await read({id})).details as any).updates, []);
    assert.equal(manager.summary(id).unread, 0);
    const replay = (await read({id, since: reports[1].cursor - 1})).details as any;
    assert.ok(replay.omittedReports.some((u: any) => u.cursor === reports[1].cursor));
  });
});

test("an oversized pending dialog keeps its id and complete details even after the update cursor passed it", async () => {
  await withWaitTool(async ({read, manager, worker: id}) => {
    const r = manager.get(id), options = ["文".repeat(14000), "second"];
    (manager as any).event(r, {type: "extension_ui_request", id: "select", method: "select", title: "Choose", options}, {});
    const replay = (await read({id, since:r.cursor})).details as any;
    const [dialog] = replay.uiRequests;
    assert.equal(dialog.id, "select");
    let text = "", args = dialog.readFull;
    assert.ok(args);
    do { const p = (await read(args)).details as any; text += p.text; args = p.nextRead; } while (args);
    assert.deepEqual(JSON.parse(text).options, options);
  });
});

test("delegated dialog pages cannot acknowledge a root-only input request", async () => {
  await withWaitTool(async ({ read, manager, delegatedRead, worker: id }) => {
    const r = manager.get(id);
    (manager as any).event(r, {type: "extension_ui_request", id: "dialog", method: "editor", prefill: "a".repeat(13000)}, {});
    let args = r.updates.at(-1)!.readFull as any;
    assert.ok(args);
    do { const page = await delegatedRead(args) as any; args = page.nextRead; } while (args);
    assert.ok(manager.pendingNotices().some(n => n.requestId === "dialog"));
    await read({id});
    assert.ok(!manager.pendingNotices().some(n => n.requestId === "dialog"));
  });
});

test("since just before a final result always replays updates; only page selects report text", async () => {
  await withWaitTool(async ({read, manager, spawn}) => {
    const id = await spawn("short"); await manager.wait([id], "all", 2000);
    const cursor = manager.get(id).assignment!.resultCursor!;
    const replay = (await read({ id, since: cursor - 1 })).details as any;
    assert.ok(replay.updates.some((u: any) => u.cursor === cursor));
    assert.equal(manager.get(id).readCursor, 0);
    await assert.rejects(read({id, page: "invalid"}), /page/i);
  });
});

const exited = { cursor: 1, kind: "lifecycle", text: "Assignment running when process exited.", time: "now" };
const crashed = { id: "crashed", status: "failed", error: "exited", updates: [exited], cursor: 1,
  assignment: { id: "a1", status: "running", startedAt: "now" } };

test("a wait that fits reports the result it collected as reviewed", async () => {
  await withWaitTool(async ({ wait }) => {
    const report = (await wait({ ids: ["crashed"] })).details as { agents: { resultReview?: { status: string } }[] };
    assert.equal(report.agents[0].resultReview?.status, "reviewed");
  }, [crashed]);
});

const chatty = {
  id: "chatty", status: "idle",
  updates: [
    { cursor: 1, kind: "sent", text: "task", time: "now" },
    { cursor: 2, kind: "assistant", text: "1", time: "now" },
    { cursor: 3, kind: "assistant", text: "2", time: "now" },
    { cursor: 4, kind: "assistant", text: "done", time: "now" },
  ],
  cursor: 4,
  assignment: { id: "chatty-1", status: "completed", startedAt: "now", finishedAt: "now", resultCursor: 4 },
  resultReview: { assignmentId: "chatty-1", status: "unreviewed" },
};

test("final true returns the last assistant report and subagent_read returns nothing new", async () => {
  await withWaitTool(async ({ wait, read }) => {
    const details = (await wait({ ids: ["chatty"], final: true })).details as {
      wake: string; agents: { reports?: { kind: string; text: string }[]; unread: number; resultReview?: { status: string } }[];
    };
    assert.equal(details.wake, "settled");
    assert.deepEqual(details.agents[0].reports, [{ kind: "assistant", text: "done" }]);
    assert.equal(details.agents[0].unread, 0);
    assert.equal(details.agents[0].resultReview?.status, "reviewed");
    const page = (await read({ id: "chatty" })).details as { updates: unknown[] };
    assert.deepEqual(page.updates, []);
  }, [chatty]);
});

test("a wait that spills to a file claims no review, and subagent_read still returns the unread result", async () => {
  await withWaitTool(async ({ wait, read }) => {
    const output = await wait({ ids: ["crashed", "noisy"] });
    assert.match(output.content[0].text, /\[Truncated\. Full result: /, "the wait spilled past the 30 KB cap");
    assert.doesNotMatch(output.content[0].text, /"status": "reviewed"/);
    const page = (await read({ id: "crashed" })).details as { updates: { cursor: number }[]; resultReview?: { status: string } };
    assert.deepEqual(page.updates.map(update => update.cursor), [1], "the read still returns the unacknowledged result");
    assert.equal(page.resultReview?.status, "reviewed", "this successful read acknowledged the result");
  }, [crashed, { id: "noisy", status: "failed", error: "e".repeat(31_000) }]);
});
