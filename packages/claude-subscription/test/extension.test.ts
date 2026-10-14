import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeSubscription from "../extensions/claude-subscription/index.js";
import { ClaudeSubscription } from "../extensions/claude-subscription/src/provider.js";
import { SYSTEM_PROMPT, useOwnSystemPrompt, type SystemPromptChoice } from "../extensions/claude-subscription/src/prompt.js";
import { fakeQuery } from "./support/claude.js";

test("the extension registers one native provider, a status command and shutdown cleanup", () => {
  const providers: Provider[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const tools: string[] = [];
  const pi = {
    registerProvider(provider: Provider) { providers.push(provider); },
    registerCommand(name: string) { commands.push(name); },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    on(event: string) { events.push(event); },
  } as unknown as ExtensionAPI;
  claudeSubscription(pi);
  assert.deepEqual(tools, [], "the extras are off until the user's settings ask for them");
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "claude-subscription");
  assert.equal(providers[0].name, "Claude subscription (Agent SDK)");
  assert.equal(providers[0].auth.oauth, undefined, "sign-in is Claude Code's own; Pi holds no OAuth credential for it");
  assert.equal((providers[0].auth.apiKey as { isSubscription?: boolean } | undefined)?.isSubscription, true);
  assert.ok(providers[0].getModels().length > 0);
  assert.ok(providers[0].getModels().every(model => model.provider === "claude-subscription" && model.api === "claude-agent-sdk"));
  assert.ok(providers[0].getModels().some(model => model.cost.input > 0), "turns are priced as the API prices them");
  assert.deepEqual(commands, ["claude-subscription"]);
  assert.deepEqual(events.sort(), ["before_agent_start", "session_shutdown"]);
});

test("a turn on this provider uses its own prompt, and a prompt already chosen stays", () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /operating inside pi|coding agent harness/i);
  const fresh: SystemPromptChoice = {};
  useOwnSystemPrompt(fresh, "claude-subscription");
  assert.equal(fresh.customPrompt, SYSTEM_PROMPT);

  const chosen: SystemPromptChoice = { customPrompt: "Follow the project notes." };
  useOwnSystemPrompt(chosen, "claude-subscription");
  assert.equal(chosen.customPrompt, "Follow the project notes.");

  const forced: SystemPromptChoice = { forceSystemPrompt: "Exactly this." };
  useOwnSystemPrompt(forced, "claude-subscription");
  assert.equal(forced.customPrompt, undefined);
  assert.equal(forced.forceSystemPrompt, "Exactly this.");

  const other: SystemPromptChoice = {};
  useOwnSystemPrompt(other, "anthropic");
  useOwnSystemPrompt(other, undefined);
  assert.equal(other.customPrompt, undefined);

  const handlers = new Map<string, (event: { systemPromptOptions: SystemPromptChoice }, ctx: { model?: { provider?: string } }) => void>();
  claudeSubscription({
    registerProvider() {},
    registerCommand() {},
    on(event: string, handler: (event: { systemPromptOptions: SystemPromptChoice }, ctx: { model?: { provider?: string } }) => void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);
  const event: { systemPromptOptions: SystemPromptChoice } = { systemPromptOptions: {} };
  handlers.get("before_agent_start")?.(event, { model: { provider: "claude-subscription" } });
  assert.equal(event.systemPromptOptions.customPrompt, SYSTEM_PROMPT);
});

const rateLimit = {
  status: "allowed", rateLimitType: "five_hour", overageStatus: "rejected",
  unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1791942000 }, seven_day: { utilization: 0.01, resetsAt: 1792537200 } },
};
const planReport = { rate_limits: { extra_usage: { is_enabled: false }, limits: [
  { kind: "session", group: "session", percent: 12, resets_at: "2026-10-14T01:40:00Z", severity: "normal" },
  { kind: "weekly_all", group: "weekly", percent: 3, resets_at: "2026-10-20T23:00:00Z", severity: "normal" },
  { kind: "weekly_scoped", group: "weekly", percent: 1, scope: { model: { display_name: "Fable" } } },
] } };

function harness(t: TestContext, config?: unknown) {
  const agentDir = mkdtempSync(join(tmpdir(), "claude-subscription-extension-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (config !== undefined) writeFileSync(join(agentDir, "claude-subscription.json"), JSON.stringify(config));
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(agentDir, { recursive: true, force: true });
  });
  let provider: Provider;
  let command: (args: string, ctx: unknown) => Promise<void>;
  const handlers = new Map<string, (event: any, ctx: any) => void | Promise<void>>();
  /** Anything written to the footer; the extension leaves it to Pi. */
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const tools: string[] = [];
  const ctx = {
    hasUI: true, mode: "rpc", signal: undefined,
    model: { provider: "claude-subscription" },
    ui: {
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      notify(value: string, type: string) { assert.equal(type, "info"); notices.push(value); },
    },
  };
  claudeSubscription({
    registerProvider(value: Provider) { provider = value; },
    registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    on(event: string, handler: (event: any, ctx: any) => void) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI);
  return {
    ctx, statuses, notices, tools, get provider() { return provider; },
    fire: (event: string, value: unknown = {}) => handlers.get(event)?.(value, ctx),
    command: () => command("", ctx),
  };
}

test("the plan is read only for the command, and the footer is left to Pi", async t => {
  const plan = t.mock.method(ClaudeSubscription.prototype, "planUsage", async () => planReport);
  t.mock.method(ClaudeSubscription.prototype, "identify", async () => ({ subscriptionType: "Claude Max" }));
  let closes = 0;
  t.mock.method(ClaudeSubscription.prototype, "closeSessions", () => { closes++; });
  const h = harness(t);
  for (const event of ["session_start", "model_select", "agent_settled"]) await h.fire(event, { model: h.ctx.model });
  assert.equal(plan.mock.callCount(), 0, "no Claude Code process is started for the plan until asked");
  await h.command();
  assert.equal(plan.mock.callCount(), 1);
  assert.match(h.notices[0], /5-hour: 12% used/);
  assert.deepEqual(h.statuses, []);
  await h.fire("session_shutdown");
  assert.equal(closes, 1);
});

test("the command reports every plan row, the session's spend and configuration problems", async t => {
  t.mock.method(ClaudeSubscription.prototype, "identify", async function(this: ClaudeSubscription) {
    this.fastMode = { state: "off", reason: "extra_usage_disabled" };
    this.spend.costUsd = 0.02;
    this.spend.turns = 1;
    return { subscriptionType: "Claude Max", email: "user@example.invalid" };
  });
  t.mock.method(ClaudeSubscription.prototype, "planUsage", async () => planReport);
  const h = harness(t, { status: "always", typo: true });
  // The footer meter was removed; an old setting for it is reported like any other unknown one.
  await h.command();
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /Claude Max · user@example.invalid/);
  assert.match(h.notices[0], /5-hour: 12% used/);
  assert.match(h.notices[0], /Weekly · Fable: 1% used/);
  assert.match(h.notices[0], /Extra usage: off/);
  assert.match(h.notices[0], /Fast mode: off \(unavailable: extra usage is off\)/);
  assert.match(h.notices[0], /\$0.0200 estimate at API list prices · 1 turn · not a bill/);
  assert.match(h.notices[0], /unknown setting "typo"/);
  assert.match(h.notices[0], /unknown setting "status"/);
});

test("a failed sign-in is reported in place of the account, and print modes start nothing", async t => {
  let calls = 0;
  t.mock.method(ClaudeSubscription.prototype, "identify", async () => { calls++; throw new Error("sign in required"); });
  t.mock.method(ClaudeSubscription.prototype, "planUsage", async () => undefined);
  const h = harness(t);
  await h.command();
  assert.match(h.notices[0], /Account: sign in required/);
  assert.match(h.notices[0], /Plan usage unavailable/);
  h.ctx.hasUI = false;
  h.ctx.mode = "json";
  await h.command();
  assert.equal(calls, 1);
  assert.equal(h.notices.length, 1);
});

test("what a turn reports about the plan reaches the command when the full report is unavailable", async t => {
  let instance: ClaudeSubscription | undefined;
  const fake = fakeQuery(async claude => {
    const user = await claude.user();
    claude.emit({ type: "rate_limit_event", rate_limit_info: rateLimit });
    claude.text("answer", "Hi.", { uuids: [user.uuid] });
    claude.result([user.uuid]);
  });
  t.mock.method(ClaudeSubscription.prototype, "identify", async () => ({ subscriptionType: "Claude Max" }));
  // Capture the extension's instance, substituting only the SDK query boundary for this turn.
  t.mock.method(ClaudeSubscription.prototype, "planUsage", async function(this: ClaudeSubscription) {
    instance = this;
    Object.defineProperty(this, "query", { get: () => Promise.resolve(fake.query) });
    return undefined;
  });
  const h = harness(t);
  await h.command();
  const model = h.provider.getModels()[0];
  const message = await h.provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }], tools: [] }), {}).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  await h.command();
  assert.match(h.notices.at(-1) ?? "", /5-hour: 8% used/);
  assert.match(h.notices.at(-1) ?? "", /Limits from the last turn/);
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(fake.spawned[0].failures, []);
  await h.fire("session_shutdown");
  assert.equal(instance?.openSessions, 0);
  assert.equal(fake.spawned[0].closed, true);
});

test("the extras are offered only when the user's settings ask for them", t => {
  assert.deepEqual(harness(t, { webTools: true }).tools, ["claude_web_search", "claude_web_fetch"]);
  assert.deepEqual(harness(t, { claudeCode: true }).tools, ["claude_code"]);
  assert.deepEqual(harness(t, {}).tools, []);
});
