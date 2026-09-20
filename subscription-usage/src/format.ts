import type { ProviderUsage, UsageSnapshot } from "./types.ts";

/** 604800 -> "6d 18h", 4500 -> "1h 15m", 300 -> "5m", 0 -> "now". */
export function formatCountdown(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return "unknown";
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return s <= 30 ? "now" : "1m";
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function percentText(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

/** One window: "5% weekly · resets 6d 18h". */
export function formatWindow(window: {
  label: string;
  percent: number | null;
  secondsUntilReset: number | null;
}): string {
  const parts = [`${percentText(window.percent)} ${window.label.toLowerCase()}`];
  if (window.secondsUntilReset !== null) {
    parts.push(`resets ${formatCountdown(window.secondsUntilReset)}`);
  }
  return parts.join(" · ");
}

/** Full single-provider line for the /usage listing. */
export function formatProviderLine(provider: ProviderUsage): string {
  const head = `${provider.glyph.padEnd(3)} ${provider.name}`;
  if (provider.windows.length === 0) {
    return `${head}: ${provider.note ?? "no windows reported"}`;
  }
  const body = provider.windows.map(formatWindow).join(" · ");
  return provider.note ? `${head}: ${body}  (${provider.note})` : `${head}: ${body}`;
}

/**
 * Compact footer fragment: "GPT 5% · SG —".
 * Uses the widest window per provider, worst-case first.
 */
export function formatFooter(providers: ProviderUsage[]): string {
  if (providers.length === 0) return "";
  return providers
    .map((provider) => {
      const worst = pickPrimaryWindow(provider);
      return `${provider.glyph} ${percentText(worst?.percent ?? null)}`;
    })
    .join(" · ");
}

/** The window that should drive the footer: highest usage, else the first. */
export function pickPrimaryWindow(provider: ProviderUsage) {
  if (provider.windows.length === 0) return null;
  return [...provider.windows].sort((a, b) => {
    const av = a.percent ?? -1;
    const bv = b.percent ?? -1;
    return bv - av;
  })[0];
}

export function formatSummary(snapshot: UsageSnapshot): string {
  const lines: string[] = ["Subscription usage"];
  if (snapshot.providers.length === 0) {
    lines.push("  No subscriptions available. Sign in with /login openai-codex and /login xai.");
    return lines.join("\n");
  }
  for (const provider of snapshot.providers) {
    lines.push(`  ${formatProviderLine(provider)}`);
  }
  return lines.join("\n");
}

/** Errors rendered as their own lines so one dead provider cannot hide the other. */
export function formatFailures(failures: Array<{ glyph: string; message: string }>): string[] {
  return failures.map((f) => `  ${f.glyph.padEnd(3)} unavailable: ${f.message}`);
}
