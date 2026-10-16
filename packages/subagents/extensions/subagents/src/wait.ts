import type { Static } from "typebox";
import { REPORT_KINDS, type AgentRecord, type HumanHold, type ReadReceipt, type ResultReview, type Status, type SubagentManager, type Update } from "./manager.js";
import type { TOOL_SPECS } from "./tool-schemas.js";
import { MANAGE_TIMEOUT_MS } from "./peer-transport.js";

export type WaitArgs = Static<typeof TOOL_SPECS.subagent_wait.parameters>;

export const WAKE_REASONS = ["hold", "input", "settled", "message", "timeout"] as const;
export type WakeReason = typeof WAKE_REASONS[number];
export const isWakeReason = (value: unknown): value is WakeReason =>
  (WAKE_REASONS as readonly unknown[]).includes(value);

export interface WaitEnd { readonly wake: WakeReason; readonly ids: readonly string[] }

/** Pi drains a steer after the tool batch and leaves a follow-up queued until the turn ends. */
export function messageLatch(): (pending: boolean) => boolean {
  let reported = false;
  return pending => {
    if (!pending) return reported = false;
    if (reported) return false;
    return reported = true;
  };
}

const RELAY_REPLY_HEADROOM_SECONDS = 30;
export const RELAY_SEGMENT_SECONDS = MANAGE_TIMEOUT_MS / 1000 - RELAY_REPLY_HEADROOM_SECONDS;

/** What the root sends back for a delegated wait: its report, or fitDelegatedReply's preview of one too large for the pipe. */
type RelayedWait = { readonly kind: "report"; readonly wake: WakeReason } | { readonly kind: "truncated" };

const parseRelayed = (reply: unknown): RelayedWait => {
  const fields = typeof reply === "object" && reply !== null ? reply as { wake?: unknown; truncated?: unknown } : {};
  if (fields.truncated === true) return { kind: "truncated" };
  if (isWakeReason(fields.wake)) return { kind: "report", wake: fields.wake };
  throw new Error(`Unexpected reply to a relayed wait: ${String(JSON.stringify(reply)).slice(0, 200)}`);
};

export async function relayWait(manage: (args: WaitArgs, signal?: AbortSignal) => Promise<unknown>,
  args: WaitArgs, signal: AbortSignal | undefined, messageQueued: () => boolean): Promise<unknown> {
  const deadline = args.timeoutSeconds === undefined ? Infinity : Date.now() + args.timeoutSeconds * 1000;
  let queued = false;
  while (Date.now() < deadline && !(queued = messageQueued())) {
    const segment = new AbortController();
    const follow = () => segment.abort(signal?.reason);
    signal?.addEventListener("abort", follow, { once: true });
    const poll = setInterval(() => { if (messageQueued()) { queued = true; segment.abort(); } }, 250);
    let reply: unknown;
    try {
      reply = await manage({ ...args, collect: false,
        timeoutSeconds: Math.min(RELAY_SEGMENT_SECONDS, Math.ceil((deadline - Date.now()) / 1000)) }, segment.signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!queued) throw error;
    } finally {
      clearInterval(poll);
      signal?.removeEventListener("abort", follow);
    }
    if (queued) break;
    const relayed = parseRelayed(reply);
    if (relayed.kind === "truncated" || relayed.wake !== "timeout") break;
  }
  signal?.throwIfAborted();
  const final = await manage({ ...args, timeoutSeconds: 0 }, signal);
  const relayed = parseRelayed(final);
  return queued && relayed.kind === "report" && relayed.wake === "timeout" ? { ...final as object, wake: "message" } : final;
}

export interface Report { readonly kind: string; readonly text: string }

export interface ChildNews {
  readonly id: string;
  readonly name: string;
  readonly status: Status;
  readonly activity?: string;
  readonly error?: string;
  readonly unread: number;
  readonly hold?: Pick<HumanHold, "kind" | "outcome" | "detail">;
  readonly uiRequests?: readonly { readonly id: string; readonly method: string; readonly title?: string }[];
  readonly depth?: number;
  readonly parentId?: string;
  readonly resultReview?: { readonly status: ResultReview["status"] };
  readonly reports?: readonly Report[];
}

export interface WaitReport { readonly wake: WakeReason; readonly agents: readonly ChildNews[] }
export interface ReportLimits { readonly bytes: number; readonly lines: number }

const printed = (value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  return { bytes: Buffer.byteLength(text), lines: text.split("\n").length };
};
const REPORTS_KEY_COST = { bytes: 32, lines: 2 };
const REPORT_LINES = 4, REPORT_INDENT_BYTES = 8, REPORT_SEPARATOR_BYTES = 2;
const reportCost = (report: Report) => ({
  bytes: printed(report).bytes + REPORT_LINES * REPORT_INDENT_BYTES + REPORT_SEPARATOR_BYTES, lines: REPORT_LINES });

const reviewOf = (record: AgentRecord) => record.resultReview && { status: record.resultReview.status };

export const withCurrentReviews = (manager: SubagentManager, report: WaitReport): WaitReport =>
  ({ ...report, agents: report.agents.map(news => ({ ...news, resultReview: reviewOf(manager.get(news.id)) })) });

export function waitReport(manager: SubagentManager, end: WaitEnd, collect: boolean, callerId?: string,
  limits: ReportLimits = { bytes: 24_000, lines: 750 }): { readonly report: WaitReport; readonly receipts: readonly ReadReceipt[] } {
  const statuses = end.ids.map(id => {
    const record = manager.get(id);
    const news: ChildNews = {
      id, name: record.name, status: record.status, activity: record.activity, error: record.error,
      unread: record.updates.filter(update => update.cursor > record.readCursor && REPORT_KINDS.has(update.kind)).length,
      hold: record.hold && { kind: record.hold.kind, outcome: record.hold.outcome, detail: record.hold.detail },
      uiRequests: record.uiRequests.length ? record.uiRequests.map(({ id, method, title }) => ({ id, method, title })) : undefined,
      depth: record.depth, parentId: record.parentId,
      resultReview: reviewOf(record),
    };
    return news;
  });
  if (!collect) return { report: { wake: end.wake, agents: statuses }, receipts: [] };
  const used = printed({ wake: end.wake, agents: statuses });
  let bytes = limits.bytes - used.bytes, lines = limits.lines - used.lines;
  const receipts: ReadReceipt[] = [];
  const agents = statuses.map(news => {
    if (manager.reportsDrainedBy(news.id) !== callerId) return news;
    const page = manager.read(news.id, undefined, false);
    const prefix: Update[] = [], reports: Report[] = [];
    for (const update of page.updates) {
      if (REPORT_KINDS.has(update.kind)) {
        const report = { kind: update.kind, text: update.text };
        const cost = reportCost(report), key = reports.length ? { bytes: 0, lines: 0 } : REPORTS_KEY_COST;
        if (cost.bytes + key.bytes > bytes || cost.lines + key.lines > lines) break;
        bytes -= cost.bytes + key.bytes; lines -= cost.lines + key.lines;
        reports.push(report);
      }
      prefix.push(update);
    }
    if (!prefix.length && !page.uiRequests.length) return news;
    receipts.push({ id: news.id, updates: prefix, nextCursor: prefix.at(-1)?.cursor ?? manager.get(news.id).readCursor, uiRequests: page.uiRequests });
    return { ...news, unread: news.unread - reports.length, reports: reports.length ? reports : undefined };
  });
  return { report: { wake: end.wake, agents }, receipts };
}
