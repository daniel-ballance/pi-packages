import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, truncateHead, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export function result(data: Record<string, unknown>, ctx: ExtensionContext) {
  const text = JSON.stringify(data, null, 2);
  const preview = truncateHead(text, { maxBytes: 28000, maxLines: 980 });
  if (!preview.truncated) return { content: [{ type: "text" as const, text }], details: data };
  const directory = join(getAgentDir(), "t3-subagents", ctx.sessionManager.getSessionId(), "results");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `result-${randomUUID()}.json`);
  writeFileSync(path, text, { mode: 0o600 });
  const details = { truncated: true, fullResult: path, taskId: data.taskId, status: data.status,
    workState: data.workState, hasPendingChildRuns: data.hasPendingChildRuns };
  const bounded = truncateHead(`${preview.content}\n[Truncated. Full untrusted T3 result: ${path}]`, { maxBytes: 30000, maxLines: 1000 });
  return { content: [{ type: "text" as const, text: bounded.content }], details };
}
