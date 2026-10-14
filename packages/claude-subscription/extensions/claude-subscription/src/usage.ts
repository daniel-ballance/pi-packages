import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";

export interface UsageLimit {
  kind: string;
  group: string;
  label: string;
  percent?: number;
  resetsAt?: number;
  severity?: string;
  reached: boolean;
}

export interface PlanUsage {
  limits: UsageLimit[];
  source: "report" | "event" | "none";
  subscription?: string;
  extraUsage?: boolean;
  extraUsageReason?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function words(value: string): string {
  return value.replace(/[_-]/g, " ");
}

function reset(value: unknown, seconds = false): number | undefined {
  const time = seconds && number(value) !== undefined ? (value as number) * 1000
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && !Number.isNaN(new Date(time).getTime()) ? time : undefined;
}

const WINDOWS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly (all models)",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · OAuth apps",
  seven_day_overage_included: "Weekly · included extra usage",
  overage: "Extra usage",
};

function label(kind: string): string {
  return Object.hasOwn(WINDOWS, kind) ? WINDOWS[kind] : words(kind);
}

function reportRow(value: unknown): UsageLimit | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = record(value);
  const kind = text(row.kind) ?? "unknown";
  const group = text(row.group) ?? "";
  const scope = record(row.scope);
  const scoped = [text(record(scope.model).display_name), text(record(scope.surface).display_name)].filter(Boolean).join(" · ");
  const ownLabel = text(row.display_name) ?? text(row.displayName) ?? text(row.label) ?? text(row.title) ?? text(row.name);
  const base = ownLabel ?? (kind === "session" ? "5-hour" : kind === "weekly_all" ? "Weekly (all models)"
    : kind === "weekly_scoped" ? "Weekly" : kind === "unknown" ? "Plan limit" : words(kind));
  const label = [base, scoped].filter(Boolean).join(" · ");
  const percent = number(row.percent);
  return {
    kind, group, label,
    percent, resetsAt: reset(row.resets_at), severity: text(row.severity), reached: (percent ?? 0) >= 100,
  };
}

function eventUsage(value: unknown): PlanUsage {
  const event = record(value);
  const limits: UsageLimit[] = [];
  const windows = record(event.unifiedWindows);
  for (const [kind, value] of Object.entries(windows)) {
    const window = record(value);
    const fraction = number(window.utilization);
    const percent = fraction === undefined ? undefined : number(fraction * 100);
    limits.push({
      kind, group: kind.startsWith("seven_day") ? "weekly" : "session", label: label(kind),
      percent, resetsAt: reset(window.resetsAt, true),
      reached: (percent ?? 0) >= 100 || (event.status === "rejected" && event.rateLimitType === kind),
      severity: event.status === "allowed_warning" && event.rateLimitType === kind ? "warning" : undefined,
    });
  }
  const kind = text(event.rateLimitType);
  if (!limits.some(row => row.kind === kind) && (kind || event.status === "rejected" || event.status === "allowed_warning")) {
    const fraction = number(event.utilization);
    const percent = fraction === undefined ? undefined : number(fraction * 100);
    limits.push({
      kind: kind ?? "unknown", group: "", label: kind ? label(kind) : "Plan limit",
      percent, resetsAt: reset(event.resetsAt, true),
      reached: event.status === "rejected" || (percent ?? 0) >= 100,
      severity: event.status === "allowed_warning" ? "warning" : undefined,
    });
  }
  return {
    limits, source: limits.length ? "event" : "none",
    extraUsage: event.overageStatus === "allowed" || event.isUsingOverage === true ? true
      : event.overageStatus === "rejected" ? false : undefined,
    extraUsageReason: text(event.overageDisabledReason),
  };
}

/** `/usage` uses percentages; turn events use fractions. Keep that boundary here. */
export function readUsage(report: unknown, event?: unknown): PlanUsage {
  const fallback = eventUsage(event);
  const response = record(report);
  const rates = record(response.rate_limits);
  let limits: UsageLimit[] | undefined;
  if (Array.isArray(rates.limits)) {
    // Server rows own their ordering, labels, scopes and severity, including future kinds.
    limits = rates.limits.flatMap(value => reportRow(value) ?? []);
  } else {
    const legacy: UsageLimit[] = [];
    for (const [kind, value] of Object.entries(rates)) {
      if (kind === "extra_usage" || kind === "spend" || kind === "model_scoped") continue;
      const window = record(value);
      if (!("utilization" in window)) continue;
      const percent = number(window.utilization);
      legacy.push({ kind, group: "", label: label(kind), percent, resetsAt: reset(window.resets_at), reached: (percent ?? 0) >= 100 });
    }
    if (Array.isArray(rates.model_scoped)) {
      for (const value of rates.model_scoped) {
        const row = record(value);
        legacy.push({
          kind: "weekly_scoped", group: "weekly", label: `Weekly · ${text(row.display_name) ?? "model"}`,
          percent: number(row.utilization),
          resetsAt: reset(row.resets_at), reached: (number(row.utilization) ?? 0) >= 100,
        });
      }
    }
    if (legacy.length) limits = legacy;
  }
  const extraUsage = boolean(record(rates.spend).enabled) ?? boolean(record(rates.extra_usage).is_enabled);
  return {
    limits: limits ?? fallback.limits, source: limits === undefined ? fallback.source : "report",
    subscription: text(response.subscription_type),
    extraUsage: extraUsage ?? fallback.extraUsage,
    extraUsageReason: text(record(rates.spend).disabled_reason) ?? text(record(rates.extra_usage).disabled_reason)
      ?? (extraUsage === undefined ? fallback.extraUsageReason : undefined),
  };
}

export function resetTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export interface ReportDetails {
  account?: AccountInfo;
  accountProblem?: string;
  fastMode?: { state: string; reason?: string };
  spend: { costUsd: number; turns: number };
  openSessions: number;
  configProblems: string[];
  configPath: string;
}

const REASONS: Record<string, string> = {
  extra_usage_disabled: "extra usage is off",
  sdk_opt_in_required: "not enabled for this connection",
  org_level_disabled: "disabled by your organization",
  model_not_supported: "this model does not support it",
  not_supported: "not supported for this account",
};

function reason(value: string): string {
  return Object.hasOwn(REASONS, value) ? REASONS[value] : words(value);
}

export function renderReport(usage: PlanUsage, details: ReportDetails, formatReset = resetTime): string {
  const account = details.account;
  const lines = [
    [account?.subscriptionType ?? usage.subscription ?? "Claude plan unknown", account?.email, account?.organization].filter(Boolean).join(" · "),
  ];
  if (details.accountProblem) lines.push(`Account: ${details.accountProblem}`);
  if (account && !account.subscriptionType && !usage.subscription) lines.push("No Claude subscription reported; sign in with claude auth login.");
  if (!usage.limits.length) lines.push(usage.source === "report" ? "No plan limits reported." : "Plan usage unavailable.");
  let group: string | undefined;
  for (const row of usage.limits) {
    if (row.group && row.group !== group) {
      const heading = words(row.group);
      lines.push(`${heading.charAt(0).toUpperCase()}${heading.slice(1)}:`);
    }
    group = row.group;
    lines.push(`${group ? "  " : ""}${row.label}: ${row.percent === undefined ? "usage unknown" : `${Math.round(row.percent)}% used`}${row.reached ? " · limit reached" : ""} · ${row.resetsAt === undefined ? "reset unknown" : `resets ${formatReset(row.resetsAt)}`}`);
  }
  if (usage.source === "event") lines.push("Limits from the last turn; full plan report unavailable.");
  lines.push(`Extra usage: ${usage.extraUsage === undefined ? "unknown" : usage.extraUsage ? "on" : "off"}${usage.extraUsageReason ? ` (${reason(usage.extraUsageReason)})` : ""}`);
  const fast = details.fastMode;
  lines.push(`Fast mode: ${fast ? `${words(fast.state)}${fast.reason ? ` (${fast.state === "unavailable" ? "" : "unavailable: "}${reason(fast.reason)})` : ""}` : "not reported"}`);
  lines.push(`This Pi process: $${details.spend.costUsd.toFixed(4)} estimate at API list prices · ${details.spend.turns} turn${details.spend.turns === 1 ? "" : "s"} · not a bill`);
  lines.push(`${details.openSessions} open Claude Code session${details.openSessions === 1 ? "" : "s"}`);
  if (details.configProblems.length) lines.push(`Configuration (${details.configPath}):`, ...details.configProblems.map(problem => `  ${problem}`));
  return lines.join("\n");
}
