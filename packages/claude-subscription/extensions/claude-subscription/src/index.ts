import { readFileSync } from "node:fs";
import type { AccountInfo, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./models.js";
import { useOwnSystemPrompt } from "./prompt.js";
import { ClaudeSubscription } from "./provider.js";

const STATUS_KEY = "claude-subscription";

const WINDOWS: Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
    ? manifest.version : "0.0.0";
}

/** One line on a plan limit, or nothing while the plan has room. */
export function limitText(info: SDKRateLimitInfo | undefined, always = false): string | undefined {
  if (!info || (info.status === "allowed" && !always)) return undefined;
  const window = info.rateLimitType ? `${WINDOWS[info.rateLimitType]} limit` : "plan limit";
  const used = info.utilization === undefined ? "" : ` ${Math.round(info.utilization * 100)}% used`;
  const resets = info.resetsAt === undefined ? ""
    : `, resets ${new Date(info.resetsAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  return info.status === "rejected" ? `Claude ${window} reached${resets}` : `Claude ${window}${used}${resets}`;
}

function accountText(account: AccountInfo): string {
  if (!account.subscriptionType) return "Claude Code is not signed in with a Claude subscription. Run `claude auth login`.";
  return [account.subscriptionType, account.email, account.organization].filter(Boolean).join(" · ");
}

export default function claudeSubscription(pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  const subscription = new ClaudeSubscription({
    version: packageVersion(),
    // Like the MCP status in this collection, the footer speaks up only when something needs attention.
    onChange: () => ui?.setStatus(STATUS_KEY, limitText(subscription.rateLimit)),
  });
  pi.registerProvider(subscription.provider);

  // Pi's default preamble is not sent. A prompt the user already set is kept.
  pi.on("before_agent_start", (event, ctx) => {
    useOwnSystemPrompt(event.systemPromptOptions, ctx.model?.provider);
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });
  // Each Claude Code process belongs to the conversation that started it.
  pi.on("session_shutdown", () => {
    subscription.closeSessions();
    ui?.setStatus(STATUS_KEY, undefined);
    ui = undefined;
  });

  pi.registerCommand(STATUS_KEY, {
    description: "Show the Claude account and plan limits behind the claude-subscription provider",
    async handler(_args, ctx) {
      try {
        const lines = [accountText(await subscription.identify(ctx.signal))];
        const limit = limitText(subscription.rateLimit, true);
        if (limit) lines.push(limit);
        lines.push(`${subscription.openSessions} open Claude Code session${subscription.openSessions === 1 ? "" : "s"} · models: /model ${PROVIDER_ID}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(`claude-subscription: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
