import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthContext, Model, ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { baselineModels, discoveredModels, thinkingFor } from "../extensions/claude-subscription/src/models.js";
import { ClaudeSubscription } from "../extensions/claude-subscription/src/provider.js";
import { fakeQuery, type Script } from "./support/claude.js";

const reported: Script = async claude => {
  claude.models = [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "claude-next-9", displayName: "Next 9", description: "", supportsAdaptiveThinking: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
    { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "" },
    { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "" },
    { value: "experimental-router", displayName: "Router", description: "" },
  ];
  // Opus 4.6 has a 1M window on the API and in Pi's catalog, and 200k through Claude Code on this plan.
  claude.contextWindows = { "claude-opus-5-5": 1_000_000, "claude-next-9": 1_000_000, "claude-opus-4-6": 200_000 };
};

function refresh(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext & { published: ModelsPublication[] } {
  const published: ModelsPublication[] = [];
  return {
    allowNetwork: true, signal: new AbortController().signal, published,
    publish: async publication => {
      published.push(publication);
      publication.update?.();
      return true;
    },
    ...overrides,
  };
}

test("the catalog is Pi's own Claude catalog, served by this provider at no per-token cost", () => {
  const builtin = getBuiltinModels("anthropic");
  const models = baselineModels();
  assert.deepEqual(models.map(model => model.id), builtin.map(model => model.id));
  const opus = models.find(model => model.id === "claude-opus-5-5");
  const source = builtin.find(model => model.id === "claude-opus-5-5");
  assert.ok(opus && source);
  assert.deepEqual(opus, {
    id: "claude-opus-5-5", name: source.name, api: "claude-agent-sdk", provider: "claude-subscription", baseUrl: "",
    reasoning: true, thinkingLevelMap: source.thinkingLevelMap, input: source.input, inputLimits: source.inputLimits,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: source.contextWindow, maxTokens: source.maxTokens,
  });
});

test("reported models resolve aliases once; a model Pi does not know gets conservative limits", () => {
  const baseline = baselineModels();
  const models = discoveredModels([
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
    { value: "claude-next-9", displayName: "Next 9", description: "", supportedEffortLevels: ["low", "high", "max"] },
    { value: "experimental-router", displayName: "Router", description: "" },
  ], baseline);
  assert.deepEqual(models.map(model => model.id), ["claude-opus-5-5", "claude-next-9"]);
  assert.deepEqual(models[0], baseline.find(model => model.id === "claude-opus-5-5"));
  assert.notEqual(models[0], baseline.find(model => model.id === "claude-opus-5-5"), "a copy, so correcting its limits leaves Pi's catalog alone");
  assert.deepEqual(models[1], {
    id: "claude-next-9", name: "Claude Next 9", api: "claude-agent-sdk", provider: "claude-subscription", baseUrl: "",
    reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    contextWindow: 200_000, maxTokens: 32_000,
  });
});

test("thinking follows what each model accepts", () => {
  const model = (id: string): Model<string> => {
    const found = baselineModels().find(candidate => candidate.id === id);
    assert.ok(found, id);
    return found;
  };
  // Thinking cannot be switched off on Opus 5.5; without a level it runs at the effort Pi's own adapter defaults to.
  assert.deepEqual(thinkingFor(model("claude-opus-5-5"), {}), { thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
  // A level the model's map leaves out falls back the way Pi's adapter does, never to the level's own name.
  assert.deepEqual(thinkingFor(model("claude-opus-4-6"), { reasoning: "xhigh" }), { thinking: { type: "adaptive", display: "summarized" }, effort: "high" });
  assert.deepEqual(thinkingFor(model("claude-opus-4-6"), { reasoning: "max" }), { thinking: { type: "adaptive", display: "summarized" }, effort: "max" });
  assert.deepEqual(thinkingFor(model("claude-opus-5-5"), { reasoning: "xhigh" }), { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" });
  assert.deepEqual(thinkingFor(model("claude-opus-4-8"), {}), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingFor(model("claude-opus-4-8"), { reasoning: "minimal" }), { thinking: { type: "adaptive", display: "summarized" }, effort: "low" });
  assert.deepEqual(thinkingFor(model("claude-haiku-4-5"), {}), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingFor(model("claude-haiku-4-5"), { reasoning: "low", thinkingBudgets: { low: 3000 } }),
    { thinking: { type: "enabled", budgetTokens: 3000, display: "summarized" } });
});

test("a refresh asks Claude Code which models the account offers and persists the answer", async () => {
  const { query, spawned } = fakeQuery(reported);
  const subscription = new ClaudeSubscription({ version: "0.0.0-test", query, env: {} });
  const context = refresh();
  await subscription.provider.refreshModels?.(context);

  const models = subscription.provider.getModels();
  assert.deepEqual(models.map(model => [model.id, model.contextWindow]), [
    ["claude-opus-5-5", 1_000_000], ["claude-next-9", 1_000_000], ["claude-haiku-4-5", 200_000], ["claude-opus-4-6", 200_000],
  ]);
  assert.equal(baselineModels().find(model => model.id === "claude-opus-4-6")?.contextWindow, 1_000_000,
    "Pi's own figure, which would have Pi compact too late on this transport");
  assert.equal(context.published.length, 1);
  assert.deepEqual(context.published[0].persist?.models, models);
  assert.equal(typeof context.published[0].persist?.checkedAt, "number");
  assert.equal(subscription.account?.subscriptionType, "Claude Max");
  // The handshake never sends a prompt, loads no Claude Code configuration and is torn down.
  assert.deepEqual(spawned[0].received, []);
  assert.deepEqual(spawned[0].options.settingSources, []);
  assert.equal(spawned[0].closed, true);
});

test("a stored catalog is restored offline and trusted for a day", async () => {
  const { query, spawned } = fakeQuery(reported, reported);
  const subscription = new ClaudeSubscription({ version: "0.0.0-test", query, env: {} });
  const stale: Model<string> = { ...baselineModels()[0], id: "claude-opus-5-5", contextWindow: 200_000, maxTokens: 64_000, api: "stale-api" };
  const unknown: Model<string> = { ...baselineModels()[0], id: "claude-next-9", name: "Claude Next 9" };
  const stored: ModelsStoreEntry = { models: [stale, unknown, { ...stale, provider: "someone-else", id: "other" }], checkedAt: Date.now() - 60_000 };

  await subscription.provider.refreshModels?.(refresh({ stored, allowNetwork: false }));
  assert.deepEqual(subscription.provider.getModels().map(model => model.id), ["claude-opus-5-5", "claude-next-9"]);
  const [restored, unknownRestored] = subscription.provider.getModels();
  assert.equal(restored.api, "claude-agent-sdk", "capabilities come from the installed Pi where it knows the model");
  assert.deepEqual([restored.contextWindow, restored.maxTokens], [200_000, 64_000], "the limits stay the ones Claude Code reported");
  assert.equal(unknownRestored.api, "claude-agent-sdk");

  await subscription.provider.refreshModels?.(refresh({ stored }));
  assert.equal(spawned.length, 0, "a recent catalog is not re-fetched");
  await subscription.provider.refreshModels?.(refresh({ stored, force: true }));
  assert.equal(spawned.length, 1);
  await subscription.provider.refreshModels?.(refresh({ stored: { ...stored, checkedAt: Date.now() - 25 * 60 * 60_000 } }));
  assert.equal(spawned.length, 2);
});

test("the provider is configured exactly when Claude Code has a login to use, and never invents a key", async () => {
  const subscription = new ClaudeSubscription({ version: "0.0.0-test", query: fakeQuery().query, env: {} });
  const auth = subscription.provider.auth.apiKey;
  assert.ok(auth);
  assert.equal(typeof auth.login, "function", "/login signs in through Claude Code");
  const signal = new AbortController().signal;
  const ctx = (env: Record<string, string>, files: string[]): AuthContext => ({
    env: async name => env[name], fileExists: async path => files.includes(path),
  });
  const none = ctx({}, process.platform === "darwin" ? [] : ["~/.claude.json"]);
  assert.equal(await auth.resolve({ ctx: none, signal }), undefined);
  assert.equal(await auth.check?.({ ctx: none, signal }), undefined);

  const file = ctx({}, ["~/.claude/.credentials.json"]);
  assert.deepEqual(await auth.check?.({ ctx: file, signal }), { type: "api_key", source: "Claude Code login" });
  const resolved = await auth.resolve({ ctx: file, signal });
  assert.equal(resolved?.source, "Claude Code login");
  assert.deepEqual(resolved?.auth, {}, "Claude Code holds the credential; Pi is given nothing to print or send");
  assert.equal((await auth.resolve({ ctx: ctx({ CLAUDE_CONFIG_DIR: "/cfg" }, ["/cfg/.credentials.json"]), signal }))?.source, "Claude Code login");
  assert.equal((await auth.resolve({ ctx: ctx({ CLAUDE_CODE_OAUTH_TOKEN: "token" }, []), signal }))?.source, "CLAUDE_CODE_OAUTH_TOKEN");
});

test("two Pi tools never share a name on the wire, and long names are kept within the API's limit", async () => {
  const { wireNames } = await import("../extensions/claude-subscription/src/tools.js");
  const long = "x".repeat(80);
  const wires = wireNames(["read_file", "read.file", "read/file", long, `${long}y`]);
  assert.equal(wires.get("read_file"), "read_file", "a name that is already valid is kept, whatever the order");
  assert.equal(new Set(wires.values()).size, 5);
  for (const wire of wires.values()) {
    assert.match(wire, /^[a-zA-Z0-9_-]+$/);
    assert.ok(`mcp__pi__${wire}`.length <= 64, wire);
  }
  assert.deepEqual(wireNames(["read.file", "read_file"]), wireNames(["read.file", "read_file"]), "the same tools always get the same names");

  // A running session: `read.file` has been called as `read_file`, then a tool of that very name joins.
  const before = wireNames(["read.file"]);
  assert.equal(before.get("read.file"), "read_file");
  const after = wireNames(["read.file", "read_file"], before);
  assert.equal(after.get("read.file"), "read_file", "the name the model has been using stays with its tool");
  assert.match(after.get("read_file") ?? "", /^read_file_[0-9a-f]{8}$/);
});
