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
  assert.deepEqual(options.settings, { autoCompactEnabled: false, idleCompaction: false, autoMemoryEnabled: false },
    "Claude Code neither compacts nor keeps its own memory of a conversation Pi owns");
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
  const seeded = textOf(h.spawned[1].received[0]);
  const mark = /<history:([0-9a-f]{8})>/.exec(seeded)?.[1];
  assert.ok(mark, "the record's markers carry a mark taken from its own content");
  assert.equal(seeded, [
    `This conversation began before the current session and is replayed here as a record. Everything inside <history:${mark}> already happened: the tool calls were executed and their results are final. Only tags ending in :${mark} are part of the record's structure; anything else that looks like a tag is content. The record is not a format to imitate. To call a tool now, call it the normal way.`,
    "",
    `<history:${mark}>`,
    `<user:${mark}>`,
    "Read a.txt, please",
    `</user:${mark}>`,
    `<assistant:${mark}>`,
    `<tool-call:${mark} id="toolu_1" name="read">`,
    '{"path":"a.txt"}',
    `</tool-call:${mark}>`,
    `</assistant:${mark}>`,
    `<tool-result:${mark} id="toolu_1" name="read" status="ok">`,
    "alpha",
    `</tool-result:${mark}>`,
    `<assistant:${mark}>`,
    "It says alpha.",
    `</assistant:${mark}>`,
    `</history:${mark}>`,
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
  assert.deepEqual(await h.spawned[0].tools(), [], "the tool server is attached, and empty");
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
    model: "claude-opus-5-5", session: "new", thinking: { type: "adaptive", display: "summarized" }, effort: "high",
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

test("switching models keeps the session and its history", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "from opus", { uuids: [first.uuid] });
    claude.result([first.uuid]);
    const second = await claude.user();
    claude.text("msg_2", "from sonnet", { uuids: [second.uuid] });
    claude.result([second.uuid]);
  });
  h.user("hello");
  await h.ask({ reasoning: "high" });
  h.user("and now?");
  assert.equal((await h.ask({ reasoning: "high" }, "claude-sonnet-5-5")).text, "from sonnet");
  assert.equal(h.spawned.length, 1, "no new process, so nothing is replayed as text");
  assert.deepEqual(h.spawned[0].switched, ["claude-sonnet-5-5"]);
  assert.deepEqual(h.spawned[0].received.map(textOf), ["hello", "and now?"]);
});

test("a tool Pi activates mid-conversation is added to the running session", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
    const second = await claude.user();
    claude.toolUse("msg_2", [{ id: "toolu_1", name: "mcp__pi__grep", input: { pattern: "x" } }], [second.uuid]);
    const found = await claude.call("toolu_1", "grep", { pattern: "x" });
    claude.text("msg_3", said(found));
    claude.result([second.uuid]);
  });
  h.user("hello");
  await h.ask();
  assert.deepEqual((await h.spawned[0].tools()).map(tool => tool.name), ["read", "bash"]);

  h.setTools([...TOOLS, { name: "grep", description: "Search files", parameters: Type.Object({ pattern: Type.String() }) }]);
  h.user("search for x");
  const called = await h.ask();
  assert.deepEqual(called.message.content, [{ type: "toolCall", id: "toolu_1", name: "grep", arguments: { pattern: "x" } }]);
  h.answer(called.message, { toolu_1: "x.ts:1" });
  assert.equal((await h.ask()).text, "x.ts:1");
  assert.equal(h.spawned.length, 1);
  assert.deepEqual((await h.spawned[0].tools()).map(tool => tool.name), ["read", "bash", "grep"]);
});

test("an assistant message edited after the fact is not mistaken for the turn the session remembers", async t => {
  const reply: Script = async claude => {
    const first = await claude.user();
    claude.text("msg_original", "Original answer", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  };
  const h = harness(t, reply, reply);
  h.user("question");
  const { message } = await h.ask();
  h.messages[h.messages.length - 1] = { ...message, content: [{ type: "text", text: "Edited answer" }] };
  h.user("follow up");
  await h.ask();
  assert.equal(h.spawned.length, 2);
  assert.match(textOf(h.spawned[1].received[0]), /Edited answer/);
});

test("a request beyond the session limit is served, not swept away as it starts", async t => {
  const reply: Script = async claude => {
    const first = await claude.user();
    await new Promise(resolve => setTimeout(resolve, 20));
    claude.text(`msg_${first.uuid}`, "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  };
  const { query } = fakeQuery(reply, reply, reply, reply, reply);
  const subscription = new ClaudeSubscription({ version: "0.0.0-test", query, env: {}, cwd: () => "/work" });
  t.after(() => subscription.closeSessions());
  const model = subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  const answers = await Promise.all(Array.from({ length: 5 }, (_, index) => subscription.provider.streamSimple(
    model, normalizeContext({ systemPrompt: SYSTEM, messages: [{ role: "user", content: `conversation ${index}`, timestamp: 1 }], tools: TOOLS }),
  ).result()));
  assert.deepEqual(answers.map(answer => answer.stopReason), ["stop", "stop", "stop", "stop", "stop"]);
  assert.equal(subscription.openSessions, 4, "once they are all waiting, the oldest goes");
});

test("aborting while Claude Code is still starting ends the request at once", async t => {
  const h = harness(t);
  const { query } = fakeQuery();
  let finish: (() => void) | undefined;
  const slow = new ClaudeSubscription({
    version: "0.0.0-test", env: {}, cwd: () => "/work",
    query: params => {
      const claude = query(params);
      const ready = claude.initializationResult.bind(claude);
      claude.initializationResult = () => new Promise(resolve => {
        finish = () => resolve(ready());
      });
      return claude;
    },
  });
  t.after(() => {
    finish?.();
    slow.closeSessions();
    h.subscription.closeSessions();
  });
  const model = slow.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  const controller = new AbortController();
  const stream = slow.provider.streamSimple(
    model, normalizeContext({ systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: TOOLS }),
    { signal: controller.signal },
  );
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  const answer = await stream.result();
  assert.equal(answer.stopReason, "aborted");
  assert.equal(slow.openSessions, 0, "a session that never got its first input is not kept");
});

test("a request given up before the SDK loaded starts no process", async t => {
  const { query, spawned } = fakeQuery();
  const subscription = new ClaudeSubscription({ version: "0.0.0-test", query, env: {}, cwd: () => "/work" });
  t.after(() => subscription.closeSessions());
  const model = subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  const context = normalizeContext({ systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: TOOLS });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await subscription.provider.streamSimple(model, context, { signal: controller.signal }).result()).stopReason, "aborted");

  // Pi's session ends while the request is still being set up.
  const late = subscription.provider.streamSimple(model, context);
  subscription.closeSessions();
  const answer = await late.result();
  assert.equal(answer.stopReason, "error");
  assert.match(answer.errorMessage ?? "", /session ended/);
  assert.equal(spawned.length, 0);
  assert.equal(subscription.openSessions, 0);
});

test("an abort while Pi runs the tools leaves the paused turn for the next request", async t => {
  let held: CallToolResult | undefined;
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [{ id: "toolu_1", name: "mcp__pi__bash", input: { command: "make" } }], [first.uuid]);
    const [result, next] = await Promise.all([claude.call("toolu_1", "bash", { command: "make" }), claude.user()]);
    held = result;
    claude.text("msg_2", `noted: ${textOf(next)}`, { uuids: [next.uuid] });
    claude.result([first.uuid, next.uuid]);
  });
  const controller = new AbortController();
  h.user("Run make");
  const called = await h.ask({ signal: controller.signal });
  // Pi stops its tool and records what came of it; no request is in flight for the provider to hear.
  controller.abort();
  h.messages.push({ role: "toolResult", toolCallId: "toolu_1", toolName: "bash", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: 1 });
  assert.equal(called.message.stopReason, "toolUse");
  h.user("Stop, use ninja instead");
  assert.equal((await h.ask()).text, "noted: Stop, use ninja instead");
  assert.deepEqual(held, { content: [{ type: "text", text: "Operation aborted" }], isError: true });
  assert.equal(h.spawned.length, 1, "the conversation carries on in the same process");
});

test("a Claude Code that goes silent fails the request after Pi's idle limit", async t => {
  const h = harness(t, async claude => {
    await claude.user();
    claude.partial("msg_1", "starting");
  });
  h.user("hi");
  const { message } = await h.ask({ timeoutMs: 30 });
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /timed out: Claude Code sent nothing/);
  assert.equal(h.spawned[0].closed, true);
});

test("the process gets Pi's provider-scoped environment, and not another Claude Code session's identity", async t => {
  const { query, spawned } = fakeQuery(async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  const subscription = new ClaudeSubscription({
    version: "0.0.0-test", query, cwd: () => "/work",
    env: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_MESSAGING_SOCKET: "/run/parent.sock", CLAUDE_CONFIG_DIR: "/home/me/.claude" },
  });
  t.after(() => subscription.closeSessions());
  const model = subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  await subscription.provider.streamSimple(
    model, normalizeContext({ systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: TOOLS }),
    { env: { CLAUDE_CODE_OAUTH_TOKEN: "from-pi-login", ANTHROPIC_API_KEY: "sk-scoped" } },
  ).result();
  const env = spawned[0].options.env ?? {};
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "from-pi-login");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/me/.claude");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "a scoped value cannot bring per-token routing back");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_MESSAGING_SOCKET, undefined);
});

test("each turn's usage is counted once, and the model's limits become Claude Code's", async t => {
  const usage = (input: number, output: number, cost: number) => ({
    inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
    costUSD: cost, contextWindow: 200_000, maxOutputTokens: 64_000,
  });
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "one", { uuids: [first.uuid] });
    claude.result([first.uuid], { modelUsage: { "claude-opus-4-6": usage(100, 10, 0.5) }, fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required" });
    const second = await claude.user();
    claude.text("msg_2", "two", { uuids: [second.uuid] });
    // Claude Code reports totals for the whole process.
    claude.result([second.uuid], { modelUsage: { "claude-opus-4-6": usage(250, 30, 1.25) } });
  });
  const model = h.subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-4-6")!;
  assert.equal(model.contextWindow, 1_000_000, "Pi's catalog describes the API");
  h.user("one");
  await h.ask({ reasoning: "high" }, "claude-opus-4-6");
  h.user("two");
  await h.ask({ reasoning: "high" }, "claude-opus-4-6");
  assert.deepEqual(h.subscription.spend, {
    costUsd: 1.25, turns: 2,
    models: { "claude-opus-4-6": { input: 250, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: 1.25 } },
  });
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 64_000);
  assert.deepEqual(h.subscription.fastMode, { state: "off", reason: "sdk_opt_in_required" });
});

/** A restart: a second provider over the same record store, and Claude Code's own copy of each session. */
async function restartable(t: TestContext) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SessionStore } = await import("../extensions/claude-subscription/src/resume.js");
  const directory = mkdtempSync(join(tmpdir(), "claude-subscription-resume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  /** What Claude Code would have on disk, by session id: the chain of messages it reported. */
  const disk = new Map<string, { type: string; uuid: string; message: unknown }[]>();
  const start = (...scripts: (Script | undefined)[]) => {
    const { query, spawned } = fakeQuery(...scripts);
    const subscription = new ClaudeSubscription({
      version: "0.0.0-test", query, env: {}, cwd: () => "/work",
      resume: {
        store: new SessionStore(directory),
        read: async () => async sessionId => (disk.get(sessionId) ?? []) as never,
      },
    });
    t.after(() => subscription.closeSessions());
    const ask = async (messages: Message[]) => {
      const model = subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
      const message = await subscription.provider.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, messages, tools: TOOLS }), { reasoning: "high" }).result();
      messages.push(message);
      return message;
    };
    return { subscription, spawned, ask };
  };
  return { disk, start };
}

test("with sessions kept, a restarted Pi continues the conversation in Claude Code's own session", async t => {
  const { disk, start } = await restartable(t);
  const messages: Message[] = [{ role: "user", content: "remember 42", timestamp: 1 }];
  const first = start(async claude => {
    const user = await claude.user();
    claude.text("msg_1", "noted", { uuids: [user.uuid] });
    claude.emit({ type: "assistant", uuid: "uuid-a1", parent_tool_use_id: null, message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "noted" }] } });
    claude.result([user.uuid]);
  });
  await first.ask(messages);
  const [original] = first.spawned;
  assert.equal(original.options.persistSession, true);
  assert.equal(typeof original.options.sessionId, "string");
  assert.equal(original.options.resume, undefined);
  disk.set(original.options.sessionId!, [
    { type: "user", uuid: "uuid-u1", message: { role: "user", content: "remember 42" } },
    { type: "assistant", uuid: "uuid-a1", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } },
  ]);
  first.subscription.closeSessions();

  const second = start(async claude => {
    const user = await claude.user();
    claude.text("msg_2", "42", { uuids: [user.uuid] });
    claude.result([user.uuid]);
  });
  messages.push({ role: "user", content: "what was it?", timestamp: 2 });
  assert.equal((await second.ask(messages)).stopReason, "stop");
  const [resumed] = second.spawned;
  assert.equal(resumed.options.resume, original.options.sessionId);
  assert.equal(resumed.options.sessionId, undefined);
  assert.deepEqual(resumed.received.map(textOf), ["what was it?"], "only the new input is sent; the history is Claude Code's own");
});

test("a kept session that no longer matches is not trusted: the conversation is replayed from Pi's transcript", async t => {
  const { disk, start } = await restartable(t);
  const reply: Script = async claude => {
    const user = await claude.user();
    claude.text(`msg_${claude.options.sessionId ?? "resumed"}`, "ok", { uuids: [user.uuid] });
    claude.emit({ type: "assistant", uuid: "uuid-a1", parent_tool_use_id: null, message: { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }] } });
    claude.result([user.uuid]);
  };
  const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }];
  const first = start(reply);
  await first.ask(messages);
  const sessionId = first.spawned[0].options.sessionId!;
  first.subscription.closeSessions();

  // Claude Code's copy went on after the record was written (another process, an interruption): its end is elsewhere.
  disk.set(sessionId, [
    { type: "user", uuid: "uuid-u1", message: { role: "user", content: "one" } },
    { type: "assistant", uuid: "uuid-a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", uuid: "uuid-u2", message: { role: "user", content: "something Pi never saw" } },
  ]);
  const second = start(reply);
  messages.push({ role: "user", content: "two", timestamp: 2 });
  await second.ask(messages);
  assert.equal(second.spawned[0].options.resume, undefined);
  assert.match(textOf(second.spawned[0].received[0]), /<history:[0-9a-f]{8}>[\s\S]*one[\s\S]*two$/);

  // Its copy is as recorded, but Claude Code refuses the session when asked to resume it.
  disk.set(sessionId, disk.get(sessionId)!.slice(0, 2));
  const third = start(async claude => {
    claude.initializationResult = async () => { throw new Error("No conversation found with session ID"); };
  }, reply);
  const again: Message[] = [messages[0], messages[1], { role: "user", content: "three", timestamp: 3 }];
  assert.equal((await third.ask(again)).stopReason, "stop");
  assert.equal(third.spawned[0].options.resume, sessionId);
  assert.equal(third.spawned[0].closed, true);
  assert.equal(third.spawned[1].options.resume, undefined, "a refusal falls back without the user seeing an error");
});

test("nothing is kept on disk unless the user asked for it, and one-off requests are never kept", async t => {
  const reply: Script = async claude => {
    const user = await claude.user();
    claude.text("msg", "ok", { uuids: [user.uuid] });
    claude.result([user.uuid]);
  };
  const h = harness(t, reply);
  h.user("hi");
  await h.ask();
  assert.equal(h.spawned[0].options.persistSession, false);
  assert.equal(h.spawned[0].options.sessionId, undefined);

  const { start } = await restartable(t);
  const kept = start(reply);
  const model = kept.subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  await kept.subscription.provider.streamSimple(model, normalizeContext({ systemPrompt: "Summarise.", messages: [{ role: "user", content: "text", timestamp: 1 }], tools: [] }), { reasoning: "high" }).result();
  assert.equal(kept.spawned[0].options.persistSession, false, "a summary is not a conversation to come back to");
});

test("a session that never takes up a changed tool list is not carried on with the old one", async t => {
  const h = harness(t, async claude => {
    claude.ignoresToolChanges = true;
    const first = await claude.user();
    await claude.tools();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  h.user("hello");
  await h.ask();
  h.setTools([TOOLS[0]]);
  h.user("now without bash");
  const { message } = await h.ask();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /did not take up the changed tool list/);
  assert.equal(h.spawned[0].closed, true, "the next request starts a process that has the right tools");
  assert.deepEqual(h.spawned[0].received.map(textOf), ["hello"], "nothing was sent to a session with the wrong tools");
});

test("a call is given to the Pi tool it names, and a call Claude Code will refuse is not given to Pi at all", async t => {
  const dotted: Tool = { name: "read.file", description: "Read (dotted)", parameters: Type.Object({}) };
  const plain: Tool = { name: "read_file", description: "Read (plain)", parameters: Type.Object({}) };
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
    const second = await claude.user();
    claude.toolUse("msg_2", [
      // A tool registered after the session started has no alias in Claude Code, which refuses its bare name.
      { id: "toolu_1", name: "read_file", input: {} },
      // The wire name the dotted tool was given at the start still means the dotted tool.
      { id: "toolu_2", name: "mcp__pi__read_file", input: {} },
      { id: "toolu_3", name: "mcp__pi__no_such_tool", input: {} },
    ], [second.uuid]);
  });
  h.setTools([dotted]);
  h.user("hello");
  await h.ask();
  assert.deepEqual(h.spawned[0].options.toolAliases, { "read.file": "mcp__pi__read_file" });
  h.setTools([dotted, plain]);
  h.user("read");
  const { message, events } = await h.ask();
  assert.deepEqual(message.content, [{ type: "toolCall", id: "toolu_2", name: "read.file", arguments: {} }]);
  assert.equal(events.filter(event => event.type === "toolcall_start").length, 1, "the refused calls never reach Pi's stream");
  const tools = await h.spawned[0].tools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["read_file", tools.find(tool => tool.name !== "read_file")!.name].sort());
  assert.deepEqual(await h.spawned[0].call("toolu_3", "no_such_tool", {}), { content: [{ type: "text", text: "The tool no_such_tool is not available now." }], isError: true });
});

test("a turn whose only tool call is one Claude Code refuses carries on to the model's next message", async t => {
  const h = harness(t, async claude => {
    const first = await claude.user();
    claude.toolUse("msg_1", [{ id: "toolu_1", name: "mcp__pi__gone", input: {} }], [first.uuid]);
    // Claude Code tells the model there is no such tool, and the model answers in text.
    claude.text("msg_2", "I can't do that here.");
    claude.result([first.uuid]);
  });
  h.user("use the gone tool");
  const { message, text } = await h.ask();
  assert.equal(message.stopReason, "stop");
  assert.equal(text, "I can't do that here.");
  assert.deepEqual(message.content.map(block => block.type), ["text"]);
});

test("every tool Pi has registered gets its alias at the start, since Claude Code takes them only once", async t => {
  const { query, spawned } = fakeQuery(async claude => {
    const first = await claude.user();
    claude.text("msg_1", "ok", { uuids: [first.uuid] });
    claude.result([first.uuid]);
  });
  const subscription = new ClaudeSubscription({ version: "0.0.0-test", query, env: {}, cwd: () => "/work", knownTools: () => ["read", "bash", "grep", "todo.add"] });
  t.after(() => subscription.closeSessions());
  const model = subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  await subscription.provider.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: TOOLS })).result();
  assert.deepEqual(spawned[0].options.toolAliases, {
    read: "mcp__pi__read", bash: "mcp__pi__bash", grep: "mcp__pi__grep", "todo.add": "mcp__pi__todo_add",
  });
  assert.deepEqual((await spawned[0].tools()).map(tool => tool.name), ["read", "bash"], "only the active tools are offered");
});

test("a kept session that is slow to start does not hold up an abort or outlive Pi's session", async t => {
  const { disk, start } = await restartable(t);
  const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }];
  const first = start(async claude => {
    const user = await claude.user();
    claude.text("msg_1", "ok", { uuids: [user.uuid] });
    claude.emit({ type: "assistant", uuid: "uuid-a1", parent_tool_use_id: null, message: { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }] } });
    claude.result([user.uuid]);
  });
  await first.ask(messages);
  disk.set(first.spawned[0].options.sessionId!, [
    { type: "user", uuid: "uuid-u1", message: { role: "user", content: "one" } },
    { type: "assistant", uuid: "uuid-a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);
  first.subscription.closeSessions();
  messages.push({ role: "user", content: "two", timestamp: 2 });
  const never: Script = async claude => {
    claude.initializationResult = () => new Promise(() => {});
  };

  const aborted = start(never);
  const model = aborted.subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  const context = normalizeContext({ systemPrompt: SYSTEM, messages, tools: TOOLS });
  const controller = new AbortController();
  const stream = aborted.subscription.provider.streamSimple(model, context, { reasoning: "high", signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborted.spawned.length, 1);
  controller.abort();
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(aborted.spawned[0].closed, true);
  assert.equal(aborted.subscription.openSessions, 0);

  const closed = start(never);
  const late = closed.subscription.provider.streamSimple(model, context, { reasoning: "high" });
  await new Promise(resolve => setTimeout(resolve, 20));
  closed.subscription.closeSessions();
  assert.match((await late.result()).errorMessage ?? "", /session ended/);
  assert.equal(closed.spawned[0].closed, true);
  assert.equal(closed.subscription.openSessions, 0);
});

test("a resumed session counts on from the totals kept with it, and takes the model's limits from its first turn", async t => {
  const { disk, start } = await restartable(t);
  const usage = (input: number, cost: number) => ({
    inputTokens: input, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
    costUSD: cost, contextWindow: 200_000, maxOutputTokens: 32_000,
  });
  const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }];
  const first = start(async claude => {
    const user = await claude.user();
    claude.text("msg_1", "ok", { uuids: [user.uuid] });
    claude.emit({ type: "assistant", uuid: "uuid-a1", parent_tool_use_id: null, message: { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }] } });
    claude.result([user.uuid], { modelUsage: { "claude-opus-5-5": usage(100, 1) } });
  });
  await first.ask(messages);
  disk.set(first.spawned[0].options.sessionId!, [
    { type: "user", uuid: "uuid-u1", message: { role: "user", content: "one" } },
    { type: "assistant", uuid: "uuid-a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);
  // The record is written as the response settles; give the write its turn before "restarting".
  await new Promise(resolve => setTimeout(resolve, 50));
  first.subscription.closeSessions();

  const second = start(async claude => {
    const user = await claude.user();
    claude.text("msg_2", "ok", { uuids: [user.uuid] });
    // Claude Code reports totals for the whole session, the first Pi process's turn included.
    claude.result([user.uuid], { modelUsage: { "claude-opus-5-5": usage(250, 2.5) } });
  });
  messages.push({ role: "user", content: "two", timestamp: 2 });
  await second.ask(messages);
  assert.equal(second.spawned[0].options.resume, first.spawned[0].options.sessionId);
  assert.deepEqual(second.subscription.spend, {
    costUsd: 1.5, turns: 1, models: { "claude-opus-5-5": { input: 150, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 } },
  }, "only this process's turn is counted");
  const model = second.subscription.provider.getModels().find(candidate => candidate.id === "claude-opus-5-5")!;
  assert.deepEqual([model.contextWindow, model.maxTokens], [200_000, 32_000]);
});
