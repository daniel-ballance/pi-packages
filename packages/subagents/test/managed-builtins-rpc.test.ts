import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { SubagentPolicy, type Composition } from "../extensions/subagents/src/policy.js";
import { tempRoot } from "./support/temp-root.js";
const fixture = fileURLToPath(new URL("./fixtures/builtin-probe-provider.mjs", import.meta.url));
const server = fileURLToPath(new URL("./fixtures/builtin-probe-mcp.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../extensions/subagents/src/child-guard.ts", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setup(options: { project?: boolean; trusted?: boolean; credentials?: boolean; warming?: boolean; suppress?: boolean; exposure?: string } = {}) {
  const root = tempRoot("managed-builtins-"), agentDir = join(root, "agent");
  mkdirSync(agentDir); mkdirSync(join(root, ".pi"));
  const previous = process.env;
  process.env = { PATH: previous.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
    BUILTIN_PROBE_WARMING: options.warming ? "1" : "0", BUILTIN_PROBE_SERVER: server, BUILTIN_PROBE_EXTENSION_MARKER: join(root, "extension"), BUILTIN_PROBE_LATE_MARKER: join(root, "late") };
  const native = (marker: string) => ({ command: process.execPath, args: [server, join(root, marker)], exposure: options.exposure });
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ autoEnableCodemode: true, mcpServers: { docs: native("global"), denied: native("denied") } }));
  writeFileSync(join(root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { docs: native("project"), extra: native("extra") } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle", codemode: { mode: "on", inlineBudget: 99 } }));
  writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ cacheWarming: "off", codemode: { mode: "on", inlineBudget: 77 } }));
  const config = { version: 1, models: [{ id: "builtin-probe/stub:off" }], tools: ["codemode", "tool_search", "metered"],
    extensions: [fixture, "builtin:codemode", "builtin:tool-search", "builtin:mcp"], providerExtensions: { "builtin-probe": fixture },
    childSettings: { codemode: { mode: "only", inlineBudget: 0 }, ...(options.suppress === false ? {} : { cacheWarming: "off" }) },
    mcp: { inheritCredentials: options.credentials ?? true, servers: [{ name: "docs", tools: ["read-file"], project: options.project ?? false }] } };
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify(config));
  const environment = { cwd: root, agentDir, projectTrusted: options.trusted ?? true, guardPath: guard,
    models: () => [{ provider: "builtin-probe", id: "stub", input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {}, thinkingLevels: ["off"] }],
    tools: () => ["metered"], toolSources: () => ({ metered: fixture }) };
  const policy = new SubagentPolicy(environment);
  const executable = previous.PEER_TEST_EXECUTABLE ?? process.execPath;
  const authorize = (selection: Composition) => ({ ...policy.compile(root, selection), executable, executableArgs: previous.PEER_TEST_EXECUTABLE ? [] : [cli] });
  const manager = new SubagentManager(join(root, "manager"), undefined, undefined, parseChildLimit(4), config => authorize(config.selection!));
  const selection = { model: "builtin-probe/stub:off", tools: ["codemode", "tool_search", "metered"],
    extensions: [fixture, "builtin:codemode", "builtin:tool-search", "builtin:mcp"], mcpServers: ["docs"] };
  const events = (id: string) => readFileSync(manager.get(id).logFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const run = async (id: string, text: string) => {
    const start = events(id).length;
    await manager.send(id, text); const settled = await manager.wait([id], "all", 5000);
    assert.equal(settled.wake, "settled");
    assert.equal(manager.get(id).error, undefined);
    return events(id).slice(start);
  };
  return { root, agentDir, config, environment, policy, manager, selection, events, run,
    spawn: (selected = selection) => manager.spawn({ name: "builtin-policy", task: "Ready", ...authorize(selected) }),
    async close() { await manager.shutdown(); process.env = previous; rmSync(root, { recursive: true, force: true }); } };
}

test("managed native built-ins: isolated discovery, source metadata, collision-safe MCP grants, usage, resume", { timeout: 30000 }, async () => {
  const s = setup();
  try {
    const settings = readFileSync(join(s.agentDir, "settings.json"), "utf8"), mcp = readFileSync(join(s.agentDir, "mcp.json"), "utf8");
    const child = await s.spawn(); await s.manager.wait([child.id], "all", 5000);
    const check = s.events(child.id).find(e => e.entry?.customType === "child-policy-check").entry.data;
    assert.deepEqual(check.errors, []);
    assert.equal(check.inventory.find((t: any) => t.name === "codemode").sourceInfo.path, guard);
    assert.deepEqual(check.settings.enforced, { codemode: { mode: "only", inlineBudget: 0 }, cacheWarming: "off" });
    const search = await s.run(child.id, "SEARCH");
    assert.deepEqual(search.find(e => e.type === "tool_execution_end" && e.toolName === "tool_search").result.details.loaded, []);
    const nested = await s.run(child.id, 'CODE text(typeof models); text(ALL_TOOLS.map(t=>t.name)); await tools.metered({});');
    const text = JSON.stringify(nested.filter(e => e.type === "tool_execution_end" && e.toolName === "codemode").map(e => e.result.content));
    assert.match(text, /undefined/); assert.doesNotMatch(text, /forbidden|subagent_/);
    assert.equal(nested.find(e => e.type === "tool_execution_end" && e.toolName === "metered")?.isError, false, JSON.stringify(nested.filter(e => e.type === "tool_execution_end")));
    await s.manager.refreshUsageSnapshots();
    assert.equal((s.manager.get(child.id).usage as { cost: number }).cost, 0.5);
    for (const name of ["forbidden", "subagent_forbidden"]) {
      const direct = await s.run(child.id, `CALL ${name}`);
      const result = direct.find(e => e.type === "tool_execution_end" && e.toolName === name);
      assert.equal(result?.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /EXECUTED/);
    }
    const calls = await s.run(child.id, 'CODE const list=ALL_TOOLS.filter(t=>t.name.startsWith("mcp__")); text(list.map(t=>t.name)); for (const t of list) text(await tools[t.name]({}));');
    const results = calls.filter(e => e.type === "tool_execution_end" && e.toolName.startsWith("mcp__"));
    assert.equal(results.length, 1, JSON.stringify(calls.filter(e => e.type === "tool_execution_end")));
    assert.match(results[0].toolName, /^mcp__docs__read_file_[a-f0-9]{8}$/);
    assert.equal(results[0].result.details.tool, "read-file");
    assert.equal(readFileSync(join(s.root, "global"), "utf8"), "started\ncalled read-file\n");
    await s.manager.send(child.id, "/late-mcp"); await pause(80);
    for (const marker of ["project", "denied", "extra", "extension", "late"]) assert.equal(existsSync(join(s.root, marker)), false, marker);
    assert.equal(readFileSync(join(s.agentDir, "settings.json"), "utf8"), settings);
    assert.equal(readFileSync(join(s.agentDir, "mcp.json"), "utf8"), mcp);
    await s.manager.close(child.id); await s.manager.resume(child.id);
    await s.run(child.id, 'CODE text(typeof models); await tools.metered({});');
    await s.manager.refreshUsageSnapshots();
    assert.equal((s.manager.get(child.id).usage as { cost: number }).cost, 1);
    assert.equal(s.events(child.id).some(e => e.type === "extension_error"), false);
  } finally { await s.close(); }
});

for (const exposure of ["direct", "deferred"]) test(`native MCP ${exposure} exposure stays usable within the grant`, async () => {
  const s = setup({ exposure });
  try {
    const child = await s.spawn(); await s.manager.wait([child.id], "all", 5000);
    const calls = await s.run(child.id, 'CODE for (const t of ALL_TOOLS.filter(t=>t.name.startsWith("mcp__"))) text(await tools[t.name]({}));');
    assert.equal(calls.filter(e => e.type === "tool_execution_end" && e.toolName.startsWith("mcp__") && !e.isError).length, 1);
    assert.equal(readFileSync(join(s.root, "global"), "utf8"), "started\ncalled read-file\n");
  } finally { await s.close(); }
});

for (const trusted of [false, true]) test(`project MCP config requires both consent and trust (${trusted})`, async () => {
  const s = setup({ project: true, trusted });
  try {
    const child = await s.spawn(); await s.manager.wait([child.id], "all", 5000);
    await s.run(child.id, 'CODE text(ALL_TOOLS.map(t=>t.name));');
    assert.equal(existsSync(join(s.root, "project")), trusted);
    assert.equal(existsSync(join(s.root, "global")), !trusted);
  } finally { await s.close(); }
});

for (const suppress of [false, true]) test(`native idle warming and per-child suppression (${suppress})`, { timeout: 15000 }, async () => {
  const s = setup({ warming: true, suppress });
  try {
    const child = await s.spawn({ ...s.selection, tools: [], extensions: [fixture], mcpServers: [] });
    await s.manager.wait([child.id], "all", 5000);
    const deadline = Date.now() + 5000;
    while (!s.events(child.id).some(e => e.entry?.customType === "warming-decision") && Date.now() < deadline) await pause(20);
    assert.ok(s.events(child.id).some(e => e.entry?.customType === "warming-decision"), "native warming decision hook must actually fire");
    await pause(250);
    const usage = s.events(child.id).filter(e => e.entry?.type === "usage" && e.entry?.kind === "cache_warm");
    if (suppress) {
      assert.equal(usage.length, 0);
      assert.equal((s.manager.get(child.id).usage as { cost: number }).cost, 0);
    } else {
      assert.ok(usage.length > 0, "global idle setting overrides project off; no paid provider used");
      // No manual refresh: the manager must observe idle usage entries.
      assert.ok((s.manager.get(child.id).usage as { cost: number }).cost >= 0.25);
    }
    assert.equal(s.manager.get(child.id).status, "idle");
  } finally { await s.close(); }
});

test("no implicit MCP or credentials; invalid config fails before any selected server starts", async () => {
  const s = setup({ credentials: false });
  try {
    assert.throws(() => s.policy.compile(s.root, s.selection), /credential|consent/);
    const child = await s.spawn({ ...s.selection, extensions: [fixture, "builtin:codemode"], tools: ["codemode"], mcpServers: [] });
    await s.manager.wait([child.id], "all", 5000);
    await s.run(child.id, 'CODE text(ALL_TOOLS.map(t=>t.name));');
    await s.manager.send(child.id, "/late-mcp"); await pause(80);
    for (const marker of ["global", "project", "denied", "extra", "extension", "late"]) assert.equal(existsSync(join(s.root, marker)), false, marker);
  } finally { await s.close(); }
  const bad = setup({ project: true });
  try {
    writeFileSync(join(bad.root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://unused.invalid", auth: { provider: "secret" } } } }));
    await assert.rejects(bad.spawn(), /policy check failed/);
    for (const marker of ["global", "extension"]) assert.equal(existsSync(join(bad.root, marker)), false);
  } finally { await bad.close(); }
});
