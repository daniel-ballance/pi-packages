export function reportedCost(usage: unknown): number | undefined {
  const value = usage && typeof usage === "object" && "cost" in usage ? usage.cost : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One assistant response (including tool-calling responses) counts as a turn. */
export function formatAgentListing(record: { id: string; name: string; status: string; model?: string; thinking?: string; usage?: unknown }) {
  const usage = record.usage;
  const turns = usage && typeof usage === "object" && "assistantMessages" in usage ? usage.assistantMessages : undefined;
  const turnLabel = typeof turns === "number" && Number.isInteger(turns) && turns >= 0
    ? `${turns} ${turns === 1 ? "turn" : "turns"}` : "turns unknown";
  const cost = reportedCost(usage);
  const model = record.model ? `${record.model}:${record.thinking ?? "unknown"}` : "no model";
  return `${record.id} · ${record.name} · ${record.status} · ${model} · ${turnLabel} · ${cost === undefined ? "cost unknown" : `$${cost.toFixed(3)}`}`;
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
