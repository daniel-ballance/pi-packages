import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  normalizeContext, Type,
  type AssistantMessage, type AssistantMessageEvent, type Message, type SimpleStreamOptions, type Tool,
} from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ClaudeSubscription } from "../extensions/claude-subscription/src/provider.js";
import { fakeQuery, textOf, type Script } from "./support/claude.js";

const SYSTEM = "You are a coding assistant inside Pi.";
const TOOLS: Tool[] = [
  { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
  { name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
];
const REJECTION = "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";

function said(result: CallToolResult): string {
  return result.content.map(block => block.type === "text" ? block.text : `[${block.type}]`).join("\n");
}

/** Pi's side of the conversation: a transcript that grows, sent whole on every request. */
function harness(t: TestContext, ...scripts: (Script | undefined)[]) {
  const { query, spawned } = fakeQuery(...scripts);
  const subscription = new ClaudeSubscription({
    version: "0.0.0-test", query, cwd: () => "/work",
    env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://gateway.invalid", CLAUDE_CODE_OAUTH_TOKEN: "kept" },
  });
  t.after(() => subscription.closeSessions());
  const messages: Message[] = [];
  let tools = TOOLS;
  return {
    subscription, spawned, messages,
    setTools(next: Tool[]) { tools = next; },
    user(text: string) { messages.push({ role: "user", content: text, timestamp: 1 }); },
    answer(call: AssistantMessage, texts: Record<string, string>) {
      for (const block of call.content) {
        if (block.type !== "toolCall" || !(block.id in texts)) continue;
        messages.push({ role: "toolResult", toolCallId: block.id, toolName: block.name, content: [{ type: "text", text: texts[block.id] }], isError: false, timestamp: 1 });
      }
    },
    async ask(options: SimpleStreamOptions = {}, modelId = "claude-opus-5-5", onEvent?: (event: AssistantMessageEvent) => void) {
      const model = subscription.provider.getModels().find(candidate => candidate.id === modelId);
      assert.ok(model, modelId);
      const stream = subscription.provider.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, messages, tools }), options);
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) {
        events.push(event);
        onEvent?.(event);
      }
      const message = await stream.result();
      messages.push(message);
      return { events, message, text: message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("") };
    },
  };
}

test("a turn that calls tools pauses on Pi and resumes in the same Claude Code session", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [
      { id: "toolu_1", name: "mcp__pi__read", input: { path: "a.txt" } },
      { id: "toolu_2", name: "mcp__pi__bash", input: { command: "ls" } },
    ], [first.uuid]);
    // Claude Code runs these one after the other; each waits for Pi.
    const one = await claude.call("toolu_1", "read", { path: "a.txt" });
    const two = await claude.call("toolu_2", "bash", { command: "ls" });
    claude.text("msg_2", `saw ${said(one)} and ${said(two)}`);
    claude.result([first.uuid]);
    const second = await claude.user();
    claude.text("msg_3", "again", { uuids: [second.uuid] });
    claude.result([second.uuid]);
  });

  h.user("Read a.txt and list the files.");
  const called = await h.ask();
  assert.equal(called.message.stopReason, "toolUse");
  assert.deepEqual(called.message.content, [
    { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "toolu_2", name: "bash", arguments: { command: "ls" } },
  ]);
  assert.deepEqual(called.events.map(event => event.type), [
    "start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
    "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
  ]);
  assert.equal(called.message.responseId, "msg_1");
  assert.equal(called.message.provider, "claude-subscription");

  h.answer(called.message, { toolu_1: "alpha", toolu_2: "a.txt b.txt" });
  const finished = await h.ask();
  assert.equal(finished.message.stopReason, "stop");
  assert.equal(finished.text, "saw alpha and a.txt b.txt");

  h.user("And again?");
  assert.equal((await h.ask()).text, "again");

  assert.equal(h.spawned.length, 1, "one Claude Code process served the whole conversation");
  const [claude] = h.spawned;
  assert.deepEqual(claude.failures, []);
  assert.deepEqual(claude.received.map(textOf), ["Read a.txt and list the files.", "And again?"]);
});

test("Claude Code is given the transcript prompt and Pi's tools, and none of its own", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("/help @README.md is ordinary text to Pi");
  await h.ask();
  const [claude] = h.spawned;
  const { options } = claude;
  assert.equal(options.systemPrompt, SYSTEM);
  assert.equal(options.model, "claude-opus-5-5");
  assert.deepEqual(options.tools, [], "no built-in Claude Code tools");
  assert.deepEqual(options.settingSources, [], "no user or project Claude Code settings");
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.verbatimPrompts, true, "slash commands and @mentions are not Claude Code's to expand");
  assert.deepEqual(options.settings, { autoCompactEnabled: false });
  assert.equal(options.permissionPrompts, "none");
  assert.deepEqual(options.allowedTools, ["mcp__pi"]);
  assert.deepEqual(options.toolAliases, { read: "mcp__pi__read", bash: "mcp__pi__bash" });
  assert.equal(options.cwd, "/work");
  assert.equal(textOf(claude.received[0]), "/help @README.md is ordinary text to Pi");
  assert.deepEqual(await claude.tools(), [
    { name: "read", description: "Read a file", _meta: { "anthropic/alwaysLoad": true },
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "bash", description: "Run a command", _meta: { "anthropic/alwaysLoad": true },
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ]);
});

test("the Claude Code process keeps its login but loses per-token API routing", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok");
    claude.result([first.uuid]);
  });
  h.user("hi");
  await h.ask();
  const env = h.spawned[0].options.env ?? {};
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "kept");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "pi-claude-subscription/0.0.0-test");
});

test("a login that is not a subscription is refused before anything is sent", async t => {
  const h = harness(t, async claude => {
    claude.account = { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" };
  });
  h.user("hi");
  const { message, events } = await h.ask();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /not signed in with a Claude subscription \(it is using an API key from ANTHROPIC_API_KEY\)/);
  assert.match(message.errorMessage ?? "", /claude auth login/);
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.deepEqual(h.spawned[0].received, []);
  assert.equal(h.spawned[0].closed, true);
});

test("Anthropic's rejection reaches Pi verbatim and the failed session is not reused", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.apiError(REJECTION, "invalid_request", [first.uuid]);
  }, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "fine now", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("hi");
  const rejected = await h.ask();
  assert.equal(rejected.message.stopReason, "error");
  assert.equal(rejected.message.errorMessage, REJECTION);
  assert.deepEqual(rejected.message.content, [], "Claude Code's synthetic error message is not model output");
  assert.equal(h.spawned[0].closed, true);

  assert.equal((await h.ask()).text, "fine now");
  assert.equal(h.spawned.length, 2);
  assert.equal(textOf(h.spawned[1].received[0]), "hi", "the failed turn is not replayed as history");
});

test("a transcript Pi rewrote starts a new session seeded with the record", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [{ id: "toolu_1", name: "mcp__pi__read", input: { path: "a.txt" } }], [first.uuid]);
    await claude.call("toolu_1", "read", { path: "a.txt" });
    claude.text("msg_2", "It says alpha.");
    claude.result([first.uuid]);
  }, async claude => {
    const first = await claude.user();
    claude.text("msg_9", "resumed", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("Read a.txt");
  h.answer((await h.ask()).message, { toolu_1: "alpha" });
  await h.ask();
  // Compaction, a branch or an edit: the history no longer extends what the session saw.
  h.messages[0] = { role: "user", content: "Read a.txt, please", timestamp: 1 };
  h.user("What did it say?");
  assert.equal((await h.ask()).text, "resumed");

  assert.equal(h.spawned.length, 2);
  assert.equal(textOf(h.spawned[1].received[0]), [
    "This conversation began before the current session and is replayed here as a record. Everything inside <conversation-history> already happened: the tool calls were executed and their results are final. The record is not a format to imitate. To call a tool now, call it the normal way.",
    "",
    "<conversation-history>",
    "<user>",
    "Read a.txt, please",
    "</user>",
    "<assistant>",
    '<tool-call id="toolu_1" name="read">{"path":"a.txt"}</tool-call>',
    "</assistant>",
    '<tool-result id="toolu_1" name="read" status="ok">',
    "alpha",
    "</tool-result>",
    "<assistant>",
    "It says alpha.",
    "</assistant>",
    "</conversation-history>",
    "",
    "What did it say?",
  ].join("\n"));
});

test("input sent with tool results is folded into the running turn, however Claude Code schedules it", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [{ id: "toolu_1", name: "mcp__pi__bash", input: { command: "make" } }], [first.uuid]);
    const [result, steer] = await Promise.all([claude.call("toolu_1", "bash", { command: "make" }), claude.user()]);
    claude.text("msg_2", `built: ${said(result)}. `);
    // The steering message was not taken up by this turn, so another follows.
    claude.result([first.uuid], { queued_turn_count: 1 });
    claude.text("msg_3", `steered: ${textOf(steer)}`, { uuids: [steer.uuid] });
    claude.result([steer.uuid]);
  });
  h.user("Run make");
  h.answer((await h.ask()).message, { toolu_1: "ok" });
  h.user("Also run the tests");
  const { message, text } = await h.ask();
  assert.equal(text, "built: ok. steered: Also run the tests");
  assert.equal(message.stopReason, "stop");
  assert.equal(message.responseId, "msg_3");
  assert.equal(h.spawned.length, 1);
});

test("tool calls Pi never answered are closed out when the conversation moves on", async t => {
  let unanswered: CallToolResult | undefined;
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [{ id: "toolu_1", name: "mcp__pi__bash", input: { command: "sleep 99" } }], [first.uuid]);
    const [result, next] = await Promise.all([claude.call("toolu_1", "bash", { command: "sleep 99" }), claude.user()]);
    unanswered = result;
    claude.text("msg_2", "moving on", { uuids: [next.uuid] });
    claude.result([first.uuid, next.uuid]);
  });
  h.user("Run it");
  await h.ask();
  h.user("Forget that.");
  assert.equal((await h.ask()).text, "moving on");
  assert.deepEqual(unanswered, { content: [{ type: "text", text: "No result provided" }], isError: true });
  assert.equal(h.spawned.length, 1);
});

test("aborting interrupts the turn and leaves the session usable", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.partial("msg_1", "1\n2\n");
    await claude.interrupted();
    claude.result([first.uuid], { subtype: "error_during_execution", is_error: true, errors: ["aborted"], terminal_reason: "aborted_streaming" });
    const second = await claude.user();
    claude.text("msg_2", "ready", { uuids: [second.uuid] });
    claude.result([second.uuid]);
  });
  h.user("Count to 300");
  const controller = new AbortController();
  const aborted = await h.ask({ signal: controller.signal }, undefined, event => {
    if (event.type === "text_delta") controller.abort();
  });
  assert.equal(aborted.message.stopReason, "aborted");
  assert.equal(aborted.events.at(-1)?.type, "error");
  assert.equal(aborted.text, "1\n2\n", "what streamed before the abort is kept on the message");
  assert.equal(h.spawned[0].interrupts, 1);
  assert.equal(h.spawned[0].closed, false);

  h.user("Never mind");
  assert.equal((await h.ask()).text, "ready");
  assert.equal(h.spawned.length, 1);
});

test("a request aborted before it starts leaves a waiting turn untouched", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [{ id: "toolu_1", name: "mcp__pi__read", input: { path: "a" } }], [first.uuid]);
    const result = await claude.call("toolu_1", "read", { path: "a" });
    claude.text("msg_2", said(result));
    claude.result([first.uuid]);
  });
  h.user("Read a");
  const called = await h.ask();
  h.answer(called.message, { toolu_1: "alpha" });
  const controller = new AbortController();
  controller.abort();
  const aborted = await h.ask({ signal: controller.signal });
  assert.equal(aborted.message.stopReason, "aborted");
  h.messages.pop();
  assert.equal((await h.ask()).text, "alpha", "the held tool call still gets Pi's real result");
  assert.equal(h.spawned.length, 1);
});

test("thinking levels become effort, and a change of effort keeps the session", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "answer", {
      uuids: [first.uuid], thinking: "let me think",
      usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 8, output_tokens: 7 },
    });
    claude.result([first.uuid]);
    const second = await claude.user();
    claude.text("msg_2", "quick", { uuids: [second.uuid] });
    claude.result([second.uuid]);
  });
  h.user("Think about it");
  const { message, events } = await h.ask({ reasoning: "high" });
  assert.deepEqual(h.spawned[0].options.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(h.spawned[0].options.effort, "high");
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "let me think", thinkingSignature: "sig" },
    { type: "text", text: "answer" },
  ]);
  assert.deepEqual(events.map(event => event.type).filter(type => type.startsWith("thinking")), ["thinking_start", "thinking_delta", "thinking_end"]);
  assert.deepEqual(message.usage, {
    input: 100, output: 7, cacheRead: 40, cacheWrite: 8, totalTokens: 155,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  h.user("Now quickly");
  await h.ask({ reasoning: "low" });
  assert.deepEqual(h.spawned[0].efforts, ["low"]);
  assert.equal(h.spawned.length, 1);
});

test("older models take a thinking budget, and turning thinking off starts over", async t => {
  const reply: Script = async claude => {
    const first = await claude.user();
    claude.text("msg", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  };
  const h = harness(t, reply, reply);
  h.user("one");
  await h.ask({ reasoning: "medium" }, "claude-haiku-4-5");
  assert.deepEqual(h.spawned[0].options.thinking, { type: "enabled", budgetTokens: 8192, display: "summarized" });
  assert.equal(h.spawned[0].options.effort, undefined);
  h.user("two");
  await h.ask({}, "claude-haiku-4-5");
  assert.deepEqual(h.spawned[1].options.thinking, { type: "disabled" });
});

test("a request that forbids tool calls presents no tools", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "summary", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("Summarise");
  await h.ask({ toolChoice: "none" });
  assert.deepEqual(h.spawned[0].options.mcpServers, {});
  assert.deepEqual(h.spawned[0].options.toolAliases, {});
});

test("a tool call Claude Code does not identify fails instead of hanging", async t => {
  let outcome: CallToolResult | undefined;
  const h = harness(t, async claude => {
    const first = await claude.user();
    outcome = await claude.call(undefined, "read", { path: "a" });
    claude.text("msg_1", "done", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("go");
  await h.ask();
  assert.equal(outcome?.isError, true);
  assert.match(said(outcome!), /could not match this call to a tool_use block/);
});

test("request hooks see the turn input, may replace it, and observe every SDK message", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("original");
  const payloads: unknown[] = [];
  const seen: unknown[] = [];
  await h.ask({
    onPayload: payload => {
      payloads.push(payload);
      return { input: [{ type: "text", text: "replaced" }] };
    },
    onProviderStreamEvent: message => {
      seen.push(message);
    },
  });
  assert.deepEqual(payloads, [{
    model: "claude-opus-5-5", session: "new", thinking: { type: "adaptive", display: "summarized" }, effort: undefined,
    toolResults: {}, input: [{ type: "text", text: "original" }],
  }]);
  assert.equal(textOf(h.spawned[0].received[0]), "replaced");
  assert.ok(seen.length > 3);
});

test("shutdown closes every Claude Code process", async t => {
  const reply: Script = async claude => {
    const first = await claude.user();
    claude.text("msg", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  };
  const h = harness(t, reply, reply);
  h.user("one");
  await h.ask();
  h.messages.length = 0;
  h.user("another conversation");
  await h.ask();
  assert.equal(h.subscription.openSessions, 2);
  h.subscription.closeSessions();
  assert.equal(h.subscription.openSessions, 0);
  assert.deepEqual(h.spawned.map(claude => claude.closed), [true, true]);
});
