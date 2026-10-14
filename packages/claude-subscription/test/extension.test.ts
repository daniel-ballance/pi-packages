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
  assert.ok(providers[0].getModels().every(model => model.provider === "claude-subscription" && model.api === "claude-agent-sdk" && model.cost.input === 0));
  assert.deepEqual(commands, ["claude-subscription"]);
  assert.deepEqual(events.sort(), ["agent_settled", "before_agent_start", "model_select", "session_shutdown", "session_start"]);
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

/** Lets the background read of the plan report finish. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

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
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const tools: string[] = [];
  const ctx = {
    hasUI: true, mode: "rpc", signal: undefined,
    model: { provider: "claude-subscription" },
    ui: {
      setStatus(key: string, value: string | undefined) { assert.equal(key, "claude-subscription"); statuses.push(value); },
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

test("the meter is read in the background, follows the selected model, and is not re-read every turn", async t => {
  const plan = t.mock.method(ClaudeSubscription.prototype, "planUsage", async () => planReport);
  let closes = 0;
  t.mock.method(ClaudeSubscription.prototype, "closeSessions", () => { closes++; });
  const h = harness(t);
  await h.fire("session_start");
  await settle();
  assert.deepEqual(h.statuses, [undefined, "5h 12% · wk 3%"], "nothing is claimed before anything is known");

  h.ctx.model.provider = "openai";
  await h.fire("model_select", { model: h.ctx.model });
  assert.equal(h.statuses.at(-1), undefined, "another provider's model has no Claude plan to show");
  h.ctx.model.provider = "claude-subscription";
  await h.fire("model_select", { model: h.ctx.model });
  assert.equal(h.statuses.at(-1), "5h 12% · wk 3%");
  await h.fire("agent_settled");
  await settle();
  assert.equal(plan.mock.callCount(), 1, "a recent report is not asked for again");

  await h.fire("session_shutdown");
  assert.equal(h.statuses.at(-1), undefined);
  assert.equal(closes, 1);
});

test("the footer setting decides what the meter shows, and switching it off asks Claude Code nothing", async t => {
  const plan = t.mock.method(ClaudeSubscription.prototype, "planUsage", async () => planReport);
  const quiet = harness(t, { status: "attention" });
  await quiet.fire("session_start");
  await settle();
  assert.equal(quiet.statuses.at(-1), undefined, "well inside the limits there is nothing to say");
  assert.equal(plan.mock.callCount(), 1);

  const off = harness(t, { status: "off" });
  await off.fire("session_start");
  await settle();
  assert.equal(off.statuses.at(-1), undefined);
  assert.equal(plan.mock.callCount(), 1);

  const headless = harness(t);
  headless.ctx.hasUI = false;
  await headless.fire("session_start");
  await settle();
  assert.equal(plan.mock.callCount(), 1, "print and JSON modes have no footer, so no process is started for one");
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
  await h.command();
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /Claude Max · user@example.invalid/);
  assert.match(h.notices[0], /5-hour: 12% used/);
  assert.match(h.notices[0], /Weekly · Fable: 1% used/);
  assert.match(h.notices[0], /Extra usage: off/);
  assert.match(h.notices[0], /Fast mode: off \(unavailable: extra usage is off\)/);
  assert.match(h.notices[0], /\$0.0200 estimate at API list prices · 1 turn · not a bill/);
  assert.match(h.notices[0], /unknown setting "typo"/);
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

test("what a turn reports about the plan reaches the meter at once", async t => {
  let instance: ClaudeSubscription | undefined;
  const fake = fakeQuery(async claude => {
    const user = await claude.user();
    claude.emit({ type: "rate_limit_event", rate_limit_info: rateLimit });
    claude.text("answer", "Hi.", { uuids: [user.uuid] });
    claude.result([user.uuid]);
  });
  // Capture the extension's instance, substituting only the SDK query boundary for this turn.
  t.mock.method(ClaudeSubscription.prototype, "planUsage", async function(this: ClaudeSubscription) {
    instance = this;
    Object.defineProperty(this, "query", { get: () => Promise.resolve(fake.query) });
    return undefined;
  });
  const h = harness(t);
  await h.fire("session_start");
  await settle();
  assert.equal(h.statuses.at(-1), undefined);
  const model = h.provider.getModels()[0];
  const message = await h.provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }], tools: [] }), {}).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(h.statuses.at(-1), "5h 8% · wk 1%");
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

test("an answer about the plan that a turn has since overtaken does not hide what the turn said", async t => {
  let answer: ((value: unknown) => void) | undefined;
  t.mock.method(ClaudeSubscription.prototype, "planUsage", () => new Promise(resolve => { answer = resolve; }));
  let instance: ClaudeSubscription | undefined;
  t.mock.method(ClaudeSubscription.prototype, "closeSessions", function(this: ClaudeSubscription) { instance = this; });
  const h = harness(t);
  await h.fire("session_start");
  await h.fire("session_shutdown");
  await h.fire("session_start");
  assert.ok(instance && answer);
  // While the read is out, a turn reports the 5-hour window nearly used up.
  instance.noteRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: 1791942000 } } } as never);
  assert.match(h.statuses.at(-1) ?? "", /^5h 95% near limit/);
  answer(planReport);
  await settle();
  assert.match(h.statuses.at(-1) ?? "", /^5h 95% near limit/, "the older answer is dropped");
});

test("the plan is asked about at most every few minutes, answered or not, and never after the session ends", async t => {
  const signals: (AbortSignal | undefined)[] = [];
  const plan = t.mock.method(ClaudeSubscription.prototype, "planUsage", async (signal?: AbortSignal) => {
    signals.push(signal);
    return undefined;
  });
  const h = harness(t);
  await h.fire("session_start");
  for (let turn = 0; turn < 4; turn++) await h.fire("agent_settled");
  await settle();
  assert.equal(plan.mock.callCount(), 1, "a Claude Code that cannot answer is not asked again every turn");
  assert.equal(signals[0]?.aborted, false);
  await h.fire("session_shutdown");
  assert.equal(signals[0]?.aborted, true, "a read still out when Pi's session ends is stopped with it");
});
