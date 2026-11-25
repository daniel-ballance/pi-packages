import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isModelType, normalizeContext, type AssistantMessage, type Message, type ModelsStoreEntry, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Antigravity, type AntigravityOptions } from "../extensions/antigravity-provider/src/provider.js";

const tools = [{ name: "fixture_direct", description: "Fixture", parameters: Type.Object({ value: Type.String() }) }];
const say = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const output = (message: AssistantMessage) => message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !predicate(); i++) await delay(12);
  assert.ok(predicate(), "condition did not settle");
}
function harness(t: TestContext, options: Partial<AntigravityOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-agy-test-"));
  const path = join(dir, "log");
  const bridge = new Antigravity({ cwd: dir, bindPi: () => ({ cwd: dir, wake: () => false,
    tools: { getActiveTools: () => ["antigravity", "fixture_direct"], getAllTools: () => tools.map(tool => ({ ...tool, exposure: "direct" })) } }), ...options,
    executable: process.execPath, executableArgs: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("support/agy.ts", import.meta.url))],
    env: { ...process.env, FAKE_LOG: path, ...options.env },
  });
  t.after(async () => { await bridge.closeSessions(); rmSync(dir, { recursive: true, force: true }); });
  const log = (kind: string): any[] => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [])
    .flatMap(line => { const row = JSON.parse(line); return row.kind === kind ? [row.value] : []; });
  const messages: Message[] = [];
  let addendum: string | undefined;
  const start = (opts: SimpleStreamOptions = {}, modelId = "gemini-4-neon", transcript = messages, offered = tools) => {
    const model = bridge.provider.getModels().find(candidate => candidate.id === modelId);
    assert.ok(model && isModelType(model, "chat"));
    const context = normalizeContext({ systemPrompt: "", messages: transcript, tools: offered });
    if (addendum) context.messages = [{ role: "system", timestamp: 1, content: "", sections: { addendum } }, ...context.messages];
    return bridge.provider.streamSimple(model, context, { sessionId: "test", ...opts });
  };
  return { bridge, messages, log, start, setAddendum(text: string) { addendum = text; },
    socket(index = 0): string { return log("new")[index].mcpServers[0].env[0].value; },
    user(text: string) { messages.push(say(text)); },
    answer(previous: AssistantMessage) {
      const call = previous.content.find(block => block.type === "toolCall");
      assert.ok(call);
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, timestamp: 1,
        content: [{ type: "text", text: "tool answer" }, { type: "image", mimeType: "image/png", data: "YQ==" }] });
    },
    async ask(opts?: SimpleStreamOptions, modelId?: string) {
      const result = await start(opts, modelId).result();
      assert.notEqual(result.stopReason, "error", result.errorMessage ?? "Unexpected error");
      messages.push(result);
      return result;
    },
  };
}

test("maps usage and preserves payload and stream hooks", async t => {
  const h = harness(t);
  h.user("hello");
  const updates: unknown[] = [];
  const result = await h.ask({ onPayload: () => ({ input: [{ type: "text", text: "changed" }] }), onProviderStreamEvent: update => { updates.push(update); } });
  assert.equal(result.stopReason, "stop");
  assert.equal(output(result), "hello");
  assert.deepEqual(result.usage, { input: 21, output: 8, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 32,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.deepEqual(h.log("prompt"), [[{ type: "text", text: "changed" }]]);
  assert.ok(updates.length >= 3);
  assert.equal(h.bridge.provider.getModels().find(model => model.id === "gemini-4-neon")?.contextWindow, 123_456);
});

test("switches family, thinking and instructions in place, but replays a nonextending transcript", async t => {
  const h = harness(t);
  h.setAddendum("first instructions");
  h.user("first");
  await h.ask({ reasoning: "high" });
  h.setAddendum("updated instructions");
  h.user("second");
  await h.ask({ reasoning: "xhigh" }, "gemini-3.8-flash");
  h.user("third");
  await h.ask({ reasoning: "low" }, "gemini-3.8-flash");
  assert.equal(h.log("new").length, 1);
  assert.match(JSON.stringify(h.log("prompt")[1]), /Pi updated these instructions.*as gemini-3\.8-flash\..*updated instructions.*second/);
  assert.doesNotMatch(JSON.stringify(h.log("prompt")[2]), /Pi updated/);
  assert.deepEqual(h.log("config").map(row => [row.configId, row.value]), [["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
  h.messages[0] = say("edited");
  h.user("continue");
  await h.ask();
  assert.equal(h.log("new").length, 2);
  assert.match(JSON.stringify(h.log("prompt")[3]), /history.*edited.*hello.*continue/);
});

test("tool-less requests use a short-lived session without MCP or tool cards", async t => {
  const h = harness(t);
  h.user("first");
  await h.ask();
  for (const mode of ["none", "summary"] as const) {
    const request = mode === "none" ? h.start({ toolChoice: "none" }, undefined, [say("builtins")])
      : h.start({ cacheRetention: "none" }, undefined, [say("question")], []);
    const result = await request.result();
    assert.equal(result.stopReason, "stop", result.errorMessage ?? "Expected stop");
    assert.equal(output(result), "hello");
    assert.ok(!result.content.some(block => block.type === "toolCall"));
  }
  assert.deepEqual(h.log("permission").map(p => p.outcome.optionId ?? p.outcome.outcome), ["deny", "deny", "cancelled"]);
  assert.deepEqual(h.log("new").slice(1).map(row => row.mcpServers), [[], []]);
  await until(() => h.log("close").length === 2);
  h.user("again");
  await h.ask();
  assert.equal(h.log("new").length, 3);
});

test("duplicate stream for the active conversation is rejected", async t => {
  const h = harness(t);
  h.user("slow");
  const first = h.start();
  const second = await h.start().result();
  assert.equal(second.stopReason, "error");
  assert.match(second.errorMessage ?? "", /already/);
  assert.equal((await first.result()).stopReason, "stop");
  assert.equal(h.log("prompt").length, 1);
});

for (const mode of ["long-retry", "long-other", "long-end"]) test(`${mode}: late tool result is not a second Pi call`, async t => {
  const h = harness(t, { toolTimeoutMs: 160 });
  h.user(mode);
  const first = await h.ask();
  assert.equal(first.stopReason, "toolUse");
  await until(() => h.log("result").some(result => JSON.stringify(result).includes("still running")));
  if (mode === "long-retry") {
    await until(() => h.log("result").filter(result => JSON.stringify(result).includes("still running")).length >= 2);
    await until(() => h.log("permission").length >= 3);
  }
  if (mode === "long-other") await until(() => h.log("permission").length >= 2);
  if (mode === "long-end") await delay(60);
  h.answer(first);
  let result = await h.ask();
  if (mode === "long-other") {
    assert.equal(result.stopReason, "toolUse");
    h.answer(result);
    result = await h.ask();
  }
  assert.equal(result.stopReason, "stop");
  assert.equal(h.log("prompt").length, mode === "long-end" ? 2 : 1);
  const delivered = mode === "long-end" ? h.log("prompt") : h.log("result");
  assert.match(JSON.stringify(delivered), /tool answer.*image/s);
  if (mode === "long-other") assert.match(JSON.stringify(delivered), /Late Pi tool result for/);
});

test("steering delivered with tool results becomes a new prompt, never part of MCP output", async t => {
  const h = harness(t);
  h.user("long-end");
  const first = await h.ask();
  assert.equal(first.stopReason, "toolUse");
  h.answer(first);
  h.user("steered");
  const response = await h.ask();
  assert.equal(output(response), "hellohello");
  assert.equal(response.usage.totalTokens, 64);
  assert.deepEqual(h.log("prompt")[1], [{ type: "text", text: "steered" }]);
  assert.doesNotMatch(JSON.stringify(h.log("result")), /steered/);
});

test("LRU and idle close spare conversations; shutdown removes sockets and children", async t => {
  let now = 1;
  const h = harness(t, { maxSessions: 2, idleMs: 100, now: () => now });
  const request = (id: string) => h.start({ sessionId: id }, undefined, [say(id)]).result();
  for (const id of ["one", "two", "three"]) { now++; assert.equal((await request(id)).stopReason, "stop"); }
  const paths = [h.socket(0), h.socket(1), h.socket(2)];
  await until(() => !existsSync(paths[0]));
  assert.ok(existsSync(paths[1]));
  now += 101;
  await request("four");
  await until(() => paths.every(path => !existsSync(path)));
  await h.bridge.closeSessions();
  assert.ok(!existsSync(h.socket(3)));
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => h.log("spawn").every(({ pid }) => !running(pid)));
  assert.equal(h.log("close").length, 4);
});

test("idle and LRU deadlines do not evict a conversation running a Pi tool", async t => {
  let now = 1;
  const h = harness(t, { maxSessions: 1, idleMs: 10, now: () => now });
  h.user("long-end");
  const first = await h.ask();
  assert.equal(first.stopReason, "toolUse");
  now += 100;
  assert.equal((await h.start({ sessionId: "other" }, undefined, [say("another thread")]).result()).stopReason, "stop");
  await until(() => !existsSync(h.socket(1)));
  assert.ok(existsSync(h.socket(0)));
  h.answer(first);
  assert.equal((await h.ask()).stopReason, "stop");
});

test("discovery respects offline mode, persists once per day, and closes its ACP process", async t => {
  let now = 10000;
  const h = harness(t, { now: () => now });
  let stored: ModelsStoreEntry | undefined;
  const refresh = (allowNetwork: boolean) => h.bridge.provider.refreshModels!({
    stored, allowNetwork, signal: new AbortController().signal,
    publish: async ({ update, persist }) => { if (persist) stored = persist; update?.(); return true; },
  });
  await refresh(false);
  assert.equal(h.log("new").length, 0);
  await refresh(true);
  assert.ok(stored?.models.some(model => model.id === "gemini-4-neon"));
  assert.equal(h.log("close").length, 1);
  assert.equal(h.log("prompt").length, 0);
  await refresh(true);
  assert.equal(h.log("new").length, 1);
  now += 24 * 60 * 60_000;
  await refresh(true);
  assert.equal(h.log("new").length, 2);
  assert.deepEqual(h.log("new").map(row => row.mcpServers), [[], []]);
});

test("unauthenticated agy reports how to sign in before sending the prompt", async t => {
  const h = harness(t, { env: { FAKE_AUTH_REQUIRED: "1" } });
  h.user("private input");
  const result = await h.start().result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /agy acp --login/);
  assert.equal(h.log("prompt").length, 0);
});
