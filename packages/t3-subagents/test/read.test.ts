import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import t3Subagents from "../extensions/t3-subagents/index.js";

test("catalog/read/cancel use T3 hooks, keep workState separate and never create parent wakes", async () => {
  const tools = new Map<string, ToolDefinition>(), entries: any[] = [], calls: any[] = [];
  t3Subagents({
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    // No sendMessage/on/event bus: registration must not start another owner.
  } as unknown as ExtensionAPI);
  const replies = [
    { parentThreadId: "parent", providers: [{ providerInstanceId: "pi", models: [{ id: "custom-model" }] }], features: { appOwnedSubagents: true } },
    { taskId: "task-existing", childThreadId: "backing-storage-only", status: "completed",
      workState: "waiting_for_children", hasPendingChildRuns: true, summary: null, waitTimedOut: false },
    { taskId: "task-existing", status: "cancel_requested" },
    { taskId: "task-existing", status: "cancelled", workState: "result_available",
      hasPendingChildRuns: false, summary: "Original task result.", latestTerminalSummary: "Later backing-thread result.", waitTimedOut: false },
  ];
  const ctx = {
    tools: ["orchestrator_capabilities", "task_status", "task_cancel"].map(name => ({ name: "mcp__t3_code__" + name })),
    sessionManager: { getBranch: () => entries },
    async executeTool(name: string, args: unknown, options: unknown) {
      calls.push({ name, args, options });
      return { isError: false, result: { content: [{ type: "text", text: JSON.stringify(replies.shift()) }] } };
    },
  } as unknown as ExtensionToolContext;
  const run = async (name: string, args = {}) => tools.get("t3_subagent_" + name)!.execute("call", args, undefined, undefined, ctx);
  const catalog = await run("catalog");
  assert.equal((catalog.details as any).providers[0].models[0].id, "custom-model");
  const read = await run("read", { taskId: "task-existing" });
  assert.equal((read.details as any).workState, "waiting_for_children");
  assert.equal((read.details as any).hasPendingChildRuns, true);
  await run("cancel", { taskId: "task-existing", reason: "Stop this task.", clientRequestId: "cancel-1" });
  assert.deepEqual(calls[2], { name: "mcp__t3_code__task_cancel",
    args: { taskId: "task-existing", reason: "Stop this task.", clientRequestId: "cancel-1" }, options: { signal: undefined } });
  const final = await run("read", { taskId: "task-existing" });
  assert.equal((final.details as any).summary, "Original task result.");
  assert.equal((final.details as any).latestTerminalSummary, "Later backing-thread result.");
  assert.equal(calls.length, 4); // No polls, thread sends or extra completion reads.
});
