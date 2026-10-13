import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeSubscription from "../extensions/claude-subscription/index.js";
import { limitText } from "../extensions/claude-subscription/src/index.js";
import { SYSTEM_PROMPT, useOwnSystemPrompt, type SystemPromptChoice } from "../extensions/claude-subscription/src/prompt.js";

test("the extension registers one native provider, a status command and shutdown cleanup", () => {
  const providers: Provider[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerProvider(provider: Provider) { providers.push(provider); },
    registerCommand(name: string) { commands.push(name); },
    on(event: string) { events.push(event); },
  } as unknown as ExtensionAPI;
  claudeSubscription(pi);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "claude-subscription");
  assert.equal(providers[0].name, "Claude subscription (Agent SDK)");
  assert.equal(providers[0].auth.oauth, undefined, "no Pi-side login flow and no stored Claude credentials");
  assert.ok(providers[0].getModels().length > 0);
  assert.ok(providers[0].getModels().every(model => model.provider === "claude-subscription" && model.api === "claude-agent-sdk" && model.cost.input === 0));
  assert.deepEqual(commands, ["claude-subscription"]);
  assert.deepEqual(events.sort(), ["before_agent_start", "session_shutdown", "session_start"]);
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

test("the footer stays quiet until a plan limit needs attention", () => {
  const resetsAt = Date.UTC(2026, 9, 13, 18, 0) / 1000;
  assert.equal(limitText(undefined), undefined);
  assert.equal(limitText({ status: "allowed", rateLimitType: "five_hour", resetsAt }), undefined);
  assert.match(limitText({ status: "allowed", rateLimitType: "five_hour", resetsAt }, true) ?? "", /^Claude 5-hour limit, resets /);
  assert.match(limitText({ status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 0.874, resetsAt }) ?? "", /^Claude weekly Opus limit 87% used, resets /);
  assert.match(limitText({ status: "rejected", rateLimitType: "five_hour", resetsAt }) ?? "", /^Claude 5-hour limit reached, resets /);
  assert.equal(limitText({ status: "rejected" }), "Claude plan limit reached");
});
