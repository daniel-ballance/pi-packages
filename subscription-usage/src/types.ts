/** Shared shapes for subscription usage providers. */

export type UsageWindow = {
  /** Human label, e.g. "Weekly" or "5h". */
  label: string;
  /** Percent used, 0-100. Null means the provider did not report it. */
  percent: number | null;
  /** ISO-8601 instant the window resets, if reported. */
  resetsAt: string | null;
  /** Seconds until reset, derived from resetsAt at fetch time. */
  secondsUntilReset: number | null;
};

export type ProviderId = "chatgpt-pro" | "supergrok";

export type ProviderUsage = {
  id: ProviderId;
  /** Display name, e.g. "ChatGPT Pro". */
  name: string;
  /** Short glyph for the footer, e.g. "GPT" or "SG". */
  glyph: string;
  /** Plan reported by the provider, e.g. "pro". */
  plan: string | null;
  windows: UsageWindow[];
  /** Non-fatal problem worth surfacing (missing field, unexpected shape). */
  note: string | null;
  /** Epoch ms of the successful (or failed) fetch. */
  fetchedAt: number;
};

export type UsageSnapshot = {
  providers: ProviderUsage[];
  fetchedAt: number;
};

/** A provider could not be read at all. */
export class UsageUnavailableError extends Error {
  readonly providerId: ProviderId;
  constructor(providerId: ProviderId, message: string) {
    super(message);
    this.name = "UsageUnavailableError";
    this.providerId = providerId;
  }
}
