import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import t3Subagents from "../extensions/t3-subagents/index.js";

const names = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"];
const accepted = { taskId: "task-1", childThreadId: "child-1", childRunId: "run-1",
  status: "running", workState: "working", hasPendingChildRuns: false, summary: null };
const request = { task: "Review the public interface. Do not edit.", clientRequestId: "review-round-1",
  target: { providerInstanceId: "pi-local", model: "test/stub" }, title: "Review" };

function harness(prefix = "mcp__t3-code__", entries: any[] = []) {
  const tools = new Map<string, ToolDefinition>();
  const calls: { name: string; args: any; options: any }[] = [];
  let reply: (name: string, args: any) => any = () => accepted;
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
  } as unknown as ExtensionAPI;
  t3Subagents(pi);
  const ctx = {
    tools: names.map(name => ({ name: prefix + name })),
    sessionManager: { getBranch: () => entries },
    async executeTool(name: string, args: any, options: any) {
      calls.push({ name, args, options });
      return { isError: false, result: { content: [{ type: "text", text: JSON.stringify(await reply(name, args)) }] } };
    },
  } as unknown as ExtensionToolContext;
  const run = (name: string, args: any = {}, signal?: AbortSignal) => tools.get("t3_subagent_" + name)!.execute("call", args, signal, undefined, ctx);
  return { pi, ctx, tools, calls, entries, run, respond(fn: typeof reply) { reply = fn; } };
}

test("delegation is async, records T3 identity and survives extension reload without redispatch", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const result = await h.run("delegate", request, signal);
  assert.equal((result.details as any).taskId, "task-1");
  assert.deepEqual(h.calls, [{ name: "mcp__t3-code__delegate_task",
    args: { ...request, mode: "async" }, options: { signal } }]);
  const reloaded = harness("mcp__t3-code__", h.entries);
  const replay = await reloaded.run("delegate", { ...request, target: { model: "test/stub", providerInstanceId: "pi-local" } });
  assert.equal((replay.details as any).taskId, "task-1");
  assert.equal(reloaded.calls.length, 0);
  const list = await reloaded.run("list");
  assert.equal((list.details as any).requests[0].taskId, "task-1");
});

test("T3 bridge text plus structuredContent JSON copies decode as one result", async () => {
  const h = harness();
  h.ctx.executeTool = async () => ({ isError: false, result: { content: [{ type: "text",
    text: JSON.stringify(accepted, null, 2) + "\n" + JSON.stringify(accepted) }] } }) as any;
  const result = await h.run("delegate", request);
  assert.equal((result.details as any).taskId, "task-1");
});

test("uncertain transport/abort outcomes retain identity, and changed briefs cannot reuse a key", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  h.respond(() => { throw new Error("Transport aborted after server admission"); });
  await assert.rejects(h.run("delegate", request, controller.signal), /outcome uncertain.*review-round-1/);
  const reloaded = harness("mcp__t3_code__", h.entries);
  const list = await reloaded.run("list");
  assert.equal((list.details as any).requests[0].state, "uncertain");
  await assert.rejects(reloaded.run("delegate", { ...request, task: "A different review round" }), /different task/);
  assert.equal(reloaded.calls.length, 0);
  await reloaded.run("delegate", request);
  assert.equal(reloaded.calls[0].args.clientRequestId, "review-round-1");
  assert.equal(h.calls.length, 1); // No automatic cancel or retry on abort.
});

test("missing/ambiguous T3 tools and active native delegation fail before admission", async () => {
  const missing = harness("wrong-server__");
  await assert.rejects(missing.run("delegate", request), /registered T3/);
  assert.equal(missing.entries.length, 0);
  const obsolete = harness();
  (obsolete.ctx as any).executeTool = undefined;
  await assert.rejects(obsolete.run("delegate", request), /executeTool/);
  assert.equal(obsolete.entries.length, 0);
  const native = harness();
  (native.ctx.tools as any[]).push({ name: "subagent_spawn" });
  await assert.rejects(native.run("delegate", request), /disable-native-subagents/);
  assert.equal(native.calls.length, 0);
  const ambiguous = harness();
  (ambiguous.ctx.tools as any[]).push({ name: "mcp__t3_code__delegate_task" });
  await assert.rejects(ambiguous.run("delegate", request), /found 2/);
  assert.equal(ambiguous.entries.length, 0);
});

test("malformed/conflicting identities stay uncertain and cannot corrupt another task", async () => {
  const h = harness();
  h.respond(() => ({ status: "running" }));
  await assert.rejects(h.run("delegate", request), /no taskId/);
  h.ctx.executeTool = async () => ({ isError: false, result: { content: [{ type: "text",
    text: JSON.stringify(accepted) + "\n" + JSON.stringify({ ...accepted, taskId: "different-task" }) }] } }) as any;
  await assert.rejects(h.run("delegate", request), /no JSON object/);
  const reloaded = harness("mcp__t3-code__", h.entries);
  assert.equal(((await reloaded.run("list")).details as any).requests[0].state, "uncertain");
  reloaded.respond(() => ({ ...accepted, taskId: "different-task" }));
  await assert.rejects(reloaded.run("read", { taskId: "task-1" }), /different taskId/);
});

test("large summaries spill to a private file instead of unbounded text or details", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-subagents-result-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const h = harness();
    (h.ctx.sessionManager as any).getSessionId = () => "test-session";
    const data = { ...accepted, status: "completed", workState: "result_available", summary: "private result\n".repeat(5000) };
    h.respond(() => data);
    const result = await h.run("read", { taskId: "task-1" });
    const details = result.details as any;
    assert.equal(details.truncated, true);
    assert.equal(details.taskId, "task-1");
    assert.ok(Buffer.byteLength(JSON.stringify(details)) < 2000);
    assert.ok(Buffer.byteLength(result.content.map((c: any) => c.text ?? "").join("")) <= 30000);
    assert.deepEqual(JSON.parse(readFileSync(details.fullResult, "utf8")), data);
    if (process.platform !== "win32") assert.equal(statSync(details.fullResult).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a simulated deadline remains uncertain and recovers only with the original key", async () => {
  const h = harness();
  h.respond(() => { const error = new Error("Request deadline after admission"); error.name = "TimeoutError"; throw error; });
  await assert.rejects(h.run("delegate", request), /outcome uncertain.*TimeoutError/);
  assert.equal(h.calls.length, 1); // No implicit retry or cancellation.
  const resumed = harness("mcp__t3-code__", h.entries);
  assert.equal(((await resumed.run("list")).details as any).requests[0].state, "uncertain");
  await resumed.run("delegate", request);
  assert.equal(resumed.calls[0].args.clientRequestId, request.clientRequestId);
});

test("accepted local replay survives simulated server-cache expiry, but lost history cannot promise exactly once", async () => {
  const original = harness();
  await original.run("delegate", request);
  const resumed = harness("mcp__t3-code__", original.entries);
  resumed.respond(() => { throw new Error("Expired server cache must not be queried for accepted local replay"); });
  assert.equal(((await resumed.run("delegate", request)).details as any).taskId, accepted.taskId);
  assert.equal(resumed.calls.length, 0);

  // This is a controlled server reset simulation, not a claim that this deployed
  // T3 version necessarily forgets durable command identities when a cache expires.
  const lostHistory = harness();
  lostHistory.respond(() => ({ ...accepted, taskId: "new-task-after-server-reset" }));
  const reply = await lostHistory.run("delegate", request);
  assert.equal(lostHistory.calls.length, 1);
  assert.equal((reply.details as any).taskId, "new-task-after-server-reset");
});
