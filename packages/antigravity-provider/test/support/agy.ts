import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { agent, methods, ndJsonStream, RequestError, type NewSessionResponse, type RequestPermissionRequest, type ToolCall, type SessionUpdate } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const session = JSON.parse(readFileSync(new URL("../fixtures/session-new.json", import.meta.url), "utf8")) as NewSessionResponse;
const log = (kind: string, value?: unknown) => appendFileSync(process.env.FAKE_LOG!, JSON.stringify({ kind, value }) + "\n");
log("spawn", { pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), keys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"].filter(name => name in process.env) });
assert.deepEqual(process.argv.slice(2), ["acp"]);
let mcp: Client | undefined;
let cancelled: (() => void) | undefined;
let count = 0;
const s = methods.agent.session;
const c = methods.client.session;
const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] as const;
const app = agent({ name: "fake-agy" })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    log("initialize", params);
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {}, close: {} },
      promptCapabilities: { image: true, embeddedContext: true }, _meta: { antigravity: { systemPrompt: { append: true } } } } };
  })
  .onRequest(s.new, async ({ params }) => {
    log("new", params);
    if (process.env.FAKE_AUTH_REQUIRED) throw RequestError.authRequired();
    const bridge = params.mcpServers.find(server => server.name === "pi");
    if (bridge && "command" in bridge) {
      const client = mcp = new Client({ name: "fake-agy", version: "1.0.0" });
      client.setNotificationHandler(ToolListChangedNotificationSchema,
        async () => log("toolsChanged", (await client.listTools()).tools));
      await client.connect(new StdioClientTransport({ command: bridge.command, args: bridge.args,
        env: Object.fromEntries(bridge.env.map(({ name, value }) => [name, value])) }));
      log("tools", (await client.listTools()).tools);
    }
    return session;
  })
  .onRequest(s.setConfigOption, async ({ params }) => {
    log("config", params);
    const options = session.configOptions!;
    const config = options.find(config => config.id === params.configId);
    if (config?.type === "select" && typeof params.value === "string") config.currentValue = params.value;
    return { configOptions: options };
  })
  .onRequest(s.close, async () => { log("close"); await mcp?.close(); })
  .onNotification(s.cancel, async () => { log("cancel"); cancelled?.(); })
  .onRequest(s.prompt, async ({ params, client }) => {
    log("prompt", params.prompt);
    const { sessionId } = params;
    const text = params.prompt.findLast(block => block.type === "text")?.text ?? "";
    const update = (update: SessionUpdate) => client.notify(c.update, { sessionId, update });
    const chunk = (text: string, thinking = false) => update({
      sessionUpdate: thinking ? "agent_thought_chunk" : "agent_message_chunk", content: { type: "text", text },
    });
    const permission = async (toolCall: RequestPermissionRequest["toolCall"], choices: RequestPermissionRequest["options"] = [...options]) => {
      const { outcome } = await client.request(c.requestPermission, { sessionId, toolCall, options: choices });
      log("permission", { outcome });
      return outcome.outcome === "selected" ? outcome.optionId : undefined;
    };
    const start = (toolCall: ToolCall) => update({ ...toolCall, sessionUpdate: "tool_call" });
    const finish = (toolCallId: string, allowed: boolean, rawOutput?: unknown) => update({
      toolCallId, sessionUpdate: "tool_call_update", status: allowed ? "completed" : "failed", rawOutput,
    });
    const call = async (name: string, input: Record<string, unknown>, { native = false, requestPermission = true } = {}) => {
      const toolCallId = `mcp-${++count}`;
      const toolCall = { toolCallId, title: native ? `Run mcp_pi_${name}?` : `MCP Tool ${name}`,
        kind: "execute" as const, status: "pending" as const, rawInput: native ? input : { ServerName: "pi", ToolName: name, Arguments: input } };
      await start(toolCall);
      if (requestPermission && await permission(toolCall) !== "allow" || !mcp) { await finish(toolCallId, false); return undefined; }
      const result = await mcp.callTool({ name, arguments: input, _meta: { "antigravity.google/conversation_id": sessionId } });
      log("result", result);
      await finish(toolCallId, !result.isError);
      return result;
    };
    if (text === "error") throw RequestError.internalError(undefined, "agy rejected the prompt");
    if (text === "crash") {
      process.stderr.write("fake agy crash\n", () => process.exit(17));
      await new Promise(() => {});
    }
    if (text === "abort" || text === "abort-card") {
      const wait = new Promise<void>(resolve => { cancelled = resolve; });
      if (text === "abort-card") {
        const tool = { toolCallId: "abort-card", title: "Running command", kind: "execute", status: "in_progress" } as const;
        await start(tool);
        await permission(tool);
      } else await chunk("partial");
      await wait;
      return { stopReason: "cancelled" };
    }
    if (text === "builtins") {
      const read = { toolCallId: "read-1", title: "Read file", kind: "read", status: "in_progress", rawInput: { TargetFile: "x" } } as const;
      const command = { toolCallId: "command-1", title: "run_command", kind: "execute", status: "pending", rawInput: { CommandLine: "npm test", Cwd: process.cwd() } } as const;
      const edit: ToolCall = { toolCallId: "edit-1", title: "Run edit_file?", kind: "edit", status: "pending",
        content: [{ type: "diff", path: "src/x.ts", oldText: "old line\n", newText: "new line\n" }] };
      for (const tool of [read, command, edit]) await start(tool);
      await update({ sessionUpdate: "tool_call_update", toolCallId: read.toolCallId, status: "completed",
        content: [{ type: "content", content: { type: "text", text: "read output" } }] });
      const allowed = await permission(command) === "allow";
      await finish(command.toolCallId, allowed, { combinedOutput: allowed ? "command output" : "denied" });
      const editAllowed = await permission(edit) === "allow";
      await finish(edit.toolCallId, editAllowed, editAllowed ? "edited" : "denied");
    }
    const ask = () => permission({ toolCallId: "interaction_9960062f", status: "pending", title: "Which label should be used?", rawInput: {} }, [
      { optionId: "1", name: "Verified", kind: "allow_once" }, { optionId: "2", name: "Needs review", kind: "allow_once" },
    ]);
    if (text.startsWith("interleave-")) {
      const first = { toolCallId: "interleave-a", title: "First command", kind: "execute", status: "in_progress" } as const;
      await start(first);
      if (await permission(first) === "allow") {
        if (text === "interleave-permission") {
          const second = { toolCallId: "interleave-b", title: "Second command", kind: "execute", status: "pending" } as const;
          await finish(second.toolCallId, await permission(second) === "allow", "second output");
        } else if (text === "interleave-question") await ask();
        else await call("fixture_direct", { value: "interleaved" });
        await finish(first.toolCallId, true, "first late output");
      }
    }
    if (text === "question and mcp" || text === "question") {
      await ask();
      if (text.endsWith("mcp")) {
        await call("fixture_direct", { value: "direct", toolSummary: "ignored" }, { native: true });
        await call("fixture_deferred", { value: "deferred" });
      }
    }
    if (text === "mcp-missing") await call("fixture_direct", { value: "removed" }, { requestPermission: false });
    if (text === "mcp-active") await call("fixture_direct", { value: "active" });
    const background = { toolCallId: "background-permission", title: "Background command", kind: "execute", status: "in_progress" } as const;
    if (text === "start detached command") await start(background);
    if (text === "request detached permission") await finish(background.toolCallId, await permission(background) === "allow", "background command output");
    if (text.startsWith("long-")) {
      const first = await call("fixture_direct", { value: "slow" });
      const id = JSON.stringify(first).match(/The tool ([^ ]+) is still running/)?.[1];
      if (text === "long-other") await call("fixture_direct", { value: "next" });
      if (text === "long-retry" && id) {
        const retry = await call("await_tool_result", { id });
        if (JSON.stringify(retry).includes("still running")) await call("await_tool_result", { id });
      }
    }
    if (text === "wake") {
      const backgroundId = "background";
      await start({ toolCallId: backgroundId, title: "Run command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "background work" } });
      void delay(80).then(async () => {
        await finish(backgroundId, true, { combinedOutput: "background output" });
        await chunk("awake from agy");
      });
    }
    if (text === "slow") { await chunk("partial"); await delay(75); }
    if (text === "changed") await update({ sessionUpdate: "usage_update", used: 17, size: 123_456 });
    await chunk("considering", true);
    await chunk("hel");
    await chunk("lo");
    const usage = { inputTokens: 21, outputTokens: 8, cachedReadTokens: 2, cachedWriteTokens: 1, thoughtTokens: 3, totalTokens: 32 };
    return { stopReason: "end_turn", usage };
  });
await app.connectWith(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>), () => new Promise(() => {}));
