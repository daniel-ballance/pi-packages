import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePolicy, SubagentPolicy } from "../extensions/subagents/src/policy.js";
import { permitsMcpTool } from "../extensions/subagents/src/child-policy.js";

test("new policy fields are strict and omitted fields confer no new grants", () => {
  const base = { version: 1, models: [] };
  const old = parsePolicy(base);
  assert.deepEqual(old.mcp, { servers: [], inheritCredentials: false });
  assert.deepEqual(old.childSettings, {}); assert.deepEqual(old.providerExtensions, {});
  for (const patch of [
    { extensions: ["builtin:llama.cpp"] }, { extensions: ["builtin:future"] },
    { providerExtensions: null }, { providerExtensions: { p: "builtin:codemode" } },
    { childSettings: null }, { childSettings: { cacheWarming: "idle" } }, { childSettings: { autoEnableCodemode: true } },
    { childSettings: { codemode: { mode: "off" } } }, { childSettings: { codemode: { inlineBudget: -1 } } },
    { childSettings: { codemode: { inlineBudget: 1.5 } } }, { mcp: null }, { mcp: { inheritCredentials: "yes" } },
    { mcp: { servers: [{ name: "x", tools: ["a*b"] }] } }, { mcp: { servers: [{ name: "x", tools: ["subagent_spawn"] }] } },
    { mcp: { servers: [{ name: "x", tools: [], project: "yes" }] } }, { mcp: { servers: [{ name: "x", tools: [], endpoint: "secret" }] } },
    { mcp: { servers: [{ name: "a-b", tools: [] }, { name: "a_b", tools: [] }] } },
  ]) assert.throws(() => parsePolicy({ ...base, ...patch }), JSON.stringify(patch));
  const parsed = parsePolicy({ ...base, extensions: ["builtin:codemode", "builtin:tool-search", "builtin:mcp"],
    childSettings: { codemode: { mode: "only", inlineBudget: 0 }, cacheWarming: "off" },
    mcp: { servers: [{ name: "docs", tools: ["read-*", "lookup"] }] } });
  const grant = parsed.mcp!.servers[0];
  assert.equal(permitsMcpTool(grant, "read-file"), true);
  assert.equal(permitsMcpTool(grant, "read_file"), false);
  assert.equal(permitsMcpTool(grant, "lookup"), true);
  assert.equal(permitsMcpTool({ ...grant, tools: ["*"] }, "subagent_spawn"), false);
});

test("compile links provider/tool resources, rejects missing selections, and omits virtual models", () => {
  const root = mkdtempSync(join(tmpdir(), "builtin-policy-unit-"));
  const provider = join(root, "provider.mjs");
  writeFileSync(provider, "export default () => {}");
  const config = { version: 1, models: [{ id: "test/stub:off" }, { id: "test/virtual:off" }],
    extensions: [provider, "builtin:codemode"], tools: ["custom", "codemode", "read"], providerExtensions: { test: provider } };
  writeFileSync(join(root, "subagents.json"), JSON.stringify(config));
  const policy = new SubagentPolicy({ cwd: root, agentDir: root, projectTrusted: true, guardPath: "/guard.ts",
    tools: () => ["custom", "read"], toolSources: () => ({ custom: provider, read: "builtin:read" }),
    models: () => ["stub", "virtual"].map(id => ({ provider: "test", id, api: id === "virtual" ? "pi-virtual" : "test",
      input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1, thinkingLevels: ["off"] })) });
  try {
    assert.deepEqual(policy.catalog().models.map(m => m.id), ["test/stub:off"]);
    assert.ok(policy.diagnostics.some(d => d.includes("Virtual")));
    const bare = policy.compile(root, { model: "test/stub:off", tools: [] });
    assert.ok(bare.cliArgs!.includes(provider), "mapped provider extension is selected without being named");
    assert.ok(bare.selection!.extensions!.includes(provider));
    const withTool = policy.compile(root, { model: "test/stub:off", tools: ["custom"] });
    assert.equal(withTool.childPolicy!.toolSources.custom, provider);
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: ["codemode"], extensions: [provider] }), /requires selecting/);
    const compiled = policy.compile(root, { model: "test/stub:off", tools: ["custom", "read", "codemode"], extensions: [provider, "builtin:codemode"] });
    assert.deepEqual(compiled.childPolicy!.toolSources, { custom: provider, read: "builtin:read", codemode: "/guard.ts" });
    assert.equal(compiled.cliArgs!.includes("builtin:codemode"), false, "guard installs the configured native factory");
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: [], extensions: [provider], mcpServers: ["unknown"] }), /not allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("alwaysExtensions and alwaysTools join every composition and must be available", () => {
  const root = mkdtempSync(join(tmpdir(), "always-policy-unit-"));
  const provider = join(root, "provider.mjs");
  writeFileSync(provider, "export default () => {}");
  const base = { version: 1, models: [{ id: "test/stub:off" }], extensions: [provider, "builtin:codemode"], tools: ["custom", "codemode", "read"] };
  assert.throws(() => parsePolicy({ ...base, alwaysExtensions: ["./other.mjs"] }), /must also be listed in extensions/);
  assert.throws(() => parsePolicy({ ...base, alwaysTools: ["bash"] }), /must also be listed in tools/);
  writeFileSync(join(root, "subagents.json"), JSON.stringify({ ...base, alwaysExtensions: [provider, "builtin:codemode"], alwaysTools: ["custom"] }));
  let known = ["custom", "read"];
  const policy = new SubagentPolicy({ cwd: root, agentDir: root, projectTrusted: true, guardPath: "/guard.ts",
    tools: () => known, toolSources: () => ({ custom: provider, read: "builtin:read" }),
    models: () => [{ provider: "test", id: "stub", api: "test", input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1, thinkingLevels: ["off"] }] });
  try {
    assert.deepEqual(policy.catalog().alwaysExtensions, [provider, "builtin:codemode"]);
    assert.deepEqual(policy.catalog().alwaysTools, ["custom"]);
    const compiled = policy.compile(root, { model: "test/stub:off", tools: ["read"] });
    assert.deepEqual(compiled.tools, ["read", "custom"]);
    assert.deepEqual(compiled.selection!.extensions, [provider, "builtin:codemode"], "saved for resume revalidation");
    assert.deepEqual(compiled.childPolicy!.builtins, ["builtin:codemode"]);
    assert.deepEqual(compiled.childPolicy!.toolSources, { read: "builtin:read", custom: provider });
    assert.equal(compiled.cliArgs!.filter(arg => arg === provider).length, 1);
    const explicit = policy.compile(root, { model: "test/stub:off", tools: ["custom", "codemode"], extensions: ["builtin:codemode"] });
    assert.deepEqual(explicit.tools, ["custom", "codemode"]);
    assert.deepEqual(explicit.selection!.extensions, ["builtin:codemode", provider]);
    known = ["read"];
    assert.equal(policy.catalog().spawnEnabled, false);
    assert.ok(policy.diagnostics.some(d => d.startsWith("alwaysTools: custom")));
    known = ["custom", "read"];
    rmSync(provider);
    assert.equal(policy.catalog().spawnEnabled, false);
    assert.ok(policy.diagnostics.some(d => d.startsWith(`alwaysExtensions: ${provider}`)));
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: [] }), /No spawnable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a model from an extension provider needs its extension selected, since Children start without extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "extension-provider-unit-"));
  const provider = join(root, "provider.mjs");
  writeFileSync(provider, "export default () => {}");
  const model = (prov: string) => ({ provider: prov, id: "m", api: "test", input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1, thinkingLevels: ["off"] });
  const environment = (config: object) => {
    writeFileSync(join(root, "subagents.json"), JSON.stringify({ version: 1, tools: ["read"], extensions: [provider], ...config }));
    return new SubagentPolicy({ cwd: root, agentDir: root, projectTrusted: true, guardPath: "/guard.ts", tools: () => ["read"],
      models: () => [model("bridge"), model("builtin")], extensionProviders: () => ["bridge"] });
  };
  try {
    const unmapped = environment({ models: [{ id: "bridge/m:off" }, { id: "builtin/m:off" }] });
    const catalog = unmapped.catalog().models;
    assert.match(String((catalog.find(m => m.id === "bridge/m:off") as { requiresExtension?: string }).requiresExtension), /select that extension/);
    assert.equal((catalog.find(m => m.id === "builtin/m:off") as { requiresExtension?: string }).requiresExtension, undefined);
    assert.throws(() => unmapped.compile(root, { model: "bridge/m:off", tools: [] }), /comes from a provider an extension registers/);
    assert.ok(unmapped.compile(root, { model: "bridge/m:off", tools: [], extensions: [provider] }), "selecting the extension is enough");
    assert.ok(unmapped.compile(root, { model: "builtin/m:off", tools: [] }));
    const mapped = environment({ models: [{ id: "bridge/m:off" }, { id: "builtin/m:off" }], providerExtensions: { bridge: provider } });
    assert.equal((mapped.catalog().models.find(m => m.id === "bridge/m:off") as { requiresExtension?: string }).requiresExtension, undefined);
    const selected = mapped.compile(root, { model: "bridge/m:off", tools: [] });
    assert.ok(selected.cliArgs!.includes(provider));
    assert.ok(selected.selection!.extensions!.includes(provider));
    const other = mapped.compile(root, { model: "builtin/m:off", tools: [] });
    assert.equal(other.cliArgs!.includes(provider), false);
    const denied = environment({ models: [{ id: "bridge/m:off" }, { id: "builtin/m:off" }], extensions: [], providerExtensions: { bridge: provider } });
    assert.throws(() => denied.compile(root, { model: "bridge/m:off", tools: [] }), (error: Error) => {
      assert.equal(error.message.includes(provider), true);
      assert.equal(error.message.includes("allowlist"), true);
      assert.equal(error.message.includes("(empty)"), true);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a mapped provider file that is missing or absent from the catalog does not spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "mapped-miss-unit-"));
  const missing = join(root, "missing.mjs");
  const directory = join(root, "not-a-file");
  mkdirSync(directory);
  const model = (prov: string) => ({ provider: prov, id: "m", api: "test", input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1, thinkingLevels: ["off"] });
  const environment = (config: object) => {
    writeFileSync(join(root, "subagents.json"), JSON.stringify({ version: 1, tools: ["read"], models: [{ id: "bridge/m:off" }, { id: "builtin/m:off" }], ...config }));
    return new SubagentPolicy({ cwd: root, agentDir: root, projectTrusted: true, guardPath: "/guard.ts", tools: () => ["read"],
      models: () => [model("bridge"), model("builtin")] });
  };
  try {
    const gone = environment({ extensions: [missing], providerExtensions: { bridge: missing } });
    assert.equal(gone.catalog().spawnEnabled, true);
    assert.throws(() => gone.compile(root, { model: "bridge/m:off", tools: [] }), (error: Error) => {
      assert.match(error.message, /mapped file does not exist/);
      assert.equal(error.message.includes(missing), true);
      assert.match(error.message, /Fix providerExtensions in subagents\.json/);
      return true;
    });
    const filtered = environment({ extensions: [directory], providerExtensions: { bridge: directory } });
    assert.equal(filtered.catalog().spawnEnabled, true);
    assert.equal(filtered.catalog().extensions.includes(directory), false);
    assert.throws(() => filtered.compile(root, { model: "bridge/m:off", tools: [] }), (error: Error) => {
      assert.match(error.message, /not in the catalog's extensions/);
      assert.equal(error.message.includes(directory), true);
      assert.match(error.message, /Add that file to extensions/);
      return true;
    });
    const disabled = environment({ extensions: [missing], providerExtensions: { bridge: missing }, models: [{ id: "bridge/m:off" }] });
    assert.equal(disabled.catalog().spawnEnabled, false);
    assert.throws(() => disabled.compile(root, { model: "bridge/m:off", tools: [] }), /No spawnable configuration/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale allowlist entry before the mapped file does not block that spawn or hide the allowlist error", () => {
  const root = mkdtempSync(join(tmpdir(), "stale-allowlist-unit-"));
  const provider = join(root, "provider.mjs");
  const stale = join(root, "gone.mjs");
  writeFileSync(provider, "export default () => {}");
  const model = (prov: string) => ({ provider: prov, id: "m", api: "test", input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1, thinkingLevels: ["off"] });
  const policy = (extensions: string[]) => {
    writeFileSync(join(root, "subagents.json"), JSON.stringify({ version: 1, tools: ["read"],
      models: [{ id: "bridge/m:off" }, { id: "builtin/m:off" }], extensions, providerExtensions: { bridge: provider } }));
    return new SubagentPolicy({ cwd: root, agentDir: root, projectTrusted: true, guardPath: "/guard.ts", tools: () => ["read"],
      models: () => [model("bridge"), model("builtin")] });
  };
  try {
    const selected = policy([stale, provider]).compile(root, { model: "bridge/m:off", tools: [] });
    assert.ok(selected.cliArgs!.includes(provider), "stale entry listed first still selects the mapped file");
    assert.throws(() => policy([stale]).compile(root, { model: "bridge/m:off", tools: [] }), (error: Error) => {
      assert.equal(error.message.includes(provider), true);
      assert.equal(error.message.includes("allowlist"), true);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
