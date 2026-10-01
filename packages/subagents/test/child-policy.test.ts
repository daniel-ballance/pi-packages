import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: [] }), /provider extension/);
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: ["custom"] }), /provider extension/);
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: ["codemode"], extensions: [provider] }), /requires selecting/);
    const compiled = policy.compile(root, { model: "test/stub:off", tools: ["custom", "read", "codemode"], extensions: [provider, "builtin:codemode"] });
    assert.deepEqual(compiled.childPolicy!.toolSources, { custom: provider, read: "builtin:read", codemode: "/guard.ts" });
    assert.equal(compiled.cliArgs!.includes("builtin:codemode"), false, "guard installs the configured native factory");
    assert.throws(() => policy.compile(root, { model: "test/stub:off", tools: [], extensions: [provider], mcpServers: ["unknown"] }), /not allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
