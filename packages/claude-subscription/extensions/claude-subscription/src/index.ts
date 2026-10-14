import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerClaudeCode } from "./delegate.js";
import { PROVIDER_ID } from "./models.js";
import { useOwnSystemPrompt } from "./prompt.js";
import { SessionStore } from "./resume.js";
import { ClaudeSubscription } from "./provider.js";
import { loadQuery, subscriptionEnv } from "./sdk.js";
import { readUsage, renderMeter, renderReport } from "./usage.js";
import { registerWebTools } from "./webtools.js";

const STATUS_KEY = "claude-subscription";
/** A turn reports the two main windows; the full plan report is asked for again after this long. */
const REPORT_MAX_AGE_MS = 5 * 60_000;

function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
    ? manifest.version : "0.0.0";
}

export default function claudeSubscription(pi: ExtensionAPI) {
  const version = packageVersion();
  let settings = loadConfig(getAgentDir());
  let ui: ExtensionUIContext | undefined;
  /** Whether a model of this provider is the selected one; the meter is shown only then. */
  let selected = false;
  /** Claude Code's full plan report; what a later turn reports about the plan replaces it. */
  let report: unknown;
  /** When the report was last asked for, whether or not an answer came. */
  let askedAt = 0;
  /** Counts the plan figures turns have reported, so an answer that was overtaken can be told. */
  let reported = 0;
  let lastEvent: unknown;
  /** Ends background reads when Pi's session does. */
  let background = new AbortController();

  const showMeter = (): void => {
    const usage = readUsage(report, subscription.rateLimit);
    // Nothing is shown until something is known; a meter that says "unavailable" is only noise.
    ui?.setStatus(STATUS_KEY, selected && usage.source !== "none" ? renderMeter(usage, settings.config.status) : undefined);
  };
  const subscription = new ClaudeSubscription({
    version,
    // Only when asked for: Claude Code then writes each conversation under its own directory.
    resume: settings.config.resume ? {
      store: new SessionStore(join(getAgentDir(), "claude-subscription", "sessions")),
      read: async () => (await import("@anthropic-ai/claude-agent-sdk")).getSessionMessages,
    } : undefined,
    knownTools: () => pi.getAllTools().map(tool => tool.name),
    onChange: () => {
      // What a turn just reported is newer than a plan report read before it.
      if (subscription.rateLimit !== lastEvent) {
        lastEvent = subscription.rateLimit;
        report = undefined;
        reported++;
      }
      showMeter();
    },
  });
  pi.registerProvider(subscription.provider);

  /**
   * Read the plan report behind the meter, in the background. A turn reports its limits
   * only now and then, and nothing at all before the first one, so the meter would
   * otherwise start empty and go stale.
   */
  const refreshMeter = (ctx: ExtensionContext): void => {
    if (!selected || !ctx.hasUI || settings.config.status === "off") return;
    // By the last attempt, not the last answer: a Claude Code that cannot answer is not asked every turn.
    if (Date.now() - askedAt < REPORT_MAX_AGE_MS) return;
    askedAt = Date.now();
    const asked = reported;
    const { signal } = background;
    void subscription.planUsage(signal).then(latest => {
      // A turn that reported since, or a session that ended, has made this answer the older one.
      if (latest === undefined || asked !== reported || signal.aborted) return;
      report = latest;
      showMeter();
    });
  };

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

  // Pi's default preamble is not sent. A prompt the user already set is kept.
  pi.on("before_agent_start", (event, ctx) => {
    useOwnSystemPrompt(event.systemPromptOptions, ctx.model?.provider);
  });

  pi.on("session_start", (_event, ctx) => {
    background = new AbortController();
    ui = ctx.ui;
    selected = ctx.model?.provider === PROVIDER_ID;
    settings = loadConfig(getAgentDir());
    showMeter();
    refreshMeter(ctx);
  });
  // The meter belongs to this provider's models and leaves the footer with them.
  pi.on("model_select", (event, ctx) => {
    ui = ctx.ui;
    selected = event.model.provider === PROVIDER_ID;
    showMeter();
    refreshMeter(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    refreshMeter(ctx);
  });
  // Each Claude Code process belongs to the conversation that started it.
  pi.on("session_shutdown", () => {
    background.abort();
    subscription.closeSessions();
    ui?.setStatus(STATUS_KEY, undefined);
    ui = undefined;
    selected = false;
  });

  pi.registerCommand(STATUS_KEY, {
    description: "Show the Claude account, plan limits and usage behind the claude-subscription provider",
    async handler(_args, ctx) {
      // Print and JSON modes have nowhere to show it, and it would start a process for nothing.
      if (!ctx.hasUI) return;
      settings = loadConfig(getAgentDir());
      const [account, latest] = await Promise.allSettled([subscription.identify(ctx.signal), subscription.planUsage(ctx.signal)]);
      askedAt = Date.now();
      if (latest.status === "fulfilled" && latest.value !== undefined) report = latest.value;
      showMeter();
      ctx.ui.notify(renderReport(readUsage(report, subscription.rateLimit), {
        account: account.status === "fulfilled" ? account.value : subscription.account,
        accountProblem: account.status === "rejected" ? String(account.reason instanceof Error ? account.reason.message : account.reason) : undefined,
        fastMode: subscription.fastMode, spend: subscription.spend, openSessions: subscription.openSessions,
        configProblems: settings.problems, configPath: settings.path,
      }), "info");
    },
  });
}
