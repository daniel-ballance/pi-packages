import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentDir, DEFAULT_ROLES, liveRoles, resolveRoles, type RoleValue } from "../extensions/p3stack/src/roles.ts";

const capabilities = "mcp__t3-code__orchestrator_capabilities";

function env(t: TestContext, key: string, value?: string) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

function directories(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-roles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), personal = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(personal);
  env(t, "PI_CODING_AGENT_DIR", personal);
  return { cwd, personal: join(personal, "p3stack.json"), project: join(cwd, ".pi", "p3stack.json") };
}

function lookup(t: TestContext, host: "cli" | "t3", { models = [] as string[], t3 = undefined as unknown, pins = {} as Record<string, RoleValue> } = {}) {
  env(t, "T3_MCP_URL", host === "t3" ? "http://127.0.0.1:1/mcp" : undefined);
  const { cwd, personal } = directories(t);
  writeFileSync(personal, JSON.stringify({ roles: pins }));
  const calls: string[] = [];
  const pi = {
    getThinkingLevel: () => "high",
    getAllTools: () => (t3 ? [{ name: capabilities }] : []),
    events: { emit(name: string, data: { reply(value: unknown): void }) { calls.push(name); data.reply({ spawnEnabled: true, models }); } },
  };
  const ctx = {
    cwd, isProjectTrusted: () => false, modelRegistry: { getAvailable: () => [] },
    executeTool: async (name: string) => {
      calls.push(name);
      return { toolCall: { type: "toolCall" as const, id: "1", name, arguments: {} }, result: { content: [], structuredContent: t3, details: {} }, isError: !t3 };
    },
  };
  return { calls, resolve: (distinctFrom?: string) => liveRoles(pi, ctx, distinctFrom) };
}

test("a T3-named tool in a terminal is never called", async t => {
  const h = lookup(t, "cli", { models: ["xai/grok-4.7:high"], t3: { providers: [] } });
  const result = await h.resolve();
  assert.equal(result.roles["swarm workers"], "xai/grok-4.7:high");
  assert.ok(!h.calls.includes(capabilities));
});

test("a missing T3 catalog blocks every role without consulting terminal policy", async t => {
  const h = lookup(t, "t3", { models: ["xai/grok-4.7:high"] });
  const result = await h.resolve();
  assert.deepEqual(result.roles, {});
  for (const role of Object.keys(DEFAULT_ROLES)) assert.ok(result.problems.some(p => p.includes(role) && /T3 catalog unavailable/i.test(p)));
  assert.deepEqual(h.calls, [capabilities]);
});

test("the agent directory follows Pi for empty, tilde and explicit overrides", t => {
  env(t, "PI_CODING_AGENT_DIR", "");
  assert.equal(agentDir(), join(homedir(), ".pi", "agent"));
  process.env.PI_CODING_AGENT_DIR = "~/pi-tests";
  assert.equal(agentDir(), join(homedir(), "pi-tests"));
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "ordinary");
  assert.equal(agentDir(), join(tmpdir(), "ordinary"));
});

test("an invalid trusted role file is reported without masking personal defaults", t => {
  const { cwd, project, personal } = directories(t);
  writeFileSync(personal, JSON.stringify({ roles: { "bug-fix": "pi/gpt-6:medium" } }));
  for (const invalid of ["{", JSON.stringify({ roles: [] })]) {
    writeFileSync(project, invalid);
    const result = resolveRoles(cwd, true);
    assert.equal(result.source, personal);
    assert.equal(result.roles["bug-fix"].value, "pi/gpt-6:medium");
    assert.ok(result.problems.some(problem => problem.includes(project)));
  }
});
