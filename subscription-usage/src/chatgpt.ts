import { UsageUnavailableError, type ProviderUsage, type UsageWindow } from "./types.ts";

/**
 * ChatGPT Pro usage, read from the private backend API that backs
 * chatgpt.com/#settings/Usage.
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *
 * `/backend-api/codex/usage` returns a byte-identical payload. Undocumented:
 * no SLA, no changelog. Keep the poll interval generous.
 */

export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** A browser-ish UA matters: the HTML routes 403 hard without one. */
export const CHATGPT_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Referer: "https://chatgpt.com/",
};

type RawWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
};

type RawResponse = {
  plan_type?: unknown;
  rate_limit?: {
    allowed?: unknown;
    limit_reached?: unknown;
    primary_window?: RawWindow | null;
    secondary_window?: RawWindow | null;
  } | null;
  credits?: { has_credits?: unknown; unlimited?: unknown; balance?: unknown };
  spend_control?: { reached?: unknown } | null;
  rate_limit_reached_type?: unknown;
};

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 604800 -> "Weekly", 18000 -> "5h", 900 -> "15m". */
export function windowLabel(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "Limit";
  if (seconds === 604_800) return "Weekly";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds)}s`;
}

function toWindow(raw: RawWindow | null | undefined, fallbackLabel: string): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const windowSeconds = asFiniteNumber(raw.limit_window_seconds);
  const resetAt = asFiniteNumber(raw.reset_at);
  const resetAfter = asFiniteNumber(raw.reset_after_seconds);

  const secondsUntilReset =
    resetAfter !== undefined
      ? Math.max(0, resetAfter)
      : resetAt !== undefined
        ? Math.max(0, resetAt - Math.floor(Date.now() / 1000))
        : null;

  const usedPercent = asFiniteNumber(raw.used_percent);

  return {
    label: windowLabel(windowSeconds) === "Limit" ? fallbackLabel : windowLabel(windowSeconds),
    percent: usedPercent === undefined ? null : Math.min(100, Math.max(0, usedPercent)),
    resetsAt: resetAt !== undefined ? new Date(resetAt * 1000).toISOString() : null,
    secondsUntilReset,
  };
}

/** Pure: turn the wire payload into a ProviderUsage. Throws on unusable shapes. */
export function parseChatGptUsage(body: unknown, fetchedAt = Date.now()): ProviderUsage {
  if (!body || typeof body !== "object") {
    throw new UsageUnavailableError("chatgpt-pro", "ChatGPT usage response is not an object");
  }
  const raw = body as RawResponse;
  const windows: UsageWindow[] = [];

  const primary = toWindow(raw.rate_limit?.primary_window, "Primary");
  const secondary = toWindow(raw.rate_limit?.secondary_window, "Secondary");
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);

  const plan = typeof raw.plan_type === "string" ? raw.plan_type : null;

  let note: string | null = null;
  if (windows.length === 0) {
    note = "No rate-limit windows reported";
  } else if (raw.rate_limit?.limit_reached === true) {
    note = "Limit reached";
  } else if (raw.rate_limit?.allowed === false) {
    note = "Not allowed right now";
  }

  if (!plan) note = note ?? "Plan not reported";

  return {
    id: "chatgpt-pro",
    name: "ChatGPT Pro",
    glyph: "GPT",
    plan,
    windows,
    note,
    fetchedAt,
  };
}

export async function fetchChatGptUsage(
  options: {
    accessToken: string;
    accountId: string;
    fetchImpl?: typeof fetch;
    url?: string;
    timeoutMs?: number;
  },
): Promise<ProviderUsage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(options.url ?? CHATGPT_USAGE_URL, {
      method: "GET",
      headers: {
        ...CHATGPT_HEADERS,
        Authorization: `Bearer ${options.accessToken}`,
        "chatgpt-account-id": options.accountId,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new UsageUnavailableError(
          "chatgpt-pro",
          `HTTP ${response.status} — ChatGPT session expired, re-login with /login openai-codex`,
        );
      }
      throw new UsageUnavailableError("chatgpt-pro", `HTTP ${response.status}`);
    }
    return parseChatGptUsage(await response.json());
  } catch (error) {
    if (error instanceof UsageUnavailableError) throw error;
    throw new UsageUnavailableError("chatgpt-pro", "ChatGPT usage request failed");
  } finally {
    clearTimeout(timer);
  }
}
