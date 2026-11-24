import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { agentDir, DEFAULT_ROLES, family, liveRoles, registerRoles, resolveRoles, type RoleValue } from "../extensions/p3stack/src/roles.ts";
import { registerSetup } from "../extensions/p3stack/src/setup.ts";

const capabilities = "mcp__t3-code__orchestrator_capabilities";

function env(key: string, value?: string) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const { PI_CODING_AGENT_DIR, T3_MCP_URL } = process.env;
afterEach(() => { env("PI_CODING_AGENT_DIR", PI_CODING_AGENT_DIR); env("T3_MCP_URL", T3_MCP_URL); });

function directories(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-roles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), personal = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(personal);
  env("PI_CODING_AGENT_DIR", personal);
  return { cwd, personal: join(personal, "p3stack.json"), project: join(cwd, ".pi", "p3stack.json") };
}

function lookup(t: TestContext, host: "cli" | "t3", { models = [] as string[], t3 = undefined as unknown, pins = {} as Record<string, RoleValue>, parent = undefined as { provider: string; id: string } | undefined } = {}) {
  env("T3_MCP_URL", host === "t3" ? "http://127.0.0.1:1/mcp" : undefined);
  const { cwd, personal } = directories(t);
  if (Object.keys(pins).length) writeFileSync(personal, JSON.stringify({ roles: pins }));
  const calls: string[] = [];
  const pi = {
    getThinkingLevel: () => "high",
    getAllTools: () => (t3 ? [{ name: capabilities }] : []),
    events: { emit(name: string, data: { reply(value: unknown): void }) { calls.push(name); data.reply({ spawnEnabled: true, models }); } },
  };
  const ctx = {
    cwd, model: parent, isProjectTrusted: () => false, modelRegistry: { getAvailable: () => [] },
    executeTool: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      const data = typeof t3 === "function" ? t3(args) : t3;
      return { toolCall: { type: "toolCall" as const, id: "1", name, arguments: args }, result: { content: [], structuredContent: data, details: {} }, isError: !data };
    },
  };
  return { pi, ctx, personal, calls, resolve: (distinctFrom?: string) => liveRoles(pi, ctx, distinctFrom) };
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

test("a setup pin outside T3's short list gets an exact lookup before any family substitution", async t => {
  const queries: unknown[] = [], id = "org/gpt-6-long", pin = `work/${id}:high`;
  const short = { providers: [provider("work", t3Model("gpt-5", "high")), provider("personal", t3Model(id, "high"))] };
  const h = lookup(t, "t3", { pins: { "bug-fix": pin, hillclimb: pin }, t3: (args: { search?: string }) => {
    queries.push(args);
    return args.search === id ? { providers: [provider("work", t3Model(id, "high"))] } : short;
  } });
  for (let i = 0; i < 2; i++) {
    const { roles } = await h.resolve();
    assert.deepEqual(roles["bug-fix"], target("work", id, "high"));
    assert.deepEqual(roles.hillclimb, roles["bug-fix"]);
  }
  assert.deepEqual(queries, [{}, { search: id }]);
});

test("a reasoning toggle is not the model's advertised thinking level option", async t => {
  const model = { id: "gpt-6", options: [{ id: "adaptiveThinking", values: [true, false] }, { id: "thinking", values: ["high"] }] };
  const h = lookup(t, "t3", { pins: { "bug-fix": "work/gpt-6:high" }, t3: { providers: [{ providerInstanceId: "work", models: [model], canRunChildTask: true }] } });
  assert.deepEqual((await h.resolve()).roles["bug-fix"], target("work", model.id, "high"));
});

test("T3 cannot satisfy a thinking pin with unadvertised or higher effort", async t => {
  const h = lookup(t, "t3", { t3: { providers: [provider("pi", t3Model("gpt-6", "max"), t3Model("grok-4.7"))] },
    pins: { "bug-fix": "pi/gpt-6:high", "perf-issue": "pi/grok-4.7:low" } });
  const { roles, problems } = await h.resolve();
  for (const role of ["bug-fix", "perf-issue"]) assert.equal(roles[role], undefined);
  for (const pin of ["pi/gpt-6:high", "pi/grok-4.7:low"]) assert.ok(problems.some(p => p.includes(pin)));
});

test("default hints use the offered family, then another usable model, and name substitutions", async t => {
  const h = lookup(t, "cli", { models: ["api/gpt-6:xhigh", "bedrock/us.anthropic.claude-sonnet:high"] });
  const { roles, problems } = await h.resolve();
  assert.equal(roles["judgment and prose"], "bedrock/us.anthropic.claude-sonnet:high");
  assert.equal(roles["bug-fix"], "api/gpt-6:xhigh");
  assert.equal(Object.keys(roles).length, Object.keys(DEFAULT_ROLES).length);
  assert.ok(problems.some(p => p.includes("api/gpt-6:xhigh") && p.includes("grok-4.7-xhigh-fast")));
});

test("operator pins stay exact or in-family even when asked for diversity", async t => {
  const h = lookup(t, "t3", { t3: { providers: [provider("other", t3Model("claude-opus", "xhigh")), provider("account", t3Model("claude-sonnet", "high"), t3Model("gpt-6", "xhigh"))] },
    pins: { "bug-fix": "account/claude-opus:xhigh", "perf-issue": "account/claude-sonnet:high", hillclimb: "account/grok-4:high" } });
  const { roles, problems } = await h.resolve("claude");
  for (const role of ["bug-fix", "perf-issue"]) assert.deepEqual(roles[role], target("account", "claude-sonnet", "high"));
  assert.equal(roles.hillclimb, undefined);
  assert.ok(problems.some(p => p.includes("account/claude-opus:xhigh") && p.includes("account/claude-sonnet:high")));
  assert.ok(problems.some(p => p.includes("account/grok-4:high")));
});

test("other-host pins are hints; an ambiguous Pi identity cannot select a T3 account", async t => {
  const cli = lookup(t, "cli", { pins: { "bug-fix": "pi-main/xai/grok-4.6:medium" }, models: ["xai/grok-4.7:low"] });
  assert.equal((await cli.resolve()).roles["bug-fix"], "xai/grok-4.7:low");
  const models = [t3Model("xai/grok-4.7", "high")];
  const t3 = lookup(t, "t3", { pins: { "bug-fix": "xai/grok-4.6:high", hillclimb: "xai/grok-4.7:high" },
    t3: { providers: [provider("account", ...models), provider("another", ...models)] } });
  const ambiguous = await t3.resolve();
  assert.equal(ambiguous.roles["bug-fix"], undefined);
  assert.equal(ambiguous.roles.hillclimb, undefined);
  const single = lookup(t, "t3", { pins: { "bug-fix": "xai/grok-4.6:high" }, t3: { providers: [provider("account", ...models)] } });
  assert.deepEqual((await single.resolve()).roles["bug-fix"], target("account", "xai/grok-4.7", "high"));
});

test("a foreign unknown model id can match exactly without inventing a family", async t => {
  const cli = lookup(t, "cli", { pins: { "bug-fix": "work/local/alias-v2:low" }, models: ["local/alias-v2:low"] });
  assert.equal((await cli.resolve()).roles["bug-fix"], "local/alias-v2:low");
  const t3 = lookup(t, "t3", { pins: { "bug-fix": "local/alias-v2:low" }, t3: { providers: [provider("work", t3Model("local/alias-v2", "low"))] } });
  assert.deepEqual((await t3.resolve()).roles["bug-fix"], target("work", "local/alias-v2", "low"));
});

test("an unavailable panel pin drops only its seat and is reported once across roles", async t => {
  const missing = "api/gemini-3:high", allowed = "api/gpt-6:high";
  const h = lookup(t, "cli", { pins: { "bug-fix": missing, "perf-issue": missing, "arena runners": [missing, allowed] }, models: [allowed] });
  const { roles, problems } = await h.resolve();
  assert.deepEqual(roles["arena runners"], [allowed]);
  assert.equal(roles["bug-fix"], undefined);
  const errors = problems.filter(p => p.includes(missing));
  assert.equal(errors.length, 1);
  for (const role of ["bug-fix", "perf-issue", "arena runners"]) assert.ok(errors[0].includes(role));
});

test("a panel uses distinct eligible families across seats, not just a different family than the author", async t => {
  const h = lookup(t, "cli", { models: ["api/claude-opus-5-5:high", "api/grok-4.7:high", "api/gpt-6:high"] });
  const panel = (await h.resolve("claude")).roles["interrogate reviewers"];
  assert.ok(Array.isArray(panel));
  assert.deepEqual(new Set(panel), new Set(["api/grok-4.7:high", "api/gpt-6:high"]));
  const only = lookup(t, "cli", { models: ["api/gpt-6:high"] });
  const result = await only.resolve();
  assert.deepEqual(result.roles["interrogate reviewers"], ["api/gpt-6:high", "api/gpt-6:high"]);
  assert.ok(result.problems.some(p => p.includes("interrogate reviewers") && /distinct famil/i.test(p)));
});

test("family checks recognise prefixed ids but never claim independence for unknown aliases", async t => {
  assert.equal(family("bedrock/us.anthropic.claude-opus-5"), "claude");
  assert.equal(family("api/internal-alias-v2:xhigh"), "internal-alias-v2");
  const h = lookup(t, "cli", { models: ["bedrock/us.anthropic.claude-opus-5:high", "api/internal-alias-v2:high", "other/claude-opus-5-5:high"] });
  const { roles, problems } = await h.resolve("claude");
  assert.equal(roles["judgment and prose"], "other/claude-opus-5-5:high");
  assert.ok(problems.some(p => p.includes("judgment and prose") && /family/.test(p)));
  const unknown = await h.resolve("internal-alias-v2");
  assert.ok(unknown.problems.some(p => p.includes("internal-alias-v2") && /unknown|cannot verify/i.test(p)));
  assert.ok(!unknown.problems.some(p => p.includes("to differ from internal-alias-v2")));
});

test("a fallback judgment prefers another family even when the author is not a permitted child", async t => {
  const h = lookup(t, "cli", { parent: { provider: "author", id: "gpt-6" }, models: ["child/gpt-6:xhigh", "child/gemini-3:high"] });
  assert.equal((await h.resolve()).roles["judgment and prose"], "child/gemini-3:high");
});

test("an implicit fallback preference does not collapse an otherwise diverse panel", async t => {
  const h = lookup(t, "cli", { parent: { provider: "author", id: "gpt-6" }, models: ["api/claude-opus-5-5:high", "api/gpt-6:high"] });
  assert.deepEqual((await h.resolve()).roles["interrogate reviewers"], ["api/claude-opus-5-5:high", "api/gpt-6:high"]);
});

test("a panel prefers two verifiable families over a private alias", async t => {
  const h = lookup(t, "cli", { models: ["api/private:xhigh", "api/gpt-6:high", "api/gemini-3:high"] });
  const panel = (await h.resolve()).roles["architect runners"];
  assert.ok(Array.isArray(panel));
  assert.deepEqual(new Set(panel), new Set(["api/gpt-6:high", "api/gemini-3:high"]));
});

test("diversity is not permission to exceed the thinking cap", async t => {
  const h = lookup(t, "cli", { models: ["api/claude-opus-5-5:high", "api/gpt-6:max"] });
  assert.equal((await h.resolve("claude")).roles["judgment and prose"], "api/claude-opus-5-5:high");
});

function wizard(h: ReturnType<typeof lookup>, selectModel = (options: string[]) => options[0]) {
  const notices: string[] = [], questions: string[][] = [], messages: string[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  let command!: (args: string, ctx: unknown) => Promise<void>;
  const pi = Object.assign(h.pi, {
    registerCommand: (_: string, c: { handler: typeof command }) => { command = c.handler; }, registerTool() {},
    on: (name: string, fn: (event: unknown) => void) => handlers.set(name, fn),
    sendMessage: (m: { content: string }) => messages.push(m.content),
  });
  registerRoles(pi as never); registerSetup(pi as never);
  const ui = {
    select: async (title: string, options: string[]) => {
      questions.push(options);
      return title.startsWith("Thinking budget") ? "small, medium thinking" : selectModel(options);
    },
    confirm: async () => false, notify: (message: string) => notices.push(message),
  };
  const run = (hasUI = true) => command("", { cwd: h.ctx.cwd, modelRegistry: h.ctx.modelRegistry, hasUI, get ui() { assert.ok(hasUI); return ui; } });
  return { run, notices, questions, messages, emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event) };
}

test("setup states the budget, actual judgment level and panel it wrote when no model meets the floor", async t => {
  const h = lookup(t, "cli", { models: ["api/coder:low"] });
  h.pi.getAllTools = () => [{ name: "subagent_catalog" }];
  const w = wizard(h);
  await w.run();
  const written = JSON.parse(readFileSync(h.personal, "utf8"));
  assert.deepEqual(written.roles["arena runners"], ["api/coder:low", "api/coder:low"]);
  const notice = w.notices.at(-1)!;
  assert.match(notice, /no offered model.*high thinking/i);
  assert.doesNotMatch(notice, /stay at high thinking/);
  for (const value of [h.personal, written.budget, ...written.roles["arena runners"], "panel"]) assert.ok(notice.toLowerCase().includes(value.toLowerCase()));
});

test("setup offers a real judgment floor if any permitted model reaches it", async t => {
  const h = lookup(t, "cli", { models: ["api/plain:low", "api/gpt-6:high"] });
  h.pi.getAllTools = () => [{ name: "subagent_catalog" }];
  const w = wizard(h);
  await w.run();
  assert.deepEqual(w.questions[2], ["api/gpt-6:high"]);
  assert.deepEqual(JSON.parse(readFileSync(h.personal, "utf8")).roles["arena runners"], ["api/gpt-6:high", "api/plain:low"]);
});

test("T3 setup consumes this session's catalog; its choices round trip to ready targets", async t => {
  const model = t3Model("xai/grok-4.7", "medium", "high");
  const h = lookup(t, "t3", { t3: { providers: [provider("work", model), provider("personal", model)] } });
  const w = wizard(h, options => options.find(s => s.startsWith("personal/"))!);
  await h.resolve();
  await w.run(); // command context has no executeTool
  assert.ok(existsSync(h.personal), `setup did not write: ${w.notices}`);
  const written = JSON.parse(readFileSync(h.personal, "utf8"));
  assert.deepEqual(written.roles["arena runners"], ["personal/xai/grok-4.7:high", "personal/xai/grok-4.7:medium"]);
  assert.ok(w.notices.at(-1)!.includes("personal/xai/grok-4.7:high"));
  assert.deepEqual((await h.resolve()).roles["bug-fix"], target("personal", model.id, "medium"));
  assert.deepEqual(h.calls, [capabilities], "one session lookup, including setup and the next role resolution");
  w.emit("model_select");
  await w.run();
  assert.equal(w.questions.length, 3, "provider changes invalidate the catalog before another setup");
});

test("T3 setup uses a successful unfiltered local catalog result but not a foreign or failed one", async t => {
  const h = lookup(t, "t3"), w = wizard(h);
  const catalog = { providers: [provider("account", t3Model("gpt-6", "low", "high"))] };
  const result = { toolName: capabilities, input: {}, content: [], structuredContent: { structuredContent: catalog } };
  w.emit("tool_result", { ...result, input: { environmentId: "elsewhere" } });
  await w.run();
  assert.deepEqual(w.questions, []);
  w.emit("tool_result", result);
  await w.run();
  assert.ok(existsSync(h.personal), `setup did not write: ${w.notices}`);
  rmSync(h.personal);
  w.emit("tool_result", { ...result, isError: true });
  await w.run();
  assert.equal(existsSync(h.personal), false);
  assert.ok(w.notices.at(-1)!.includes("catalog"));
});

test("without UI, setup reports a dry run without touching the role file", async t => {
  const h = lookup(t, "t3"), w = wizard(h);
  await w.run(false);
  assert.equal(existsSync(h.personal), false);
  assert.match(w.messages.join("\n"), /no UI.*nothing written/i);
});

test("the agent directory follows Pi for empty, tilde and explicit overrides", () => {
  env("PI_CODING_AGENT_DIR", "");
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
