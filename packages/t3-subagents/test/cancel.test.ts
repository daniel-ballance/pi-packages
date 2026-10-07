import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import t3Subagents from "../extensions/t3-subagents/index.js";

test("cancellation intents recover task/reason and prevent changed-key retries before dispatch", async () => {
  const entries: any[] = [];
  const request = { taskId: "task-1", reason: "User requested stop.", clientRequestId: "cancel-round-1" };
  const load = (fail = false) => {
    const tools = new Map<string, ToolDefinition>(), calls: any[] = [];
    t3Subagents({
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    } as unknown as ExtensionAPI);
    const ctx = {
      tools: [{ name: "mcp__t3-code__task_cancel" }], sessionManager: { getBranch: () => entries },
      async executeTool(name: string, args: unknown) {
        calls.push({ name, args });
        if (fail) throw new Error("Lost cancellation reply");
        return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ taskId: "task-1", status: "cancel_requested" }) }] } };
      },
    } as unknown as ExtensionToolContext;
    return { calls, run(name: string, args: any = {}) { return tools.get("t3_subagent_" + name)!.execute("call", args, undefined, undefined, ctx); } };
  };
  await assert.rejects(load(true).run("cancel", request), /Cancellation outcome uncertain.*cancel-round-1/);
  const reloaded = load();
  const pending = ((await reloaded.run("list")).details as any).requests[0];
  assert.deepEqual(pending, { operation: "cancel", state: "uncertain", ...request });
  await assert.rejects(reloaded.run("cancel", { ...request, taskId: "another-task" }), /different cancellation/);
  await assert.rejects(reloaded.run("cancel", { ...request, reason: "Another reason" }), /different cancellation/);
  assert.equal(reloaded.calls.length, 0);
  assert.equal(((await reloaded.run("cancel", request)).details as any).status, "cancel_requested");
  assert.deepEqual(reloaded.calls[0].args, request);
  const accepted = load();
  assert.equal(((await accepted.run("cancel", request)).details as any).status, "cancel_requested");
  assert.equal(accepted.calls.length, 0); // Receipt replay isn't another stop or a fresh status read.
});

test("a deployed terminal-task receipt preserves completed status and later work without journaling summaries", async () => {
  const entries: any[] = [], tools = new Map<string, ToolDefinition>();
  let calls = 0;
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    tools: [{ name: "mcp__t3-code__task_cancel" }], sessionManager: { getBranch: () => entries },
    async executeTool() {
      calls++;
      return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({
        taskId: "task-terminal", status: "completed", workState: "result_available",
        hasPendingChildRuns: true, summary: "private original published result",
      }) }] } };
    },
  } as unknown as ExtensionToolContext;
  const request = { taskId: "task-terminal", clientRequestId: "terminal-stop" };
  t3Subagents(pi);
  const first = await tools.get("t3_subagent_cancel")!.execute("call", request, undefined, undefined, ctx);
  assert.equal((first.details as any).status, "completed");
  assert.equal((first.details as any).hasPendingChildRuns, true);
  assert.ok(!JSON.stringify(entries).includes("private original published result"));
  t3Subagents(pi); // Reload reconstructs the completed receipt, not another stop.
  const replay = await tools.get("t3_subagent_cancel")!.execute("call", request, undefined, undefined, ctx);
  assert.equal((replay.details as any).status, "completed");
  assert.equal((replay.details as any).source, "local-session-branch");
  assert.equal(calls, 1);
});
