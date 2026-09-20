import { UsageUnavailableError, type ProviderUsage, type UsageWindow } from "./types.ts";

/**
 * SuperGrok usage, read from the private endpoint Grok's CLI uses.
 *
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * The `format` parameter selects the view:
 *   ?format=credits  -> weekly usage period + prepaid balance
 *   (no format)      -> monthly limit + ~3 months of billing history
 *
 * Undocumented: no SLA, no changelog.
 */

export const SUPERGROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const SUPERGROK_MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";

export const SUPERGROK_HEADERS = {
  Accept: "application/json",
  "x-grok-client-mode": "cli",
  "x-grok-client-version": "1.0.4",
};

type Cent = { val?: unknown };

type RawConfig = {
  currentPeriod?: { type?: unknown; start?: unknown; end?: unknown } | null;
  creditUsagePercent?: unknown;
  monthlyLimit?: Cent | null;
  used?: Cent | null;
  onDemandCap?: Cent | null;
  onDemandUsed?: Cent | null;
  prepaidBalance?: Cent | null;
  billingPeriodStart?: unknown;
  billingPeriodEnd?: unknown;
};

type RawResponse = {
  config?: RawConfig | null;
  subscription_tier?: unknown;
  subscriptionTier?: unknown;
};

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Cent wrappers carry i64 integers; tolerate the string form. */
function centVal(cent: Cent | null | undefined): number | undefined {
  if (!cent || typeof cent !== "object") return undefined;
  const raw = cent.val;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
  return undefined;
}

/** USAGE_PERIOD_TYPE_WEEKLY -> "Weekly"; ..._MONTHLY -> "Monthly". */
function periodLabel(type: unknown): string {
  const text = typeof type === "string" ? type : "";
  if (text.endsWith("WEEKLY")) return "Weekly";
  if (text.endsWith("MONTHLY")) return "Monthly";
  return "Current period";
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Pure: turn the wire payload into a ProviderUsage.
 *
 * Grok speaks proto3 JSON, which omits zero-valued fields. A missing
 * `creditUsagePercent` therefore means "not reported", not 0% — we surface
 * it as null rather than inventing a number.
 */
export function parseSuperGrokBilling(body: unknown, fetchedAt = Date.now()): ProviderUsage {
  if (!body || typeof body !== "object") {
    throw new UsageUnavailableError("supergrok", "SuperGrok billing response is not an object");
  }
  const raw = body as RawResponse;
  const config = raw.config;
  if (!config || typeof config !== "object") {
    throw new UsageUnavailableError("supergrok", "SuperGrok billing response has no config");
  }

  const period = config.currentPeriod;
  const resetsAt = isoOrNull(period?.end) ?? isoOrNull(config.billingPeriodEnd);
  const secondsUntilReset =
    resetsAt !== null ? Math.max(0, Math.round((Date.parse(resetsAt) - fetchedAt) / 1000)) : null;

  const windows: UsageWindow[] = [];

  const reported = asFiniteNumber(config.creditUsagePercent);
  const used = centVal(config.used);
  const limit = centVal(config.monthlyLimit);

  let percent: number | null = null;
  let note: string | null = null;

  if (reported !== undefined) {
    percent = clampPercent(reported);
  } else if (limit !== undefined && limit > 0 && used !== undefined && used >= 0) {
    percent = clampPercent((used / limit) * 100);
  } else {
    // Absent, not zero. Say so.
    note = "Usage percent not reported";
  }

  // Push whenever there is anything true to say: a period, a reset time, or a
  // computed percentage. Dropping a computed percent because the payload had no
  // period object would silently lose the monthly view.
  if (period || resetsAt || percent !== null) {
    windows.push({
      label: periodLabel(period?.type),
      percent,
      resetsAt,
      secondsUntilReset,
    });
  }

  const plan =
    typeof raw.subscription_tier === "string"
      ? raw.subscription_tier
      : typeof raw.subscriptionTier === "string"
        ? raw.subscriptionTier
        : null;

  return {
    id: "supergrok",
    name: "SuperGrok",
    glyph: "SG",
    plan: plan ?? "SuperGrok",
    windows,
    note,
    fetchedAt,
  };
}

export async function fetchSuperGrokUsage(
  options: {
    accessToken: string;
    fetchImpl?: typeof fetch;
    url?: string;
    timeoutMs?: number;
  },
): Promise<ProviderUsage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(options.url ?? SUPERGROK_BILLING_URL, {
      method: "GET",
      headers: { ...SUPERGROK_HEADERS, Authorization: `Bearer ${options.accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new UsageUnavailableError(
          "supergrok",
          `HTTP ${response.status} — subscription token invalid, re-login with /login xai ("Use a subscription")`,
        );
      }
      throw new UsageUnavailableError("supergrok", `HTTP ${response.status}`);
    }
    return parseSuperGrokBilling(await response.json());
  } catch (error) {
    if (error instanceof UsageUnavailableError) throw error;
    throw new UsageUnavailableError("supergrok", "SuperGrok billing request failed");
  } finally {
    clearTimeout(timer);
  }
}
