function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function reportedCost(usage: unknown): number | undefined {
  return nonNegative(recordOf(usage)?.cost);
}

/** Compact token count, matching Pi's footer. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Bottom-left Pi footer stats. Zero token and cost parts are omitted, as in
 * the footer. Missing fields are omitted rather than shown as zero. `(sub)`
 * is not included: session stats do not report subscription billing.
 */
export function formatFooterStats(usage: unknown): string {
  const record = recordOf(usage);
  if (!record) return "";
  const tokens = recordOf(record.tokens);
  const parts: string[] = [];
  const input = tokens ? nonNegative(tokens.input) : undefined;
  const output = tokens ? nonNegative(tokens.output) : undefined;
  const cacheRead = tokens ? nonNegative(tokens.cacheRead) : undefined;
  const cacheWrite = tokens ? nonNegative(tokens.cacheWrite) : undefined;
  if (input) parts.push(`↑${formatTokens(input)}`);
  if (output) parts.push(`↓${formatTokens(output)}`);
  if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
  const cacheHit = nonNegative(record.cacheHitRate);
  if ((cacheRead || cacheWrite) && cacheHit !== undefined) parts.push(`CH${cacheHit.toFixed(1)}%`);
  const cost = reportedCost(usage);
  if (cost) parts.push(`$${cost.toFixed(3)}`);
  const context = recordOf(record.contextUsage);
  const contextWindow = context ? nonNegative(context.contextWindow) : undefined;
  if (context && contextWindow) {
    const percent = context.percent;
    let percentLabel: string | undefined;
    if (percent === null || percent === undefined) percentLabel = "?";
    else {
      const value = nonNegative(percent);
      if (value !== undefined) percentLabel = `${value.toFixed(1)}%`;
    }
    if (percentLabel) parts.push(`${percentLabel}/${formatTokens(contextWindow)}${record.autoCompaction === true ? " (auto)" : ""}`);
  }
  return parts.join(" ");
}

/** Keep footer-only fields when a session-stats snapshot replaces usage. */
export function retainFooterExtras(previous: unknown, stats: unknown): unknown {
  if (!stats || typeof stats !== "object") return stats;
  const prev = recordOf(previous);
  const extras: { cacheHitRate?: number; autoCompaction?: boolean } = {};
  const rate = nonNegative(prev?.cacheHitRate);
  if (rate !== undefined) extras.cacheHitRate = rate;
  if (typeof prev?.autoCompaction === "boolean") extras.autoCompaction = prev.autoCompaction;
  return { ...stats, ...extras };
}

/** Latest prompt cache-hit rate, using the same inputs as the footer. */
export function noteAssistantCacheHit(usage: unknown, message: unknown): unknown {
  const measured = recordOf(recordOf(message)?.usage);
  if (!measured) return usage;
  const input = nonNegative(measured.input);
  const cacheRead = nonNegative(measured.cacheRead);
  const cacheWrite = nonNegative(measured.cacheWrite);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return usage;
  const current = { ...(recordOf(usage) ?? {}) };
  const prompt = input + cacheRead + cacheWrite;
  if (prompt <= 0) {
    delete current.cacheHitRate;
    return current;
  }
  return { ...current, cacheHitRate: (cacheRead / prompt) * 100 };
}

export function noteAutoCompaction(usage: unknown, enabled: unknown): unknown {
  if (typeof enabled !== "boolean") return usage;
  return { ...(recordOf(usage) ?? {}), autoCompaction: enabled };
}

/** Each entry contains its child's latest cumulative session snapshot. */
export function summarizeAgents(records: readonly { status: string; pid?: number; usage?: unknown; unread?: number }[]) {
  return {
    tracked: records.length,
    live: records.filter(r => r.pid !== undefined).length,
    active: records.filter(r => ["starting", "working", "waiting_input"].includes(r.status)).length,
    reportedCost: records.reduce((sum, r) => sum + (reportedCost(r.usage) ?? 0), 0),
    missingCost: records.filter(r => reportedCost(r.usage) === undefined).length,
    unreadReports: records.reduce((sum, r) => sum + (r.unread ?? 0), 0),
  };
}
