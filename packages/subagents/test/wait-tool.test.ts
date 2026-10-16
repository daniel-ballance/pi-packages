import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import type { ManagementRequest } from "../extensions/subagents/src/peer-transport.js";
import { asHost } from "./host-env.js";

type Manage = (callerId: string, request: ManagementRequest, signal: AbortSignal) => Promise<unknown>;

/** The extension as Pi loads it, with a coordinator and its working child restored from the registry. */
async function withWaitTool(run: (tools: {
  wait: (args: Record<string, unknown>) => Promise<{ details: unknown }>;
  delegatedWait: (args: Record<string, unknown>) => Promise<unknown>;
  queue: (pending: boolean) => void;
}) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wait-tool-"))), agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "subagents", "s"), { recursive: true });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "p/m:off" }], tools: [] }));
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, task: id, status: "idle", config: { cwd: root }, createdAt: "now", updatedAt: "now",
    sessionFile: join(root, `${id}.jsonl`), logFile: join(root, `${id}.log`), stderrFile: join(root, `${id}.err`),
    updates: [], cursor: 0, readCursor: 0, uiRequests: [], hadEnvOverrides: false, ...extra,
  });
  writeFileSync(join(agentDir, "subagents", "s", "registry.json"), JSON.stringify({ version: 1, agents: [
    record("coordinator"), record("worker", { parentId: "coordinator", depth: 2 }),
  ] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>();
  let pending = false;
  const ctx = {
    cwd: root, mode: "rpc", hasUI: false, isIdle: () => false, isProjectTrusted: () => false, hasPendingMessages: () => pending,
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {}, reasoning: false }] },
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
        getAllTools: () => [], events: { on: () => () => {} },
      } as unknown as ExtensionAPI);
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    });
    // A restored record has no process; mark it working so only a deadline or a message can end a wait.
    manager!.get("worker").status = "working";
    await run({
      wait: args => tools.get("subagent_wait").execute("c", args, undefined, undefined, ctx),
      delegatedWait: args => manage!("coordinator", { op: "wait", args }, new AbortController().signal),
      queue: value => { pending = value; },
    });
  } finally {
    SubagentManager.prototype.setManagementHandler = install;
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const wake = (data: unknown) => (data as { wake?: unknown }).wake;

test("a queued message ends the root's wait once per batch, and never a coordinator's delegated wait", async () => {
  await withWaitTool(async ({ wait, delegatedWait, queue }) => {
    queue(true);
    assert.equal(wake(await delegatedWait({ timeoutSeconds: 1 })), "timeout", "the root operator's message is not for the coordinator");
    assert.equal(wake((await wait({ ids: ["worker"] })).details), "message");
    assert.equal(wake((await wait({ ids: ["worker"], timeoutSeconds: 1 })).details), "timeout", "the same queued batch does not end the next wait");
    queue(false);
    assert.equal(wake((await wait({ ids: ["worker"], timeoutSeconds: 0 })).details), "timeout");
    queue(true);
    assert.equal(wake((await wait({ ids: ["worker"] })).details), "message", "a new batch after the queue drained");
  });
});
