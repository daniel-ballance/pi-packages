import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import selfReload from "../extensions/self-reload/index.js";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolContext = Parameters<Tool["execute"]>[4];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function runtime(sessionId = "session-1", activeTools = ["self_reload"]) {
  const hooks = new Map<string, Function>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const messages: unknown[][] = [];
  const userMessages: unknown[][] = [];
  const statuses: unknown[][] = [];
  const notices: unknown[][] = [];
  let stale = false;
  const check = () => assert.equal(stale, false, "old runtime API used after reload");
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, fn),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    getActiveTools: () => { check(); return activeTools; },
    sendMessage: (...args: unknown[]) => { check(); messages.push(args); },
    sendUserMessage: (...args: unknown[]) => { check(); userMessages.push(args); },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "rpc", tools: [], executeTool: async () => { throw new Error("No nested tools in this fixture"); }, sessionManager: { getSessionId: () => sessionId }, ui: {
    setStatus: (...args: unknown[]) => { check(); statuses.push(args); },
    notify: (...args: unknown[]) => { check(); notices.push(args); },
  } } as unknown as ToolContext;
  selfReload(pi);
  hooks.get("session_start")!({ reason: "startup" }, ctx);
  return {
    hooks, tools, commands, ctx, messages, userMessages, statuses, notices,
    close() { if (!stale) hooks.get("session_shutdown")!({ reason: "reload" }, ctx); stale = true; },
  };
}

async function invoke(r: ReturnType<typeof runtime>, continuation = "Check the updated tool.", mode = "rpc") {
  return r.tools.get("self_reload")!.execute("call-1", { continuation }, undefined, undefined, { ...r.ctx, mode } as ToolContext);
}

test("tool dispatches command explicitly, returns queued and ends the run", async () => {
  const r = runtime();
  try {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    assert.equal(r.tools.get("self_reload")!.renderCall!({ continuation: "Verify the new version." }, theme, { argsComplete: true } as never).render(120)[0].trimEnd(), "self reload Verify the new version.");
    const result = await invoke(r);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, { status: "queued", reason: undefined, expectedTools: [] });
    assert.match(r.userMessages[0][0] as string, /^\/self-reload request:/);
    assert.deepEqual(r.userMessages[0][1], { deliverAs: "followUp", expandPromptTemplates: true });
    await assert.rejects(invoke(r), /already pending/);
    assert.equal(r.messages.length, 0);
  } finally { r.close(); }
});

test("rejects headless print/json modes and blank instructions", async () => {
  const r = runtime();
  try {
    await assert.rejects(invoke(r, "Continue", "print"), /interactive or RPC/);
    await assert.rejects(invoke(r, "Continue", "json"), /interactive or RPC/);
    await assert.rejects(invoke(r, "  "), /non-empty/);
    assert.equal(r.userMessages.length, 0);
  } finally { r.close(); }
});

test("waits for idle, then completion comes only from the NEW runtime after reload returns", async () => {
  const old = runtime();
  const other = runtime("other-session");
  let fresh: ReturnType<typeof runtime> | undefined;
  const order: string[] = [];
  try {
    await old.commands.get("self-reload")!.handler("Run the new tool", {
      ...old.ctx,
      waitForIdle: async () => { order.push("idle"); },
      reload: async () => {
        order.push("reload");
        old.close();
        fresh = runtime();
        assert.equal(fresh.messages.length, 0, "must not announce success during session_start");
        order.push("reload-return");
      },
    } as unknown as ExtensionCommandContext);
    assert.deepEqual(order, ["idle", "reload", "reload-return"]);
    assert.equal(old.messages.length, 0);
    assert.equal(other.messages.length, 0);
    assert.equal(fresh!.messages.length, 1);
    const [message, options] = fresh!.messages[0] as [{ content: string }, unknown];
    assert.match(message.content, /Reload complete/);
    assert.match(message.content, /Run the new tool/);
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
  } finally { old.close(); fresh?.close(); other.close(); }
});

test("failed reload does not announce success and permits retry", async () => {
  const r = runtime();
  const ctx = {
    ...r.ctx, waitForIdle: async () => {}, reload: async () => { throw new Error("load failed"); },
  } as unknown as ExtensionCommandContext;
  try {
    await r.commands.get("self-reload")!.handler("", ctx);
    await r.commands.get("self-reload")!.handler("", ctx);
    assert.equal(r.messages.length, 2);
    assert.match((r.messages[0][0] as { content: string }).content, /Reload failed: load failed/);
    assert.equal((r.messages[0][0] as any).details.status, "failed");
    assert.deepEqual(r.statuses.at(-1), ["self-reload", undefined]);
  } finally { r.close(); }
});

test("duplicate requests are rejected while waiting for idle", async () => {
  const r = runtime();
  let release!: () => void;
  const idle = new Promise<void>((resolve) => { release = resolve; });
  const ctx = {
    ...r.ctx, waitForIdle: () => idle, reload: async () => { throw new Error("test exit"); },
  } as unknown as ExtensionCommandContext;
  const pending = r.commands.get("self-reload")!.handler("", ctx);
  try {
    await assert.rejects(invoke(r), /already pending/);
    await assert.rejects(r.commands.get("self-reload")!.handler("", ctx), /already pending/);
  } finally {
    release();
    await pending;
    r.close();
  }
});

test("reason and expected tools survive handoff; availability is not behavior verification", async () => {
  const old = runtime();
  let fresh: ReturnType<typeof runtime> | undefined;
  try {
    await old.tools.get("self_reload")!.execute("call", {
      continuation: "Exercise the renderer.", reason: "Activate the renderer", expectedTools: ["self_reload", "missing", "missing"],
    }, undefined, undefined, old.ctx);
    const args = (old.userMessages[0][0] as string).slice("/self-reload ".length);
    await old.commands.get("self-reload")!.handler(args, {
      ...old.ctx, waitForIdle: async () => {}, reload: async () => { old.close(); fresh = runtime(); },
    } as unknown as ExtensionCommandContext);
    const message = fresh!.messages[0][0] as any;
    assert.deepEqual(message.details, { status: "reloaded", reason: "Activate the renderer", expectedTools: ["self_reload", "missing"], missingTools: ["missing"] });
    assert.match(message.content, /Expected tools not active: missing/);
    assert.match(message.content, /does not verify extension behavior/);
    assert.match(old.notices[0][0] as string, /Activate the renderer/);
    assert.deepEqual(old.statuses.slice(0, 2), [["self-reload", "Waiting for agent to finish…"], ["self-reload", "Reloading Pi resources…"]]);
    assert.deepEqual(fresh!.statuses.at(-1), ["self-reload", undefined]);
  } finally { old.close(); fresh?.close(); }
});

test("reload failure after replacement is reported by the new runtime", async () => {
  const old = runtime();
  let fresh: ReturnType<typeof runtime> | undefined;
  try {
    await old.commands.get("self-reload")!.handler("Verify", {
      ...old.ctx, waitForIdle: async () => {}, reload: async () => {
        old.close(); fresh = runtime(); throw new Error("discovery failed");
      },
    } as unknown as ExtensionCommandContext);
    assert.equal(old.messages.length, 0);
    assert.match((fresh!.messages[0][0] as any).content, /Reload failed: discovery failed/);
  } finally { old.close(); fresh?.close(); }
});

test("missing replacement gives recovery instructions even with another session listening", async () => {
  for (const fail of [false, true]) {
    const old = runtime();
    const other = runtime("other-session");
    try {
      await assert.rejects(old.commands.get("self-reload")!.handler("Verify", {
        ...old.ctx, waitForIdle: async () => {}, reload: async () => {
          old.close(); if (fail) throw new Error("load failed");
        },
      } as unknown as ExtensionCommandContext), /continuation.*unavailable.*manual \/reload/i);
      assert.equal(other.messages.length, 0);
    } finally { old.close(); other.close(); }
  }
});

test("TUI delegates reload progress to Pi without losing process warnings", async () => {
  for (const fromTool of [true, false]) {
    const old = runtime();
    let fresh: ReturnType<typeof runtime> | undefined;
    try {
      let args = "Verify after direct command";
      if (fromTool) {
        const result = await invoke(old, "Verify", "tui");
        assert.match((result.content[0] as { text: string }).text, /extension-owned processes may stop/);
        args = (old.userMessages[0][0] as string).slice("/self-reload ".length);
      }
      await old.commands.get("self-reload")!.handler(args, {
        ...old.ctx, mode: "tui", waitForIdle: async () => {},
        reload: async () => { old.close(); fresh = runtime(); },
      } as unknown as ExtensionCommandContext);
      assert.equal(old.notices.length, fromTool ? 0 : 1);
      if (!fromTool) assert.equal(old.notices[0][0], "Conversation preserved; extension-owned processes may stop.");
      assert.deepEqual(old.statuses.slice(0, 2), [["self-reload", "Waiting for agent to finish…"], ["self-reload", undefined]]);
      assert.equal(fresh!.messages.length, 1);
    } finally { old.close(); fresh?.close(); }
  }
});

test("expanded call exposes full continuation and sanitizes terminal controls", () => {
  const r = runtime();
  try {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    const continuation = "x".repeat(300) + " THE END";
    const render = r.tools.get("self_reload")!.renderCall!;
    const lines = render({ reason: "Activate\u001b[31m renderer", continuation, expectedTools: ["self_reload"] }, theme, { expanded: true, argsComplete: true } as never).render(40);
    const text = lines.join("\n");
    assert.match(text, /THE END/);
    assert.match(text, /Expected tools: self_reload/);
    assert.doesNotMatch(text, /\u001b/);
    assert.ok(lines.every(line => line.length <= 40));
  } finally { r.close(); }
});
