import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCredentials } from "./src/auth.ts";
import { fetchChatGptUsage } from "./src/chatgpt.ts";
import { fetchSuperGrokUsage } from "./src/supergrok.ts";
import { formatFooter, formatSummary, formatFailures } from "./src/format.ts";
import { UsageUnavailableError, type ProviderUsage } from "./src/types.ts";

const STATUS_KEY = "subscription-usage";
const DEFAULT_TTL_MS = 120_000;

type Failure = { glyph: string; message: string };

/**
 * Refresh guard. Both upstreams are private and rate-limit-friendly polling is
 * a courtesy, so every path funnels through one TTL cache and one in-flight
 * promise.
 */
class UsageCache {
  private providers: ProviderUsage[] = [];
  private failures: Failure[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  get age(): number {
    return this.fetchedAt === 0 ? Infinity : Date.now() - this.fetchedAt;
  }

  get isFresh(): boolean {
    return this.age < this.ttlMs;
  }

  get footer(): string {
    return formatFooter(this.providers);
  }

  get lines(): string[] {
    const out: string[] = [];
    if (this.providers.length > 0) out.push(formatSummary({ providers: this.providers, fetchedAt: this.fetchedAt }));
    out.push(...formatFailures(this.failures));
    return out;
  }

  async refresh(force: boolean): Promise<void> {
    if (!force && this.isFresh) return;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const creds = readCredentials();
      const providers: ProviderUsage[] = [];
      const failures: Failure[] = [];

      const jobs: Array<Promise<void>> = [];

      if (creds.chatgpt) {
        jobs.push(
          fetchChatGptUsage(creds.chatgpt)
            .then((p) => { providers.push(p); })
            .catch((error: unknown) => {
              failures.push({
                glyph: "GPT",
                message: error instanceof UsageUnavailableError ? error.message : "unavailable",
              });
            }),
        );
      } else {
        failures.push({ glyph: "GPT", message: "no openai-codex OAuth token (run /login openai-codex)" });
      }

      if (creds.supergrok) {
        jobs.push(
          fetchSuperGrokUsage({ accessToken: creds.supergrok.accessToken })
            .then((p) => { providers.push(p); })
            .catch((error: unknown) => {
              failures.push({
                glyph: "SG",
                message: error instanceof UsageUnavailableError ? error.message : "unavailable",
              });
            }),
        );
      } else {
        failures.push({ glyph: "SG", message: "no xai OAuth token (run /login xai with a subscription)" });
      }

      await Promise.all(jobs);

      this.providers = providers;
      this.failures = failures;
      this.fetchedAt = Date.now();
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }
}

function paint(ctx: ExtensionContext, cache: UsageCache): void {
  if (!ctx.hasUI) return;
  const footer = cache.footer;
  if (footer) ctx.ui.setStatus(STATUS_KEY, footer);
  else ctx.ui.setStatus(STATUS_KEY, "usage: unavailable");
}

export default function subscriptionUsage(pi: ExtensionAPI) {
  const cache = new UsageCache();

  pi.on("session_start", async (_event, ctx) => {
    await cache.refresh(false);
    paint(ctx, cache);
  });

  // Refresh after the agent settles, never mid-turn: the TTL keeps this to
  // at most one request pair per window against two private upstreams.
  pi.on("agent_settled", async (_event, ctx) => {
    await cache.refresh(false);
    paint(ctx, cache);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "");
  });

  pi.registerCommand("usage", {
    description: "Show ChatGPT Pro and SuperGrok subscription usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        console.log("subscription-usage: no UI in this mode");
        return;
      }
      // refresh() records per-provider failures in the cache rather than
      // rejecting, so one dead upstream cannot hide the other.
      await cache.refresh(true);
      paint(ctx, cache);
      const lines = cache.lines;
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No usage data available.", "info");
    },
  });
}

export { UsageCache };
