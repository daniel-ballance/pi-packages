import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { LiveActivity } from "./activity.js";
import type { AgentRecord, Status, Update } from "./manager.js";
import type { WorkflowRun } from "./workflows.js";
import { formatFooterStats, reportedCost } from "./usage.js";

export type CardState = "starting" | "working" | "waiting" | "held" | "failed" | "unread" | "reviewed" | "stopped";
/** Inspector overview sections. `history` rows live on the history page. */
export type Group = "attention" | "working" | "results" | "history";
export type StateRole = "accent" | "warning" | "error" | "success" | "dim";
export interface StateStyle { readonly glyph: string; readonly word: string; readonly role: StateRole; readonly group: Group }

/** The package's one glyph table. Glyph, word, colour and overview group of a state are one row, so they cannot disagree. */
export const STATES: { readonly [S in CardState]: StateStyle } = {
  starting: { glyph: "○", word: "starting", role: "accent", group: "working" },
  working: { glyph: "●", word: "working", role: "accent", group: "working" },
  waiting: { glyph: "?", word: "waiting", role: "warning", group: "attention" },
  held: { glyph: "=", word: "held", role: "warning", group: "attention" },
  failed: { glyph: "!", word: "failed", role: "error", group: "attention" },
  unread: { glyph: "*", word: "unread", role: "warning", group: "results" },
  reviewed: { glyph: "✓", word: "reviewed", role: "success", group: "history" },
  stopped: { glyph: "·", word: "stopped", role: "dim", group: "history" },
};
export const LEGEND = Object.values(STATES).map(style => `${style.glyph} ${style.word}`).join(" · ");

/** Whether the reader of a child's reports has seen its latest result. One field, so "unread and reviewed" cannot be expressed. */
export type Review = "unread" | "reviewed" | "none";

interface StateFacts { readonly status: Status; readonly held: boolean; readonly errored: boolean; readonly review: Review }

function deriveState({ status, held, errored, review }: StateFacts): CardState {
  if (held) return "held";
  if (status === "failed" || errored) return "failed";
  if (status === "waiting_input") return "waiting";
  if (status === "starting" || status === "working") return status;
  if (review === "unread") return "unread";
  return status === "idle" && review === "reviewed" ? "reviewed" : "stopped";
}

const WORK_STATES = new Map<string, CardState>([
  ["running", "working"], ["working", "working"], ["starting", "working"],
  ["passed", "reviewed"], ["succeeded", "reviewed"], ["completed", "reviewed"],
  ["blocked", "waiting"], ["approval", "waiting"], ["waiting", "waiting"], ["waiting_input", "waiting"],
  ["paused", "held"], ["pausing", "held"],
  ["failed", "failed"], ["error", "failed"], ["exhausted", "failed"], ["interrupted", "failed"],
]);
/** Glyph and colour for workflow step, attempt and tool statuses, whose own status word stays in their row text. */
export function workState(status: string): CardState {
  return WORK_STATES.get(status) ?? "stopped";
}

export interface ModelBadge {
  /** `provider/id`, as the child reported it. */
  readonly full: string;
  /** Provider and family noise dropped, for badges. */
  readonly short: string;
  readonly effort?: string;
}
export interface Elapsed {
  readonly ms: number;
  /** The run finished without a finish time, so the end is the last observed update. */
  readonly lastObserved: boolean;
}

/** One child as every surface sees it. Every string is sanitized single-line text. */
export interface AgentCard {
  readonly kind: "agent";
  readonly id: string;
  /** Lowercased, at most 120 cells, falling back to the id. */
  readonly name: string;
  /** 0 for a child of the root parent. */
  readonly depth: number;
  readonly parentId?: string;
  readonly delegator?: string;
  readonly state: CardState;
  readonly review: Review;
  readonly model?: ModelBadge;
  /** What the child is doing, or what its last run came to. "" when nothing beyond the state word is known. */
  readonly activity: string;
  readonly elapsed?: Elapsed;
  readonly turns?: number;
  /** Absent, never zero, when unknown. */
  readonly cost?: number;
  /** Pi footer-style usage, "" when unavailable. */
  readonly stats: string;
}
/** A workflow run in the inspector overview. It has no model, metrics or delegator. */
export interface RunCard {
  readonly kind: "workflow";
  readonly id: string;
  readonly name: string;
  readonly depth: 0;
  readonly state: CardState;
  readonly activity: string;
}
export type Card = AgentCard | RunCard;

export interface RecordView {
  readonly live?: LiveActivity;
  /** Display name of the record's parent, when that record is in view. */
  readonly delegator?: string;
  readonly now: number;
}

type Data = Record<string, unknown>;
type Request = { readonly title?: unknown; readonly method?: unknown };
interface AgentFacts {
  readonly id: unknown;
  readonly name: unknown;
  readonly depth?: number;
  readonly parentId?: string;
  readonly delegator?: unknown;
  readonly status: Status;
  readonly hold?: { readonly kind?: unknown; readonly outcome?: unknown; readonly detail?: unknown };
  readonly error?: unknown;
  readonly review: Review;
  readonly model?: unknown;
  readonly thinking?: unknown;
  readonly activity?: unknown;
  readonly phase?: string;
  readonly requests: readonly Request[];
  readonly outcome?: string;
  /** First line of the latest result. Live records only. */
  readonly result?: string;
  readonly elapsed?: Elapsed;
  readonly usage?: unknown;
}

const REPORT_KINDS = new Set(["assistant", "error", "extension_error", "input_requested", "aborted", "completed", "failure", "human_intervention"]);
const NOTICE_KINDS = new Set(["error", "extension_error", "input_requested", "human_intervention"]);
const RESULT_KINDS = new Set(["assistant", "error", "failure", "aborted", "completed"]);
const STATUSES: ReadonlySet<string> = new Set<Status>(["starting", "working", "waiting_input", "idle", "stopping", "stopped", "failed"]);
const OUTCOMES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** Live AgentRecord → card, for the inspector. Reads the record and never mutates it. */
export function cardFromRecord(record: AgentRecord, view: RecordView): AgentCard {
  const pending = record.updates.filter(update => update.cursor > record.readCursor);
  // A review settles the routine reports; anything that needs the parent's attention reopens it.
  const review: Review = record.resultReview
    ? record.resultReview.status === "unreviewed" || pending.some(update => NOTICE_KINDS.has(update.kind)) ? "unread" : "reviewed"
    : pending.some(update => REPORT_KINDS.has(update.kind)) ? "unread" : "none";
  const result = resultUpdate(record);
  return agentCard({
    id: record.id, name: record.name, depth: record.depth, parentId: record.parentId, delegator: view.delegator,
    status: record.status, hold: record.hold, error: record.error, review,
    model: record.model ?? record.config.model, thinking: record.thinking ?? record.config.thinking,
    activity: record.activity, phase: view.live?.phase, requests: record.uiRequests,
    outcome: outcomeOf(record.assignment, record.aborted),
    result: result && (result.kind === "assistant" ? firstLine(result.text) : `${result.kind}: ${firstLine(result.text)}`),
    elapsed: elapsedOf(record.assignment, record, record.status === "working" ? view.now : undefined),
    usage: record.usage,
  });
}

/**
 * Tool-result JSON → cards. `summary` is list()/summary() items, `read` one read() page. Items without a known
 * status are skipped, so the caller falls back to its raw preview. No clock and no live lookup: a tool-result
 * card is a snapshot.
 */
export function cardsFromDetails(items: readonly unknown[], shape: "summary" | "read"): AgentCard[] {
  const names = new Map(items.map(object).map(item => [inline(item?.id), item?.name] as const));
  return items.flatMap(raw => {
    const item = object(raw);
    if (!item || !isStatus(item.status)) return [];
    const assignment = object(item.assignment), resultReview = object(item.resultReview);
    const parentId = inline(item.parentId) || undefined;
    // The read page is pre-acknowledgement, but subagent_read acknowledges it right after this render
    // unless the result spilled, and a spilled result draws no card.
    const review: Review = shape === "read"
      ? item.hasMore === true ? "unread" : resultReview ? "reviewed" : "none"
      : count(item.unread) || resultReview?.status === "unreviewed" ? "unread" : resultReview?.status === "reviewed" ? "reviewed" : "none";
    return [agentCard({
      id: item.id, name: item.name, depth: count(item.depth), parentId, delegator: parentId && (names.get(parentId) ?? parentId),
      status: item.status, hold: object(item.hold), error: item.error, review, model: item.model, thinking: item.thinking,
      activity: item.activity, requests: array(item.uiRequests).map(object).filter((request): request is Data => !!request),
      outcome: outcomeOf(assignment, item.aborted), elapsed: elapsedOf(assignment, item), usage: item.usage,
    })];
  });
}

/** Workflow run → card, so run rows share the agent glyph table and overview grouping. */
export function runCard(run: WorkflowRun, workers: readonly AgentRecord[]): RunCard {
  const steps = Object.values(run.steps);
  const approval = steps.some(step => step.status === "approval");
  const held = !!run.interventionHold || workers.some(worker => worker.hold);
  const active = workers.filter(worker => ["starting", "working", "waiting_input"].includes(worker.status)).length;
  const activity = `${approval ? "approval needed" : run.status}${held ? " · intervention hold" : ""} · ` +
    `${steps.filter(step => step.status === "passed").length}/${run.definition.steps.length} steps · ` +
    `${active} active worker${active === 1 ? "" : "s"}${run.unread ? " · parent review needed" : ""}`;
  return { kind: "workflow", id: run.id, name: fit(inline(run.definition.name).toLowerCase(), 120) || inline(run.id),
    depth: 0, state: runState(run, held, approval), activity: fit(inline(activity), 160) };
}

function runState(run: WorkflowRun, held: boolean, approval: boolean): CardState {
  if (held) return "held";
  switch (run.status) {
    case "running": return approval ? "waiting" : "working";
    case "blocked": return "waiting";
    case "pausing": case "paused": return "held";
    case "exhausted": return "failed";
    case "succeeded": return run.unread ? "unread" : "reviewed";
    case "cancelled": return run.unread ? "unread" : "stopped";
  }
}

/** The record's latest result as `kind: text`, or a placeholder sentence. */
export function latestResult(record: AgentRecord): string {
  const update = resultUpdate(record);
  if (update) return `${update.kind}: ${update.text}`;
  return record.assignment?.status === "running" && !record.assignment.resultCursor ? "no result for current assignment yet." : "no result reported yet.";
}

function resultUpdate(record: AgentRecord): Update | undefined {
  const assignment = record.assignment;
  if (assignment?.status === "running" && !assignment.resultCursor) return undefined;
  return assignment?.resultCursor
    ? record.updates.find(update => update.cursor === assignment.resultCursor)
    : record.updates.findLast(update => RESULT_KINDS.has(update.kind));
}

function agentCard(facts: AgentFacts): AgentCard {
  const state = deriveState({ status: facts.status, held: !!facts.hold, errored: !!inline(facts.error), review: facts.review });
  const model = inline(facts.model);
  const usage = object(facts.usage);
  return {
    kind: "agent", id: inline(facts.id), name: fit(inline(facts.name).toLowerCase(), 120) || inline(facts.id) || "subagent",
    depth: Math.max(0, (facts.depth ?? 1) - 1), parentId: facts.parentId,
    delegator: fit(inline(facts.delegator).toLowerCase(), 120) || undefined,
    state, review: facts.review,
    model: model ? { full: model, short: shortModel(model), effort: inline(facts.thinking) || undefined } : undefined,
    activity: activityOf(state, facts), elapsed: facts.elapsed,
    turns: count(usage?.assistantMessages), cost: reportedCost(usage), stats: formatFooterStats(usage),
  };
}

function activityOf(state: CardState, facts: AgentFacts): string {
  const text = (() => {
    switch (state) {
      case "starting": case "working": return facts.phase ?? facts.activity;
      case "waiting": {
        const [first, ...more] = facts.requests;
        if (!first) return facts.activity;
        return `needs input: ${inline(first.title) || inline(first.method) || "request"}${more.length ? ` (+${more.length} more)` : ""}`;
      }
      case "held": return [[inline(facts.hold?.kind), inline(facts.hold?.outcome)].filter(Boolean).join(" "), inline(facts.hold?.detail)].filter(Boolean).join(" · ");
      case "failed": return firstLine(facts.error) || facts.activity;
      default: return facts.status === "stopping" ? "stopping" : facts.result || facts.outcome;
    }
  })();
  const line = fit(inline(text), 160);
  // The manager's coarse `Working` only repeats the state word.
  return line.toLowerCase() === STATES[state].word ? "" : line;
}

function outcomeOf(assignment: { status?: unknown } | undefined, aborted: unknown): string | undefined {
  if (aborted === true) return "cancelled";
  return typeof assignment?.status === "string" && OUTCOMES.has(assignment.status) ? assignment.status : undefined;
}

/**
 * From assignment.at ?? startedAt ?? createdAt. A settled assignment ends at its finish (else the last
 * observed update), a running one at `clock` when given, else at the last observed update. A read page
 * carries no record times, so only a finished assignment gets a duration there.
 */
function elapsedOf(assignment: { at?: unknown; status?: unknown; finishedAt?: unknown } | undefined,
  record: { startedAt?: unknown; createdAt?: unknown; updatedAt?: unknown }, clock?: number): Elapsed | undefined {
  const settled = !!assignment && assignment.status !== "running";
  const end = settled ? time(assignment.finishedAt ?? record.updatedAt) : clock ?? time(record.updatedAt);
  const ms = end - time(assignment?.at ?? record.startedAt ?? record.createdAt);
  return Number.isFinite(ms) ? { ms: Math.max(0, ms), lastObserved: settled && !assignment.finishedAt } : undefined;
}

const MODEL_SUFFIXES = [/-(?:next|latest|preview)$/, /-\d{8}$/, /-[wa]\d+b$/i];
/** `claude-subscription/claude-opus-5-5` → `opus-5-5`. Size suffixes (`-70b`) stay: they name a different model. */
function shortModel(full: string): string {
  let id = full.slice(full.lastIndexOf("/") + 1).replace(/^claude-/, "");
  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of MODEL_SUFFIXES) if (suffix.test(id)) { id = id.replace(suffix, ""); changed = true; }
  }
  return fit(id || full, 24);
}

export type Role = "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error";
export interface Span { readonly text: string; readonly role: Role; readonly bold?: true }
/** One laid-out line. `text` is the spans' concatenation, so plain text cannot drift from what is painted. */
export interface Line { readonly text: string; readonly spans: readonly Span[] }

const MIN_NAME = 8;
const MIN_TAIL = 8;
const MIN_HEAD = 12;

/**
 * Inspector row: `<indent>▎ <glyph> <name> [<model> <effort>] <activity> · from <delegator>`. `metrics` adds turns
 * and cost after the activity, for the agent page header. Casualties, first to last: the delegator drops whole,
 * the activity shrinks to 8 cells and then drops, the name shrinks to 8 cells, then the badge drops whole.
 */
export function railLine(card: Card, columns: number, metrics = false): Line {
  const style = STATES[card.state];
  const indent = "  ".repeat(card.depth);
  const fixed = visibleWidth(`${indent}▎ ${style.glyph} `);
  const badge = card.kind === "workflow" ? "[workflow]" : card.model ? `[${badgeText(card.model, " ")}]` : "";
  const head = [card.activity, ...(metrics && card.kind === "agent" ? [turnsText(card.turns), moneyText(card.cost)] : [])].filter(Boolean).join(" · ");
  const from = card.kind === "agent" && card.delegator ? `from ${card.delegator}` : "";
  const tail = [head, from].filter(Boolean).join(" · ");
  const room = columns - fixed - visibleWidth(card.name) - (badge ? 1 + visibleWidth(badge) : 0) - 1;
  const keep = !!tail && room >= Math.min(MIN_TAIL, visibleWidth(head || tail));
  const shown = keep ? { name: card.name, badge } : nameAndBadge(card.name, badge, columns - fixed, 1);
  const rest = keep ? fit(visibleWidth(tail) <= room ? tail : head || tail, room) : "";
  return line([
    { text: indent, role: "text" }, { text: "▎", role: style.role }, { text: " ", role: "text" }, { text: style.glyph, role: style.role },
    { text: " ", role: "text" }, { text: shown.name, role: "text", bold: true },
    ...(shown.badge ? [{ text: " ", role: "text" }, { text: shown.badge, role: "accent" }] as const : []),
    ...(rest ? [{ text: " ", role: "text" }, { text: rest, role: "dim" }] as const : []),
  ], columns);
}

/**
 * Tool-result card: `<glyph> <name> <word>   <model> · <effort>`, then `↳ from <delegator> · <activity> · <elapsed> ·
 * N turns · $cost` when there is anything to say. Line 1 shrinks the name to 8 cells, then drops the badge whole.
 * Line 2 drops the delegator, shrinks the activity to 12 cells, then drops elapsed and turns. Cost goes last.
 */
export function cardLines(card: AgentCard, columns: number): Line[] {
  const style = STATES[card.state];
  const indent = "  ".repeat(card.depth);
  const fixed = visibleWidth(`${indent}${style.glyph}  ${style.word}`);
  const { name, badge } = nameAndBadge(card.name, card.model ? badgeText(card.model, " · ") : "", columns - fixed, 2);
  const first = line([
    { text: indent, role: "text" }, { text: style.glyph, role: style.role }, { text: " ", role: "text" }, { text: name, role: "text", bold: true },
    { text: " ", role: "text" }, { text: style.word, role: style.role },
    ...(badge ? [{ text: " ".repeat(columns - fixed - visibleWidth(name) - visibleWidth(badge)), role: "text" }, { text: badge, role: "muted" }] as const : []),
  ], columns);

  const lead = `${indent}↳ `;
  const from = card.delegator ? `from ${card.delegator}` : "";
  const metrics = [card.elapsed ? duration(card.elapsed.ms) : "", turnsText(card.turns), moneyText(card.cost)].filter(Boolean);
  const full = [from, card.activity].filter(Boolean).join(" · ");
  if (!full && !metrics.length) return [first];
  const reserved = () => metrics.length ? visibleWidth(metrics.join(" · ")) + (full ? 3 : 0) : 0;
  let head = visibleWidth(lead) + visibleWidth(full) + reserved() <= columns ? full : card.activity || from;
  if (visibleWidth(lead) + visibleWidth(head) + reserved() > columns) {
    while (metrics.length > 1 && columns - visibleWidth(lead) - reserved() < MIN_HEAD) metrics.shift();
    head = fit(head, Math.max(1, columns - visibleWidth(lead) - reserved()));
  }
  return [first, line([{ text: lead + [head, ...metrics].filter(Boolean).join(" · "), role: "dim" }], columns)];
}

/** `/subagents list` line: no width handling and no colour. Unknown turns and cost are labelled, unlike on cards. */
export function listingLine(card: AgentCard): Line {
  const style = STATES[card.state];
  const usage = card.stats ? card.cost === undefined ? `${card.stats} · cost unknown` : card.stats : moneyText(card.cost) || "cost unknown";
  return line([{ text: [`${style.glyph} ${card.name} (${card.id})`, style.word,
    card.model ? `${card.model.full}:${card.model.effort ?? "unknown"}` : "no model", card.activity,
    card.elapsed ? duration(card.elapsed.ms) : "", turnsText(card.turns) || "turns unknown", usage].filter(Boolean).join(" · "), role: "text" }]);
}

/**
 * The one painter. `highlight` recolours spans whose role is `text` or `dim`, so state and badge colours survive
 * selection. Span text is stripped of controls again here, so a span is safe even if its builder forgot.
 */
export function paint(theme: Pick<Theme, "fg" | "bold">, spans: readonly Span[], highlight?: Role): string {
  return spans.map(span => {
    const styled = theme.fg(highlight && (span.role === "text" || span.role === "dim") ? highlight : span.role, plain(span.text).replace(/\n/g, " "));
    return span.bold ? theme.bold(styled) : styled;
  }).join("");
}

/** `30s`, `2m 0s`, `1h 5m`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

// Child names, tasks and output are untrusted terminal text, not ANSI styling.
export const plain = (value: unknown): string => typeof value === "string"
  ? stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") : "";
export const inline = (value: unknown): string => plain(value).replace(/\s+/g, " ").trim();

function line(spans: readonly Span[], columns = Infinity): Line {
  const kept: Span[] = [];
  let used = 0;
  for (const span of spans) {
    if (!span.text) continue;
    const width = visibleWidth(span.text);
    if (used + width > columns) {
      const text = fit(span.text, columns - used);
      if (text) kept.push({ ...span, text });
      break;
    }
    kept.push(span);
    used += width;
  }
  return { text: kept.map(span => span.text).join(""), spans: kept };
}

function nameAndBadge(name: string, badge: string, budget: number, gap: number): { name: string; badge: string } {
  const beside = badge ? visibleWidth(badge) + gap : 0;
  if (visibleWidth(name) + beside <= budget) return { name, badge };
  if (budget - beside >= Math.min(MIN_NAME, visibleWidth(name))) return { name: fit(name, budget - beside), badge };
  return { name: fit(name, budget), badge: "" };
}

// pi-tui wraps its ellipsis in SGR resets; spans stay plain text.
function fit(text: string, columns: number): string {
  return columns <= 0 ? "" : stripVTControlCharacters(truncateToWidth(text, columns, "…")).replace(/\s+…$/, "…");
}

const badgeText = (model: ModelBadge, joiner: string) => model.effort ? `${model.short}${joiner}${model.effort}` : model.short;
const turnsText = (turns?: number) => turns === undefined ? "" : `${turns} ${turns === 1 ? "turn" : "turns"}`;
const moneyText = (cost?: number) => cost === undefined ? "" : `$${cost.toFixed(3)}`;
const firstLine = (value: unknown) => plain(value).split("\n").map(part => part.trim()).find(Boolean) ?? "";
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const isStatus = (value: unknown): value is Status => typeof value === "string" && STATUSES.has(value);
const object = (value: unknown): Data | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
