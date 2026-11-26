import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { getCurrentTools, isModelType } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ToolExposure } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/antigravity-provider/index.js";

async function native(t: TestContext, options: { block?: boolean; inactive?: boolean; tools?: string[]; hideDirect?: boolean; ui?: boolean | "throws"; t3?: boolean;
  wrapperFixtures?: boolean; blockTools?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-native-agy-"));
  const logPath = join(cwd, "wire");
  const agy = join(cwd, "agy");
  writeFileSync(agy, `#!/bin/sh\nexec '${process.execPath}' --import '${import.meta.resolve("tsx")}' '${fileURLToPath(new URL("support/agy.ts", import.meta.url))}' "$@"\n`, { mode: 0o700 });
  const keys = { PI_ANTIGRAVITY_AGY: agy, FAKE_LOG: logPath, PI_OFFLINE: "1", GEMINI_API_KEY: "fake", GOOGLE_API_KEY: "fake",
    T3_MCP_URL: options.t3 ? "http://127.0.0.1:1/mcp" : undefined };
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  setEnv(keys);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  let api!: ExtensionAPI;
  const executions: string[] = [];
  const selections: [string, string[]][] = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      api = pi;
      extension(pi);
      for (const [name, exposure] of [["fixture_direct", "direct"], ["fixture_deferred", "deferred"]] as const) pi.registerTool({
        name, exposure, label: name, description: "Fake Pi extension tool", parameters: Type.Object({ value: Type.String() }),
        prepareLoadout: name === "fixture_direct" && options.hideDirect ? () => ({ hiddenDeclarations: [name] }) : undefined,
        async execute(_id, { value }) {
          executions.push(`${name}:${value}`);
          return { content: [{ type: "text", text: `Pi result: ${value}` }], details: undefined };
        },
      });
      // Harmless stand-ins for T3 actions and for tools the wrapper must not reach.
      const harmless = <T extends TSchema>(name: string, exposure: ToolExposure, parameters: T) => pi.registerTool({
        name, exposure, label: name, description: `Harmless ${name} fixture`, parameters,
        async execute(_id, args) {
          executions.push(`${name}:${JSON.stringify(args)}`);
          return { content: [{ type: "text", text: `Fixture ${name} ran` }], details: undefined };
        },
      });
      if (options.wrapperFixtures) {
        harmless("mcp__t3-code__delegate_task", "direct", Type.Object({ task: Type.String() }));
        harmless("mcp__t3-code__schedule_task", "deferred", Type.Object({ prompt: Type.String() }));
        harmless("fixture_ping", "direct", Type.Object({}));
        harmless("fixture_model", "model-only", Type.Object({}));
        harmless("fixture_hidden", "hidden", Type.Object({}));
      }
      if (options.blockTools) pi.on("tool_call", event => options.blockTools!.includes(event.toolName)
        ? { block: true, reason: `Pi blocked ${event.toolName}` } : undefined);
      if (options.block) pi.on("tool_call", event => event.toolName === "antigravity" && event.input.kind === "execute"
        ? { block: true, reason: "Pi blocked this command" } : undefined);
    }],
  });
  t.after(() => {
    setEnv(previous);
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, tools: options.tools ?? (options.inactive ? ["read"] : undefined),
    settingsManager: settings, sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    rmSync(cwd, { force: true, recursive: true });
  });
  await session.bindExtensions(options.ui ? { uiContext: { select: async (question, choices) => {
    selections.push([question, choices]);
    if (options.ui === "throws") throw new Error("Pi selector threw");
    return choices[1];
  } } as NonNullable<Parameters<typeof session.bindExtensions>[0]["uiContext"]> } : {});
  const model = session.modelRuntime.getAllModels("antigravity").find(model => model.id === "gemini-3.8-flash");
  assert.ok(model && isModelType(model, "chat"));
  await session.setModel(model);
  const declarations: string[][] = [];
  const original = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, opts) => {
    declarations.push(getCurrentTools(context.messages).map(tool => tool.name));
    return original(model, context, opts);
  };
  const log = (kind: string): any[] => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [])
    .flatMap(line => { const row = JSON.parse(line); return row.kind === kind ? [row.value] : []; });
  const messages = () => session.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
  const calls = () => messages().flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : []);
  const results = () => messages().filter(message => message.role === "toolResult");
  return { session, cwd, executions, selections, declarations, calls, results, messages, log, api };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(20);
  assert.ok(predicate(), "condition did not settle");
}

test("native Pi shows the default agent's parallel tools, output and edit diff; the stand-in is never declared", { timeout: 10_000 }, async t => {
  const h = await native(t);
  await h.session.prompt("builtins");
  assert.deepEqual(h.log("spawn")[0], { args: ["acp"], cwd: h.cwd, keys: [], pid: h.log("spawn")[0].pid });
  assert.equal(h.log("new")[0].cwd, h.cwd);
  assert.deepEqual(h.log("initialize")[0].clientInfo, { name: "pi", title: "Pi", version: "0.1.0" });
  const { fs, terminal } = h.log("initialize")[0].clientCapabilities;
  assert.deepEqual({ fs, terminal }, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.ok(h.declarations.length && h.declarations.every(names => !names.includes("antigravity")));
  assert.deepEqual(h.calls().map(call => [call.name, call.arguments.kind]), [["antigravity", "read"], ["antigravity", "execute"], ["antigravity", "edit"]]);
  assert.equal(h.messages().filter(message => message.role === "assistant" && message.stopReason === "toolUse").length, 1);
  assert.deepEqual(h.results().map(result => result.isError), [false, false, false]);
  assert.match(JSON.stringify(h.results()), /read output.*command output/s);
  assert.match(JSON.stringify(h.results().at(-1)?.details), /old line.*new line/);
  assert.deepEqual(h.log("permission").map(p => p.outcome.optionId), ["allow", "allow"]);
  const last = h.messages().at(-1);
  assert.ok(last?.role === "assistant");
  assert.deepEqual(last.content, [{ type: "thinking", thinking: "considering" }, { type: "text", text: "hello" }]);
});

test("a Pi preflight block rejects one permission without deadlocking a sibling card", { timeout: 10_000 }, async t => {
  const h = await native(t, { block: true });
  await h.session.prompt("builtins");
  assert.deepEqual(h.log("permission").map(p => p.outcome.optionId), ["deny", "allow"]);
  assert.match(JSON.stringify(h.results()), /Pi blocked this command/);
  assert.equal(h.results().at(-1)?.isError, false);
});

test("native Pi selects a question answer and runs direct and deferred tools over MCP", { timeout: 10_000 }, async t => {
  const h = await native(t, { ui: true });
  await h.session.prompt("question and mcp");
  assert.deepEqual(h.selections, [["Which label should be used?", ["Verified", "Needs review"]]]);
  assert.deepEqual(h.log("permission").map(p => p.outcome.optionId), ["2", "allow", "allow"]);
  assert.deepEqual(h.calls().map(call => call.name), ["antigravity", "fixture_direct", "antigravity"]);
  assert.deepEqual(h.executions, ["fixture_direct:direct", "fixture_deferred:deferred"]);
  assert.match(JSON.stringify(h.log("result")), /Pi result: direct.*Pi result: deferred/s);
});

for (const [work, name, option] of [["permission", "antigravity", "allow"], ["question", "antigravity", "2"], ["mcp", "fixture_direct", "allow"]]) {
  test(`new ${work} releases a standing Antigravity card`, { timeout: 4_000 }, async t => {
    const h = await native(t, { ui: true });
    await h.session.prompt(`interleave-${work}`);
    const batches = h.messages().flatMap(message => message.role === "assistant" && message.stopReason === "toolUse"
      ? [message.content.flatMap(block => block.type === "toolCall" ? [block.name] : [])] : []);
    assert.deepEqual(batches, [["antigravity"], [name]]);
    assert.match(JSON.stringify(h.results()[0]?.content), /Still running in Antigravity/);
    assert.deepEqual(h.log("permission").map(row => row.outcome.optionId), ["allow", option]);
    if (work === "question") assert.equal(h.selections.length, 1);
    if (work === "mcp") assert.match(JSON.stringify(h.log("result")), /Pi result: interleaved/);
    assert.doesNotMatch(JSON.stringify(h.results()), /first late output/);
    assert.match(JSON.stringify(h.messages().at(-1)), /first late output/);
  });
}

test("inactive stand-in renders fallback text and denies permissions", { timeout: 10_000 }, async t => {
  const h = await native(t, { inactive: true });
  await h.session.prompt("builtins");
  assert.deepEqual(h.calls(), []);
  assert.deepEqual(h.log("permission").map(p => p.outcome.optionId), ["deny", "deny"]);
  const transcript = JSON.stringify(h.messages());
  assert.match(transcript, /stand-in.*not active/);
  assert.match(transcript, /read output/);
});

for (const hideDirect of [false, true]) {
  test(`an active Pi extension tool remains callable over MCP without the stand-in${hideDirect ? " or a declaration" : ""}`, { timeout: 4_000 }, async t => {
    const h = await native(t, { tools: ["fixture_direct"], hideDirect });
    await h.session.prompt("mcp-active");
    assert.deepEqual(h.declarations[0], hideDirect ? [] : ["fixture_direct"]);
    assert.deepEqual(h.log("tools")[0].map((tool: { name: string }) => tool.name), ["fixture_direct", "call_pi_tool", "await_tool_result"]);
    assert.deepEqual(h.calls().map(call => call.name), ["fixture_direct"]);
    assert.deepEqual(h.log("permission").map(row => row.outcome.optionId), ["allow"]);
    assert.match(JSON.stringify(h.log("result")), /Pi result: active/);
  });
}

test("an empty Pi allowlist uses persistent text fallback, not the summary path", { timeout: 4_000 }, async t => {
  const h = await native(t, { tools: [] });
  await h.session.prompt("builtins");
  await h.session.prompt("after fallback");
  assert.deepEqual(h.declarations, [[], []]);
  assert.deepEqual(h.log("tools")[0].map((tool: { name: string }) => tool.name), ["await_tool_result"], "no wrapper without a callable target");
  assert.deepEqual(h.calls(), []);
  assert.deepEqual(h.log("permission").map(row => row.outcome.optionId), ["deny", "deny"]);
  assert.match(JSON.stringify(h.messages()), /stand-in.*not active.*read output/s);
  assert.equal(h.log("spawn").length, 1);
  assert.equal(h.log("prompt").length, 2);
});

test("a detached command requesting permission gets a fresh Pi card", { timeout: 4_000 }, async t => {
  const h = await native(t);
  await h.session.prompt("start detached command");
  assert.match(JSON.stringify(h.results()[0]?.content), /Still running in Antigravity/);
  await h.session.prompt("request detached permission");
  assert.deepEqual(h.calls().map(call => call.arguments.title), ["Background command", "Background command"]);
  assert.notEqual(h.calls()[0].id, h.calls()[1].id);
  assert.deepEqual(h.log("permission").map(row => row.outcome.optionId), ["allow"]);
  assert.match(JSON.stringify(h.results()[1]?.content), /background command output/);
  assert.equal(h.log("spawn").length, 1);
});

test("an exception in a stand-in cancels only its question", { timeout: 4_000 }, async t => {
  const h = await native(t, { ui: "throws" });
  await h.session.prompt("question and mcp");
  assert.equal(h.results()[0]?.isError, true);
  assert.match(JSON.stringify(h.results()[0]?.content), /Pi selector threw/);
  assert.deepEqual(h.log("permission").map(row => row.outcome.optionId ?? row.outcome.outcome), ["cancelled", "allow", "allow"]);
  assert.deepEqual(h.log("cancel"), []);
  assert.deepEqual(h.executions, ["fixture_direct:direct", "fixture_deferred:deferred"]);
});

test("one host wake drains background work without another ACP prompt", { timeout: 10_000 }, async t => {
  const h = await native(t);
  await h.session.prompt("wake");
  await until(() => h.messages().some(message => message.role === "assistant" && JSON.stringify(message.content).includes("awake from agy")));
  assert.equal(h.log("prompt").length, 1);
  assert.equal(h.calls().length, 1);
  assert.match(JSON.stringify(h.results()), /Still running in Antigravity/);
  assert.match(JSON.stringify(h.messages().at(-1)), /background output/);
  assert.ok(h.session.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "antigravity-wake"));
});

test("native abort cancels the ACP prompt, reuses the process, and reports a later crash", { timeout: 10_000 }, async t => {
  const h = await native(t);
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") void h.session.abort();
  });
  await h.session.prompt("abort");
  unsubscribe();
  await until(() => h.log("cancel").length === 1);
  assert.match(JSON.stringify(h.messages().at(-1)), /"stopReason":"aborted"/);
  await h.session.prompt("after abort");
  assert.equal(h.log("new").length, 1);
  await h.session.prompt("crash");
  const last = h.messages().at(-1);
  assert.ok(last?.role === "assistant");
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /fake agy crash|exited/);
});

test("aborting during a stand-in keeps the ACP process for the next prompt", { timeout: 6_000 }, async t => {
  const h = await native(t);
  const running = h.session.prompt("abort-card");
  await until(() => h.log("permission")[0]?.outcome.optionId === "allow");
  await h.session.abort();
  await running;
  await until(() => h.log("cancel").length === 1);
  assert.equal(h.results()[0]?.toolCallId, h.calls()[0].id);
  assert.equal(h.results()[0]?.isError, true);
  await h.session.prompt("after abort");
  assert.equal(h.log("spawn").length, 1);
  assert.equal(h.log("new").length, 1);
  assert.deepEqual(h.log("prompt")[1], [{ type: "text", text: "after abort" }]);
});

test("native nonextending transcript replays a short tool record and does not reuse ACP ids", { timeout: 10_000 }, async t => {
  const h = await native(t);
  await h.session.prompt("builtins");
  const prior = h.calls().map(call => call.id);
  const original = h.session.agent.streamFunction;
  h.session.agent.streamFunction = (model, context, opts) => {
    const index = context.messages.findIndex(message => message.role === "user");
    const messages = [...context.messages];
    messages[index] = { role: "user", content: "an edited first user turn", timestamp: 1 };
    return original(model, { ...context, messages }, opts);
  };
  await h.session.prompt("replay");
  assert.equal(h.log("new").length, 2);
  assert.match(JSON.stringify(h.log("prompt")[1]), /edited first user turn.*\[Antigravity ran Read x: read output\]/s);
  h.session.agent.streamFunction = original;
  await h.session.prompt("builtins");
  assert.equal(h.calls().length, 6);
  assert.ok(h.calls().slice(3).every(call => !prior.includes(call.id)));
});

test("native tool-choice none does not dispatch a stand-in, even with an active UI and tool loadout", { timeout: 10_000 }, async t => {
  const h = await native(t, { ui: true });
  const original = h.session.agent.streamFunction;
  h.session.agent.streamFunction = (model, context, opts) => original(model, context, { ...opts, toolChoice: "none" });
  await h.session.prompt("question");
  assert.deepEqual(h.log("new")[0].mcpServers, []);
  assert.equal(h.log("permission")[0].outcome.outcome, "cancelled");
  assert.deepEqual(h.calls(), []);
  assert.deepEqual(h.selections, []);
  await until(() => h.log("close").length === 1);
});

test("tool-list changes notify agy, and stale calls name currently available tools", { timeout: 10_000 }, async t => {
  const h = await native(t);
  await h.session.prompt("hello");
  assert.deepEqual(h.log("tools")[0].map((tool: { name: string }) => tool.name), ["fixture_direct", "fixture_deferred", "call_pi_tool", "await_tool_result"]);
  h.api.setActiveTools(h.api.getActiveTools().filter(name => name !== "fixture_direct"));
  await until(() => h.log("toolsChanged").length > 0);
  assert.deepEqual(h.log("toolsChanged").at(-1).map((tool: { name: string }) => tool.name), ["fixture_deferred", "call_pi_tool", "await_tool_result"]);
  await h.session.prompt("mcp-missing");
  assert.equal(h.log("new").length, 1);
  assert.equal(h.log("result")[0].isError, true);
  assert.match(h.log("result")[0].content[0].text, /Unavailable Pi tool fixture_direct.*fixture_deferred/);
  await h.session.prompt(`wrapper ${JSON.stringify([{ name: "fixture_direct", args: JSON.stringify({ value: "removed" }) }])}`);
  assert.equal(h.log("result")[1].isError, true);
  assert.match(h.log("result")[1].content[0].text, /Unavailable Pi tool fixture_direct/);
  assert.deepEqual(h.executions, []);
});

const wrapperCall = (name: unknown, args?: unknown) => ({ name, ...(args === undefined ? {} : { args }) });

test("call_pi_tool reaches T3 tools whose declarations agy left out, describing before it runs them", { timeout: 10_000 }, async t => {
  const h = await native(t, { t3: true, wrapperFixtures: true });
  await h.session.prompt(`wrapper ${JSON.stringify([
    wrapperCall("delegate_task"),
    wrapperCall("delegate_task", JSON.stringify({ task: "harmless" })),
    wrapperCall("mcp__t3-code__schedule_task", JSON.stringify({ prompt: "harmless" })),
    wrapperCall("fixture_ping", "{}"),
  ])}`);
  const listed: { name: string }[] = h.log("tools")[0];
  const wrapper = listed.find(tool => tool.name === "call_pi_tool");
  assert.ok(wrapper && listed.some(tool => tool.name === "mcp__t3-code__delegate_task"));
  assert.ok(Buffer.byteLength(JSON.stringify(wrapper)) <= 500, `wrapper declaration is ${Buffer.byteLength(JSON.stringify(wrapper))} bytes`);
  const [described, ...ran] = h.log("result");
  assert.equal(Boolean(described.isError), false);
  assert.match(described.content[0].text, /mcp__t3-code__delegate_task[\s\S]*"task"/);
  assert.deepEqual(ran.map(result => [Boolean(result.isError), result.content[0].text]), [
    [false, "Fixture mcp__t3-code__delegate_task ran"], [false, "Fixture mcp__t3-code__schedule_task ran"], [false, "Fixture fixture_ping ran"]]);
  assert.deepEqual(h.executions, ['mcp__t3-code__delegate_task:{"task":"harmless"}', 'mcp__t3-code__schedule_task:{"prompt":"harmless"}', "fixture_ping:{}"]);
  assert.deepEqual(h.calls().map(call => [call.name, call.arguments]), [
    ["mcp__t3-code__delegate_task", { task: "harmless" }],
    ["antigravity", { title: "Pi: mcp__t3-code__schedule_task", kind: "pi_tool", input: { name: "mcp__t3-code__schedule_task", arguments: { prompt: "harmless" } } }],
    ["fixture_ping", {}],
  ]);
  assert.deepEqual(h.log("permission").map(row => row.outcome.optionId), ["allow", "allow", "allow", "allow"]);
});

test("call_pi_tool keeps Pi's preflight and rejects calls outside the exposed loadout without running them", { timeout: 10_000 }, async t => {
  const h = await native(t, { wrapperFixtures: true, blockTools: ["mcp__t3-code__delegate_task"] });
  const rejected = [
    wrapperCall("delegate_task", "{}"), wrapperCall("read", "{}"), wrapperCall("call_pi_tool", "{}"), wrapperCall("await_tool_result", "{}"),
    wrapperCall("fixture_model", "{}"), wrapperCall("fixture_hidden", "{}"), wrapperCall("antigravity", "{}"), wrapperCall(42, "{}"),
    wrapperCall("mcp__t3-code__schedule_task", "[1]"), wrapperCall("mcp__t3-code__schedule_task", "null"),
    wrapperCall("mcp__t3-code__schedule_task", "not json"), wrapperCall("mcp__t3-code__schedule_task", { prompt: "object" }),
  ];
  await h.session.prompt(`wrapper ${JSON.stringify([wrapperCall("mcp__t3-code__delegate_task", JSON.stringify({ task: "blocked" })), ...rejected])}`);
  const [blocked, ...others] = h.log("result");
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /Pi blocked mcp__t3-code__delegate_task/);
  assert.equal(others.length, rejected.length);
  assert.ok(others.every(result => result.isError), JSON.stringify(others));
  assert.deepEqual(others.map(result => /Unavailable Pi tool|requires the name|args must be a string holding a JSON object/.exec(result.content[0].text)?.[0]), [
    ...Array(7).fill("Unavailable Pi tool"), "requires the name", ...Array(4).fill("args must be a string holding a JSON object")]);
  assert.deepEqual(h.executions, []);
  assert.deepEqual(h.calls().map(call => call.name), ["mcp__t3-code__delegate_task"]);
});

for (const t3 of [false, true]) test(`questions cancel with an honest transcript note without a UI (${t3 ? "T3" : "CLI"})`, { timeout: 10_000 }, async t => {
  const h = await native(t, { t3 });
  await h.session.prompt("question");
  assert.deepEqual(h.log("permission")[0], { outcome: { outcome: "cancelled" } });
  assert.match(JSON.stringify(h.results()), t3 ? /No interactive T3 Code UI/ : /No interactive Pi UI/);
});
