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

const t3Model = (id: string, ...values: string[]) => ({ id, options: [{ id: "thinking", values }] });
const provider = (providerInstanceId: string, ...models: ReturnType<typeof t3Model>[]) => ({ providerInstanceId, models, canRunChildTask: true });
const target = (providerInstanceId: string, model: string, level: string) => ({ providerInstanceId, model, options: [{ id: "thinking", value: level }] });

test("a T3 pin selects the named instance and the entire model id before any alias", async t => {
  const models = [t3Model("gpt-6", "high"), t3Model("xai/grok-4.7", "high")];
  const h = lookup(t, "t3", {
    t3: { providers: [provider("work", ...models, t3Model("personal/gpt-6", "high")), provider("personal", ...models)] },
    pins: { "bug-fix": "personal/gpt-6:high", "swarm workers": "personal/xai/grok-4.7:high", "hardest tasks": "gone/gpt-6:high" },
  });
  const { roles, problems } = await h.resolve();
  assert.deepEqual(roles["bug-fix"], target("personal", "gpt-6", "high"));
  assert.deepEqual(roles["swarm workers"], target("personal", "xai/grok-4.7", "high"));
  assert.equal(roles["hardest tasks"], undefined, "never move a missing instance's pin to work");
  assert.ok(problems.some(p => p.includes("gone/gpt-6:high")));
});

test("T3 selects the closest advertised level below the hint and names the downgrade", async t => {
  const h = lookup(t, "t3", { t3: { providers: [provider("pi", t3Model("xai/grok-4.7", "low", "max", "high", "medium"))] } });
  const { roles, problems } = await h.resolve();
  assert.deepEqual(roles["swarm workers"], target("pi", "xai/grok-4.7", "high"));
  assert.ok(problems.some(p => p.includes("grok-4.7-xhigh-fast") && p.includes("pi/xai/grok-4.7:high")));
});

test("T3 cannot satisfy a thinking pin with unadvertised or higher effort", async t => {
  const h = lookup(t, "t3", { t3: { providers: [provider("pi", t3Model("gpt-6", "max"), t3Model("grok-4.7"))] },
    pins: { "bug-fix": "pi/gpt-6:high", "perf-issue": "pi/grok-4.7:low" } });
  const { roles, problems } = await h.resolve();
  for (const role of ["bug-fix", "perf-issue"]) assert.equal(roles[role], undefined);
  for (const pin of ["pi/gpt-6:high", "pi/grok-4.7:low"]) assert.ok(problems.some(p => p.includes(pin)));
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
