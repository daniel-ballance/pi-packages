import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWebTools, type WebToolsHost } from "../extensions/claude-subscription/src/webtools.js";
import { assistant, call, frame, result, scriptedQuery, searchDetails, type WebScript } from "./support/webtools.js";

function setup(script: WebScript, overrides: Partial<WebToolsHost> = {}) {
  const fake = scriptedQuery(script);
  const definitions: ToolDefinition<any, unknown>[] = [];
  const rates: unknown[] = [];
  registerWebTools({ registerTool: (tool: ToolDefinition<any, unknown>) => { definitions.push(tool); } } as unknown as ExtensionAPI, {
    loadQuery: async () => fake.query, env: { SENTINEL: "subscription" }, cwd: "/tmp", onRateLimit: message => rates.push(message), ...overrides,
  });
  return { ...fake, definitions, rates,
    execute: (name = "search", args: object = { query: "example" }, signal?: AbortSignal) =>
      definitions.find(tool => tool.name === `claude_web_${name}`)!.execute("pi-call", args, signal, undefined, {} as ExtensionToolContext),
  };
}

function text(value: { content: unknown[] }) { return (value.content[0] as { text: string }).text; }

test("search allows one exact call without a prompt surface and stops at its result", async () => {
  const args = { query: "example", allowed_domains: ["example.com"], blocked_domains: ["bad.invalid"] };
  let prompt = "";
  const harness = setup(async function* (process) {
    const first = await process.prompt[Symbol.asyncIterator]().next();
    prompt = first.value!.message.content as string;
    yield* call(process, "WebSearch", { ...args, mode: "standard" });
    yield frame({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    yield result(searchDetails, "Links: example.com\nReserved for documentation.");
    assert.fail("must not wait for the follow-up");
  });
  const output = await harness.execute("search", args);
  assert.equal(output.isError, undefined);
  assert.equal(output.details, searchDetails);
  assert.match(text(output), /Reserved for documentation/);
  assert.equal(output.usage!.totalTokens, 50);
  assert.equal(output.usage!.output, 19);
  assert.equal(output.usage!.cost.total, 0);
  assert.equal(harness.rates.length, 1);
  assert.match(prompt, /Call WebSearch exactly once/);
  assert.ok(prompt.endsWith(JSON.stringify(args)));
  const process = harness.processes[0];
  assert.ok(process.closed);
  const options = process.options;
  assert.deepEqual(options.tools, ["WebSearch"]);
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, "default");
  assert.equal(options.permissionPrompts, "none");
  assert.equal(options.maxTurns, 1);
  assert.equal(options.model, "claude-haiku-5-5");
  assert.equal(options.cwd, "/tmp");
  assert.deepEqual(options.env, { SENTINEL: "subscription" });
  assert.equal(options.canUseTool, undefined);
  assert.equal(harness.definitions[0].annotations!.readOnlyHint, true);
  assert.equal(harness.definitions[0].annotations!.openWorldHint, true);
});

test("fetch returns the built-in answer and structured form", async () => {
  const args = { url: "https://example.com", prompt: "What is it for?", offset: 0 };
  const details = { url: args.url, code: 200, result: "Documentation.", bytes: 100, durationMs: 20 };
  const harness = setup(async function* (process) { yield* call(process, "WebFetch", args); yield result(details, details.result); });
  const output = await harness.execute("fetch", args);
  assert.equal(output.details, details);
  assert.equal(text(output), "Documentation.");
  assert.deepEqual(harness.processes[0].options.tools, ["WebFetch"]);
  assert.ok(harness.processes[0].closed);
});

test("text instead of the intended call fails clearly", async () => {
  const harness = setup(async function* () {
    yield frame({ type: "assistant", message: { content: [{ type: "text", text: "I already know the answer." }] } });
    yield frame({ type: "stream_event", event: { type: "message_stop" } });
  });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /without calling/);
  assert.ok(harness.processes[0].closed);
});

for (const [label, name, input] of [
  ["changed query", "WebSearch", { query: "something else" }],
  ["extra field", "WebSearch", { query: "example", other: true }],
  ["nonstandard mode", "WebSearch", { query: "example", mode: "deep" }],
  ["another tool", "Bash", { command: "pwd" }],
] as const) {
  test(`the hook denies ${label} before execution`, async () => {
    const harness = setup(async function* (process) {
      const decision = await process.permit(name, input);
      assert.equal((decision as any).hookSpecificOutput.permissionDecision, "deny");
      yield result({}, "Denied");
    });
    const output = await harness.execute();
    assert.equal(output.isError, true);
    assert.match(text(output), /different arguments/);
    assert.ok(harness.processes[0].closed);
  });
}

test("the hook denies a second call even with identical arguments", async () => {
  const harness = setup(async function* (process) {
    await process.permit("WebSearch", { query: "example" });
    const decision = await process.permit("WebSearch", { query: "example" }, "call2");
    assert.equal((decision as any).hookSpecificOutput.permissionDecision, "deny");
    yield result(searchDetails);
  });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /more than once/);
});

test("wrong arguments in the assistant frame are also rejected", async () => {
  const harness = setup(async function* () { yield assistant("WebSearch", { query: "wrong" }); });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /different arguments/);
});

test("an automatic permission denial is a failed tool result", async () => {
  const harness = setup(async function* () {
    yield frame({ type: "system", subtype: "permission_denied", tool_name: "WebFetch", message: "Domain denied by policy" });
  });
  const output = await harness.execute("fetch", { url: "https://example.com", prompt: "Summarize" });
  assert.equal(output.isError, true);
  assert.match(text(output), /denied.*Domain denied/);
  assert.ok(harness.processes[0].closed);
});

test("a built-in error is not mistaken for an answer", async () => {
  const harness = setup(async function* (process) {
    yield* call(process, "WebSearch", { query: "example" });
    yield result(undefined, "Permission denied", { is_error: true });
  });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /Permission denied/);
});

test("empty search results fail with guidance", async () => {
  const harness = setup(async function* (process) {
    yield* call(process, "WebSearch", { query: "example" });
    yield result({ results: ["Nothing found"] });
  });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /no results/);
});

test("early process exit and thrown transport errors are reported and closed", async () => {
  for (const script of [async function* () {}, async function* () { throw new Error("transport broke"); }]) {
    const harness = setup(script);
    const output = await harness.execute();
    assert.equal(output.isError, true);
    assert.match(text(output), /exited before|transport broke/);
    assert.ok(harness.processes[0].closed);
  }
});

test("abort closes a stalled process without waiting for its iterator", async () => {
  const controller = new AbortController();
  const harness = setup(async function* () {
    controller.abort();
    await new Promise(() => {});
  });
  const output = await harness.execute("search", { query: "example" }, controller.signal);
  assert.equal(output.isError, true);
  assert.match(text(output), /aborted/);
  assert.ok(harness.processes[0].closed);
  assert.ok(harness.processes[0].options.abortController!.signal.aborted);
});

test("an already aborted call does not start a process", async () => {
  const harness = setup(async function* () {});
  const output = await harness.execute("search", { query: "example" }, AbortSignal.abort());
  assert.equal(output.isError, true);
  assert.equal(harness.processes.length, 0);
});

test("the deadline covers a stalled loader as well as a stalled process", async () => {
  for (const load of [false, true]) {
    const harness = setup(async function* () { await new Promise(() => {}); }, {
      timeoutMs: 10, ...(load ? { loadQuery: () => new Promise(() => {}) } : {}),
    });
    const output = await harness.execute();
    assert.equal(output.isError, true);
    assert.match(text(output), /timed out/);
    if (!load) assert.ok(harness.processes[0].closed);
  }
});

test("authentication and plan limits explain the failure", async () => {
  const login = setup(async function* () {
    yield frame({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid credentials" }] } });
  });
  assert.match(text(await login.execute()), /not signed in.*claude auth login/);
  const limited = setup(async function* () { yield frame({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }); });
  const output = await limited.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /plan limit/);
  assert.equal(limited.rates.length, 1);
  assert.ok(limited.processes[0].closed);
});

test("unmatched result ids are never accepted", async () => {
  const harness = setup(async function* (process) {
    yield* call(process, "WebSearch", { query: "example" });
    yield result(searchDetails, "Wrong call", { tool_use_id: "unrelated" });
  });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /unverified/);
});

test("renderers show compact calls and expand search links and summary", () => {
  const harness = setup(async function* () {});
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as any;
  const tool = harness.definitions[0];
  const renderCall = tool.renderCall!({ query: "example" }, theme, {} as any);
  assert.match(renderCall.render(80).join("\n"), /claude_web_search example/);
  const output = { content: [{ type: "text" as const, text: "plain result" }], details: searchDetails };
  const collapsed = tool.renderResult!(output, { expanded: false, isPartial: false }, theme, {} as any);
  assert.match(collapsed.render(80).join("\n"), /1 result/);
  const expanded = tool.renderResult!(output, { expanded: true, isPartial: false }, theme, {} as any);
  const full = expanded.render(80).join("\n");
  assert.match(full, /https:\/\/example.com/);
  assert.match(full, /Reserved for documentation/);
  const failed = tool.renderResult!({ ...output, isError: true, content: [{ type: "text", text: "Denied" }] },
    { expanded: false, isPartial: false }, theme, {} as any);
  assert.match(failed.render(80).join("\n"), /Denied/);
  const fetch = harness.definitions[1];
  const answer = fetch.renderResult!({ content: [{ type: "text", text: "Documentation.\nMore details." }], details: {} },
    { expanded: false, isPartial: false }, theme, {} as any);
  assert.match(answer.render(80).join("\n"), /Documentation/);
  assert.doesNotMatch(answer.render(80).join("\n"), /More details/);
});

test("a final text answer is reported as a missing tool result, not accepted as content", async () => {
  const harness = setup(async function* () {
    yield frame({ type: "result", subtype: "success", is_error: false, result: "An invented answer." });
  });
  const output = await harness.execute();
  assert.equal(output.isError, true);
  assert.match(text(output), /without returning.*tool result/);
  assert.doesNotMatch(text(output), /invented answer/);
});
