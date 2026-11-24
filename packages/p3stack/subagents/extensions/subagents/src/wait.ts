import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { HumanHold, ReadReceipt, ResultReview, Status, SubagentManager, Update } from "./manager.js";
import { REPORT_KINDS, updateWindow } from "./read-page.js";
export const BUSY = new Set<Status>(["starting", "working", "waiting_input", "stopping"]);
import type { TOOL_SPECS } from "./tool-schemas.js";
import { MANAGE_TIMEOUT_MS } from "./peer-transport.js";

export type WaitArgs = Static<typeof TOOL_SPECS.subagent_wait.parameters>;

export const DEFAULT_WAIT_MODE = "any" as const;
export const WAKE_REASONS = ["hold", "input", "settled", "child_message", "message", "timeout"] as const;
export type WakeReason = typeof WAKE_REASONS[number];
export const isWakeReason = (value: unknown): value is WakeReason =>
  (WAKE_REASONS as readonly unknown[]).includes(value);

export interface WaitEnd { readonly wake: WakeReason; readonly ids: readonly string[] }

/** Pi drains a steer after the tool batch and leaves a follow-up queued until the turn ends. */
export function messageLatch(pi?: Pick<ExtensionAPI, "on">): (pending: boolean) => boolean {
  let reported = false;
  // Pi removes delivered steers/follow-ups before message_start. There need
  // not be another wait between that delivery and the next queued message.
  pi?.on("message_start", event => { if (event.message.role === "user") reported = false; });
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
  return relayed.kind === "report" && relayed.wake === "timeout" && (queued || messageQueued()) ? { ...final as object, wake: "message" } : final;
}

export type Report = Readonly<Pick<Update, "kind" | "text" | "truncated" | "fullLength" | "readFull">>;

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
const REPORT_INDENT_BYTES = 8, REPORT_SEPARATOR_BYTES = 2;
const reportCost = (report: Report) => {
  const { bytes, lines } = printed(report);
  return { bytes: bytes + lines * REPORT_INDENT_BYTES + REPORT_SEPARATOR_BYTES, lines };
};

export const withCurrentReviews = (manager: SubagentManager, report: WaitReport): WaitReport =>
  ({ ...report, agents: report.agents.map(news => ({ ...news, resultReview: manager.inbox.reviewStatus(news.id) })) });
const FINAL_TERMINAL = new Set(["error", "failure", "input_requested", "human_intervention"]);
type ReportPlan = { mode: "prefix" } | { mode: "skip" } | { mode: "one"; cursor?: number };

function reportPlan(updates: readonly Update[], final: boolean, status: Status): ReportPlan {
  if (!final) return { mode: "prefix" };
  const reports = updates.filter(update => REPORT_KINDS.has(update.kind));
  const last = reports.at(-1);
  if (BUSY.has(status) && !(last && FINAL_TERMINAL.has(last.kind))) {
    return reports.some(update => update.kind === "message") ? { mode: "prefix" } : { mode: "skip" };
  }
  return { mode: "one", cursor: last?.cursor };
}

const displayReport = (update: Update): Report => ({
  kind: update.kind, text: update.text,
  ...(update.truncated ? { truncated: true, fullLength: update.fullLength, readFull: update.readFull } : {}),
});

function takePage(updates: readonly Update[], plan: Exclude<ReportPlan, { mode: "skip" }>, budget: { bytes: number; lines: number }) {
  const prefix: Update[] = [], reports: Report[] = [];
  if (plan.mode === "prefix") {
    for (const update of updates) {
      if (REPORT_KINDS.has(update.kind)) {
        const report = displayReport(update);
        const cost = reportCost(report), key = reports.length ? { bytes: 0, lines: 0 } : REPORTS_KEY_COST;
        if (cost.bytes + key.bytes > budget.bytes || cost.lines + key.lines > budget.lines) break;
        budget.bytes -= cost.bytes + key.bytes; budget.lines -= cost.lines + key.lines;
        reports.push(report);
      }
      prefix.push(update);
    }
    return { prefix, reports };
  }
  for (let index = 0; index < updates.length; index++) {
    const update = updates[index];
    if (plan.cursor !== undefined && update.cursor === plan.cursor) {
      const report = displayReport(update);
      const cost = reportCost(report);
      if (cost.bytes + REPORTS_KEY_COST.bytes > budget.bytes || cost.lines + REPORTS_KEY_COST.lines > budget.lines) break;
      budget.bytes -= cost.bytes + REPORTS_KEY_COST.bytes; budget.lines -= cost.lines + REPORTS_KEY_COST.lines;
      reports.push(report);
      prefix.push(...updates.slice(index));
      break;
    }
    prefix.push(update);
  }
  return { prefix, reports };
}

export function fitWaitUpdates(unread: Update[], final: boolean, status: Status, budget: ReportLimits) {
  const plan = reportPlan(unread, final, status);
  if (plan.mode === "skip") return;
  // A chosen final may be past the ordinary update window.
  return takePage(plan.mode === "one" && plan.cursor !== undefined ? unread : updateWindow(unread), plan, budget);
}

export function waitReport(manager: SubagentManager, end: WaitEnd, collect: boolean, callerId?: string,
  limits: ReportLimits = { bytes: 24_000, lines: 750 }, final = false) {
  const statuses = end.ids.map(id => manager.inbox.news(id));
  const used = printed({ wake: end.wake, agents: statuses });
  const budget = { bytes: limits.bytes - used.bytes, lines: limits.lines - used.lines };
  const receipts: ReadReceipt[] = [];
  const agents = !collect ? statuses : statuses.map(news => {
    const page = manager.inbox.prepareWaitPage(news.id, callerId, final, budget);
    if (!page) return news;
    receipts.push(page.receipt);
    const acknowledged = page.receipt.updates.filter(update => REPORT_KINDS.has(update.kind)).length;
    return { ...news, unread: news.unread - acknowledged, reports: page.reports.length ? page.reports : undefined };
  });
  const report: WaitReport = { wake: end.wake, agents };
  return { report, receipts, acknowledge() {
    for (const receipt of receipts) manager.inbox.acknowledgeRead(receipt, true, !callerId);
    return withCurrentReviews(manager, report);
  } };
}
