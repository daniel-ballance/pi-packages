import type { Static } from "typebox";
import { REPORT_KINDS, type HumanHold, type ReadReceipt, type ResultReview, type Status, type SubagentManager, type Update } from "./manager.js";
import type { TOOL_SPECS } from "./tool-schemas.js";

export type WaitArgs = Static<typeof TOOL_SPECS.subagent_wait.parameters>;

/** Why a wait returned, in precedence order: the first that holds wins.
 *  Abort is not a reason. The wait throws, and the tool call ends aborted. */
export const WAKE_REASONS = ["hold", "input", "settled", "message", "timeout"] as const;
export type WakeReason = typeof WAKE_REASONS[number];
export const isWakeReason = (value: unknown): value is WakeReason =>
  (WAKE_REASONS as readonly unknown[]).includes(value);

/** Which children a wait watched, and why it stopped. */
export interface WaitEnd { readonly wake: WakeReason; readonly ids: readonly string[] }

/** Ends at most one wait per queued batch. A steer drains right after the tool batch, so the next wait
 *  starts clean. A follow-up stays queued until the turn ends, and without the latch every later wait in
 *  that turn would return "message" at once. Re-arms when it sees the queue empty. */
export function messageLatch(): (pending: boolean) => boolean {
  let reported = false;
  return pending => {
    if (!pending) return reported = false;
    if (reported) return false;
    return reported = true;
  };
}

/** Seconds per root wait in a relayed wait, inside PeerClient.manage's 90 s per-call budget. */
export const RELAY_SEGMENT_SECONDS = 60;

const wakeOf = (reply: unknown) => {
  const wake = typeof reply === "object" && reply !== null ? (reply as { wake?: unknown }).wake : undefined;
  return isWakeReason(wake) ? wake : undefined;
};

/** A Child's proxied wait: root waits of at most a segment that collect nothing, then one zero-second
 *  wait with the caller's collect. Only that last call acknowledges, so a segment cancelled for a queued
 *  message loses no report. Only the Child sees its own queue, so it alone can say "message". */
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
    // A truncated reply has no wake: treat it as news rather than wait blind.
    if (queued || wakeOf(reply) !== "timeout") break;
  }
  signal?.throwIfAborted();
  const final = await manage({ ...args, timeoutSeconds: 0 }, signal);
  return queued && wakeOf(final) === "timeout" ? { ...final as object, wake: "message" } : final;
}

export interface Report { readonly kind: string; readonly text: string }

/** What an agent acts on after a wait. subagent_list and subagent_read keep the rest. */
export interface ChildNews {
  readonly id: string;
  readonly name: string;
  readonly status: Status;
  readonly activity?: string;
  readonly error?: string;
  /** Reports this result does not include: collect was false, they go to another caller, or they did not fit. */
  readonly unread: number;
  readonly hold?: Pick<HumanHold, "kind" | "outcome" | "detail">;
  readonly uiRequests?: readonly { readonly id: string; readonly method: string; readonly title?: string }[];
  readonly depth?: number;
  readonly parentId?: string;
  readonly resultReview?: { readonly status: ResultReview["status"] };
  /** New reports, oldest first, acknowledged by this result. */
  readonly reports?: readonly Report[];
}

export interface WaitReport { readonly wake: WakeReason; readonly agents: readonly ChildNews[] }
export interface ReportLimits { readonly bytes: number; readonly lines: number }

const printed = (value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  return { bytes: Buffer.byteLength(text), lines: text.split("\n").length };
};
// A report prints eight spaces deep (inside agents, a child, then reports), takes four lines, and is
// joined to the next by a comma and a newline. The reports key and its brackets take two more lines.
const REPORTS_KEY = { bytes: 32, lines: 2 };
const reportCost = (report: Report) => ({ bytes: printed(report).bytes + 4 * 8 + 2, lines: 4 });

/** Builds the payload from manager state right after a wait. Reads only: the caller acknowledges
 *  `receipts` once the payload went out whole, so a result spilled to a file acknowledges nothing.
 *  Reports are collected only for children whose routine reports drain to this caller. */
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
      resultReview: record.resultReview && { status: record.resultReview.status },
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
        const cost = reportCost(report), key = reports.length ? { bytes: 0, lines: 0 } : REPORTS_KEY;
        if (cost.bytes + key.bytes > bytes || cost.lines + key.lines > lines) break;
        bytes -= cost.bytes + key.bytes; lines -= cost.lines + key.lines;
        reports.push(report);
      }
      prefix.push(update);
    }
    if (!prefix.length && !page.uiRequests.length) return news;
    const record = manager.get(news.id), assignment = record.assignment;
    receipts.push({ id: news.id, updates: prefix, nextCursor: prefix.at(-1)?.cursor ?? record.readCursor, uiRequests: page.uiRequests });
    // Predicts acknowledgeRead, so the card draws a child whose result this returns as reviewed.
    const reviewed = news.resultReview?.status === "unreviewed" && assignment?.id === record.resultReview?.assignmentId
      && prefix.some(update => update.cursor === assignment?.resultCursor);
    return { ...news, unread: news.unread - reports.length, reports: reports.length ? reports : undefined,
      resultReview: reviewed ? { status: "reviewed" as const } : news.resultReview };
  });
  return { report: { wake: end.wake, agents }, receipts };
}
