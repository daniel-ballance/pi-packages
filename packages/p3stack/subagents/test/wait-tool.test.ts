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
  wait: Tool;
  read: Tool;
  worker: string;
  spawn: (task: string) => Promise<string>;
  delegatedWait: (args: Record<string, unknown>) => Promise<unknown>;
  queue: (pending: boolean) => void;
}) => Promise<void>, extraRecords: Record<string, unknown>[] = []) {
  const root = tempRoot("wait-tool-"), agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "subagents", "s"), { recursive: true });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "test/fake:medium" }], tools: [], maxDepth: 2 }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`, { mode: 0o700 });
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, task: id, status: "idle", config: { cwd: root }, createdAt: "now", updatedAt: "now",
    sessionFile: join(root, `${id}.jsonl`), logFile: join(root, `${id}.log`), stderrFile: join(root, `${id}.err`),
    updates: [], cursor: 0, readCursor: 0, uiRequests: [], hadEnvOverrides: false, ...extra,
  });
  writeFileSync(join(agentDir, "subagents", "s", "registry.json"), JSON.stringify({ version: 1, agents: [
    record("coordinator"),
    ...extraRecords.map(extra => record(extra.id as string, extra)),
  ] }));
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>();
  let pending = false;
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
        registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, sendMessage() {},
        getAllTools: () => [], getCommands: () => [], events: { on: () => () => {} },
      } as unknown as ExtensionAPI);
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    });
    const worker = await manager!.spawn({ name: "worker", task: "until-abort", cwd: root, selection: { model: "test/fake:medium", tools: [] }, parentId: "coordinator" });
    assert.equal(manager!.get(worker.id).status, "working");
    await run({
      wait: args => tools.get("subagent_wait").execute("c", args, undefined, undefined, ctx),
      read: args => tools.get("subagent_read").execute("c", args, undefined, undefined, ctx),
      worker: worker.id,
      spawn: async task => (await manager!.spawn({ name: task, task, cwd: root, selection: { model: "test/fake:medium", tools: [] } })).id,
      delegatedWait: args => manage!("coordinator", { op: "wait", args }, new AbortController().signal),
      queue: value => { pending = value; },
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
    assert.equal(page.resultReview?.status, "unreviewed", "the spilled wait reviewed nothing");
  }, [crashed, { id: "noisy", status: "failed", error: "e".repeat(31_000) }]);
});
