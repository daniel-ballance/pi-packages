import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerClaudeCode } from "./delegate.js";
import { SessionStore } from "./resume.js";
import { ClaudeSubscription } from "./provider.js";
import { installedSdkVersion, loadQuery, subscriptionEnv } from "./sdk.js";
import { readUsage, renderReport } from "./usage.js";
import { registerWebTools } from "./webtools.js";

const COMMAND = "claude-subscription";

function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
    ? manifest.version : "0.0.0";
}

export default function claudeSubscription(pi: ExtensionAPI) {
  const version = packageVersion();
  let settings = loadConfig(getAgentDir());
  const subscription = new ClaudeSubscription({
    version,
    sdkVersion: installedSdkVersion(),
    // Only when asked for: Claude Code then writes each conversation under its own directory.
    resume: settings.config.resume ? {
      store: new SessionStore(join(getAgentDir(), "claude-subscription", "sessions")),
      read: async () => (await import("@anthropic-ai/claude-agent-sdk")).getSessionMessages,
    } : undefined,
    knownTools: () => pi.getAllTools().map(tool => tool.name),
  });
  pi.registerProvider(subscription.provider);

  // The extras each run their own short-lived Claude Code process, apart from the conversation's.
  if (settings.config.webTools) {
    registerWebTools(pi, {
      loadQuery,
      env: subscriptionEnv(process.env, version),
      cwd: process.cwd(),
      onRateLimit: event => subscription.noteRateLimit(event.rate_limit_info),
    });
  }
  if (settings.config.claudeCode) {
    registerClaudeCode(pi, {
      loadQuery,
      env: subscriptionEnv(process.env, version),
      onRateLimit: info => subscription.noteRateLimit(info),
      onResult: result => subscription.countRun(result),
    });
  }

  // Each Claude Code process belongs to the conversation that started it.
  pi.on("session_shutdown", () => {
    subscription.closeSessions();
  });

  pi.registerCommand(COMMAND, {
    description: "Show the Claude account, plan limits and usage behind the claude-subscription provider",
    async handler(_args, ctx) {
      // Print and JSON modes have nowhere to show it, and it would start a process for nothing.
      if (!ctx.hasUI) return;
      settings = loadConfig(getAgentDir());
      const status = await subscription.status(ctx.signal).catch((error: unknown) => ({ problem: error instanceof Error ? error.message : String(error) }));
      const failed = "problem" in status;
      ctx.ui.notify(renderReport(readUsage(failed ? undefined : status.plan, subscription.rateLimit), {
        account: failed ? subscription.account : status.account,
        accountProblem: failed ? status.problem : undefined,
        fastMode: subscription.fastMode, spend: subscription.spend, openSessions: subscription.openSessions,
        configProblems: settings.problems, configPath: settings.path,
      }), "info");
    },
  });
}
