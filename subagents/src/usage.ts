export function reportedCost(usage: unknown): number | undefined {
  const value = usage && typeof usage === "object" && "cost" in usage ? usage.cost : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
