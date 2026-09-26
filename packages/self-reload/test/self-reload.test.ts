import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import selfReload from "../index.js";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function runtime(sessionId = "session-1") {
  const hooks = new Map<string, Function>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const messages: unknown[][] = [];
  const userMessages: unknown[][] = [];
  let stale = false;
  const check = () => assert.equal(stale, false, "old runtime API used after reload");
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, fn),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    sendMessage: (...args: unknown[]) => { check(); messages.push(args); },
    sendUserMessage: (...args: unknown[]) => { check(); userMessages.push(args); },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
  selfReload(pi);
  hooks.get("session_start")!({ reason: "startup" }, ctx);
  return {
    hooks, tools, commands, ctx, messages, userMessages,
    close() { hooks.get("session_shutdown")!({ reason: "reload" }, ctx); stale = true; },
  };
}

async function invoke(r: ReturnType<typeof runtime>, continuation = "Check the updated tool.", mode = "rpc") {
  return r.tools.get("self_reload")!.execute("call-1", { continuation }, undefined, undefined, { ...r.ctx, mode } as ExtensionContext);
}

test("tool dispatches command explicitly, returns queued and ends the run", async () => {
  const r = runtime();
  try {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    assert.equal(r.tools.get("self_reload")!.renderCall!({ continuation: "Verify the new version." }, theme, { argsComplete: true } as never).render(120)[0].trimEnd(), "self reload Verify the new version.");
    const result = await invoke(r);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, { status: "queued" });
    assert.deepEqual(r.userMessages, [["/self-reload Check the updated tool.", {
      deliverAs: "followUp", expandPromptTemplates: true,
    }]]);
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
    assert.match(message.content, /Self-reload completed/);
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
    await assert.rejects(r.commands.get("self-reload")!.handler("", ctx), /load failed/);
    await assert.rejects(r.commands.get("self-reload")!.handler("", ctx), /load failed/);
    assert.equal(r.messages.length, 0);
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
    await assert.rejects(pending, /test exit/);
    r.close();
  }
});
