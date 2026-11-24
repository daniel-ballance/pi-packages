import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentRecord } from "./manager.js";
import type { Packet } from "./rpc.js";
import { fitUpdateRead, reportPage, REPORT_KINDS, updateWindow, type ReadArgs } from "./read-page.js";
import { ensurePrivateDirectory } from "./registry.js";
import { fitWaitUpdates, type ChildNews, type ReportLimits } from "./wait.js";

export interface Update { cursor: number; kind: string; text: string; time: string; truncated?: true; fullLength?: number; readFull?: ReadArgs; assignmentId?: string; consumed?: true }
export interface SavedReport { assignmentId?: string; updateCursor: number; fullLength: number; reviewed?: true; file?: string; text?: string }
const SAVED_REPORTS = 100;
const DISPLAY_CHARS = 12_000;
// Even worst-case JSON escaping fits a page inside both tool and private-pipe limits.
const PAGE_CHARS = 4_000;
export interface Notice { id: string; name: string; kind: string; text: string; cursor: number; key: string; requestId?: string; assignmentId?: string; fullLength?: number; readFull?: ReadArgs }
export interface ReadReceipt { id: string; updates: Update[]; nextCursor: number; uiRequests: Packet[] }

/** Report bodies, read cursors and the durable queue of notices for one parent session. */
export class ReportInbox {
  private notices = new Map<string, Notice>();
  constructor(private options: {
    directory: string;
    lookup: (id: string) => AgentRecord | undefined;
    attached: (id: string) => boolean;
    mayAnnounce: (id: string, kind: string) => boolean;
    persist: (...changed: AgentRecord[]) => void;
    notify: (notice: Notice) => void;
  }) {}
  private get(id: string) {
    const record = this.options.lookup(id);
    if (!record) throw new Error(`Unknown subagent: ${id}`);
    return record;
  }
  restoreReports(record: AgentRecord) {
    for (const u of record.updates) if (u.readFull) u.readFull = reportPage(record.id, u.cursor); // pre-page registries
    return this.trimReports(record);
  }
  restoreNotices(notices: Notice[]) {
    // Never reconstruct old notices: they may already have been delivered.
    for (const notice of notices) {
      const record = this.options.lookup(notice.id);
      if (record && notice.kind !== "input_requested" && (notice.kind === "human_intervention" || !record.observedCursors?.includes(notice.cursor))) this.notices.set(notice.key, notice);
    }
  }
  savedNotices() { return [...this.notices.values()]; }
  parentStopped(id: string) {
    const released = this.savedNotices().find(notice => this.options.lookup(notice.id)?.parentId === id);
    if (released) this.options.notify(released);
  }
  hasMessage(watched: ReadonlySet<string>, callerId?: string) {
    return this.savedNotices().some(n => n.kind === "message" && watched.has(n.id) && this.reportsDrainedBy(n.id) === callerId);
  }
  dismissRoutine(record: AgentRecord) {
    this.observe(record, this.savedNotices().filter(n => n.id === record.id && n.kind !== "human_intervention").map(n => n.cursor));
    this.options.persist(record);
  }
  private trimReports(record: AgentRecord) {
    const saved = record.savedReports;
    if (!saved || saved.length <= SAVED_REPORTS) return;
    for (const {file} of saved.splice(0, saved.length - SAVED_REPORTS)) {
      if (file && dirname(resolve(file)) === resolve(this.options.directory) && /^[\da-f-]{36}\.report$/.test(basename(file)) && existsSync(file)) unlinkSync(file);
    }
    return true;
  }
  appendUpdate(record: AgentRecord, kind: string, text: string, finalAnswer = false) {
    record.updatedAt = new Date().toISOString();
    const truncated = text.length > DISPLAY_CHARS, assignmentId = record.assignment?.id;
    const cursor = ++record.cursor;
    if (finalAnswer || (REPORT_KINDS.has(kind) && text.length > 600)) {
      const saved: SavedReport = { assignmentId, updateCursor: cursor, fullLength: text.length };
      if (truncated) {
        saved.file = join(this.options.directory, `${randomUUID()}.report`);
        ensurePrivateDirectory(this.options.directory);
        writeFileSync(saved.file, text, { encoding: "utf16le", mode: 0o600, flag: "wx" });
      } else saved.text = text;
      (record.savedReports ??= []).push(saved);
      this.trimReports(record);
    }
    const update: Update = { cursor, kind, text: text.slice(0, DISPLAY_CHARS), time: record.updatedAt, assignmentId,
      ...(truncated ? { truncated: true, fullLength: text.length, ...(REPORT_KINDS.has(kind) ? { readFull: reportPage(record.id, cursor) } : {}) } : {}) };
    record.updates.push(update);
    record.updates = record.updates.slice(-100);
    return update;
  }
  report(record: AgentRecord, kind: string, text: string, noticeKind = kind, requestId?: string) {
    const update = this.appendUpdate(record, kind, text);
    if (requestId !== undefined) {
      const request = record.uiRequests.find(r => r.id === requestId);
      if (request) request.readFull = reportPage(record.id, update.cursor);
    }
    if (!this.announce(record, noticeKind, text, update.cursor, requestId)) this.options.persist(record);
  }
  announce(record: AgentRecord, kind: string, text: string, cursor = record.cursor, requestId?: string) {
    if (!this.options.mayAnnounce(record.id, kind) || (kind !== "human_intervention" && record.observedCursors?.includes(cursor))) return;
    const key = `${record.id}:${cursor}:${kind}`;
    if (this.notices.has(key)) return;
    const saved = record.savedReports?.find(r => r.updateCursor === cursor);
    const fullLength = saved?.fullLength ?? text.length;
    const notice = { id: record.id, name: record.name, kind, text: text.slice(0, 4000), cursor, key, requestId,
      ...(fullLength > 600 && (saved || record.updates.some(u => u.cursor === cursor)) ? {
        assignmentId: saved?.assignmentId ?? record.assignment?.id, fullLength, readFull: reportPage(record.id, cursor),
      } : {}) };
    this.notices.set(key, notice);
    this.options.persist(record);
    // Notification scheduling must not prevent a human cancellation; the queue is durable.
    if (kind === "human_intervention") { try { this.options.notify(notice); } catch { /* retry from persisted queue */ } }
    else if (!this.routedToParent(notice)) this.options.notify(notice); // Wake the delivery scheduler; don't inject into the parent here.
    return notice;
  }
  /**
   * A nested Child's routine report waits for its own parent, which drains it with its
   * proxied tools. It stays queued: if that parent stops before reading it, it reaches
   * the root. Human interventions and input requests (only the root can answer) always do.
   */
  private routedToParent(notice: Notice) {
    if (notice.kind === "human_intervention" || notice.kind === "input_requested") return false;
    return this.reportsDrainedBy(notice.id) !== undefined;
  }
  reportsDrainedBy(id: string): string | undefined {
    const parentId = this.options.lookup(id)?.parentId;
    return parentId && this.options.attached(parentId) ? parentId : undefined;
  }
  /** Notices for the root Parent now. */
  pendingNotices(): Notice[] { return [...this.notices.values()].filter(notice => !this.routedToParent(notice)); }
  /** keepInput: a coordinator's read never settles an input request; only the root can answer it. */
  private observe(record: AgentRecord, cursors: number[], keepInput = false) {
    record.observedCursors = [...new Set([...(record.observedCursors ?? []), ...cursors])].sort((a, b) => a - b).slice(-200);
    const seen = new Set(cursors);
    for (const [key, notice] of this.notices) {
      if (notice.id !== record.id || notice.kind === "human_intervention" || !seen.has(notice.cursor)) continue;
      if (keepInput && notice.kind === "input_requested") continue;
      this.notices.delete(key);
    }
  }
  markNoticesDelivered(keys: string[]) {
    const changed = new Set<AgentRecord>();
    for (const key of keys) {
      const notice = this.notices.get(key);
      if (notice?.kind === "human_intervention") this.notices.delete(key);
      else if (notice) {
        const record = this.get(notice.id);
        this.observe(record, [notice.cursor]);
        changed.add(record);
      }
    }
    this.options.persist(...changed);
  }
  /** byRoot false: a coordinator Child read this through its proxied tools. */
  acknowledgeRead(receipt: ReadReceipt, advanceCursor: boolean, byRoot = true) {
    const record = this.get(receipt.id);
    const cursors = receipt.updates.map(update => update.cursor);
    const requests = new Set(receipt.uiRequests.map(request => request.id));
    for (const notice of this.notices.values()) {
      if (notice.id === record.id && notice.requestId && requests.has(notice.requestId)) cursors.push(notice.cursor);
    }
    this.observe(record, cursors, !byRoot);
    if (receipt.updates.some(u => u.cursor === record.assignment?.resultCursor && !u.truncated)) this.review(record);
    if (advanceCursor) { record.readCursor = Math.max(record.readCursor, receipt.nextCursor); this.advanceConsumed(record); }
    this.options.persist(record);
  }
  private review(record: AgentRecord) {
    if (record.resultReview?.status === "unreviewed" && record.resultReview.assignmentId === record.assignment?.id)
      record.resultReview = { ...record.resultReview, status: "reviewed", at: new Date().toISOString() };
  }
  expireInputNotices(record: AgentRecord) {
    const live = new Set(record.uiRequests.map(request => request.id));
    for (const [key, notice] of this.notices) {
      if (notice.id === record.id && notice.requestId && !live.has(notice.requestId)) this.notices.delete(key);
    }
  }
  wasReviewed(record: AgentRecord, result: Update) {
    return record.observedCursors?.includes(result.cursor) && (!result.truncated || this.savedFinal(record)?.reviewed);
  }
  private savedFinal(record: AgentRecord) {
    return record.savedReports?.findLast(r => r.updateCursor === record.assignment?.resultCursor && r.assignmentId === record.assignment?.id);
  }
  finalAnswer(id: string) {
    const saved = this.savedFinal(this.get(id));
    return saved?.file ? readFileSync(saved.file, "utf16le") : saved?.text;
  }
  readReportPage(id: string, page: string) {
    const record = this.get(id);
    const match = /^(\d+):(\d+)$/.exec(page);
    const cursor = Number(match?.[1]), offset = Number(match?.[2]);
    const saved = record.savedReports?.find(r => r.updateCursor === cursor);
    const update = record.updates.find(u => u.cursor === cursor && REPORT_KINDS.has(u.kind));
    const inline = saved?.text ?? (update && !update.truncated ? update.text : undefined);
    const fullLength = saved?.fullLength ?? inline?.length;
    if (fullLength === undefined || !Number.isSafeInteger(offset) || offset % PAGE_CHARS || offset >= fullLength) throw new Error("Unknown or expired report page");
    // Seek including the adjacent code units so a boundary never splits a surrogate pair.
    const from = Math.max(0, offset - 1), to = Math.min(fullLength, offset + PAGE_CHARS + 1);
    let window: string;
    if (saved?.file) {
      const bytes = Buffer.alloc((to - from) * 2), fd = openSync(saved.file, "r");
      try {
        if (readSync(fd, bytes, 0, bytes.length, from * 2) !== bytes.length) throw new Error("Incomplete saved report");
      } finally { closeSync(fd); }
      window = bytes.toString("utf16le");
    } else window = inline!.slice(from, to);
    const boundary = (n: number) => /[\uD800-\uDBFF]/.test(window.charAt(n - 1)) && /[\uDC00-\uDFFF]/.test(window.charAt(n)) ? n + 1 : n;
    const start = boundary(offset - from), text = window.slice(start, boundary(offset - from + PAGE_CHARS));
    const data = { id, assignmentId: saved?.assignmentId ?? update?.assignmentId, text, offset: from + start, fullLength, truncated: text.length < fullLength,
      resultReview: record.resultReview && structuredClone(record.resultReview), nextRead: from + start + text.length < fullLength ? reportPage(id, cursor, offset + PAGE_CHARS) : undefined };
    return { data, acknowledge: (byRoot = true) => {
      if (data.nextRead) return;
      this.observe(record, [cursor], !byRoot);
      if (saved) saved.reviewed = true;
      if (update) update.consumed = true;
      if (record.assignment?.resultCursor === cursor) this.review(record);
      data.resultReview = record.resultReview && structuredClone(record.resultReview);
      this.advanceConsumed(record);
      this.options.persist(record);
    } };
  }
  private advanceConsumed(record: AgentRecord) {
    for (const update of record.updates) {
      if (update.cursor <= record.readCursor) continue;
      if (!update.consumed) break;
      record.readCursor = update.cursor;
    }
  }
  read(id: string, since?: number, acknowledge = true, allUpdates = false) {
    const record = this.get(id);
    const cursor = since ?? record.readCursor;
    const candidates = record.updates.filter(u => u.cursor > cursor && (since !== undefined || !u.consumed));
    const updates = allUpdates ? candidates : updateWindow(candidates);
    const nextCursor = updates.at(-1)?.cursor ?? cursor;
    const saved = this.savedFinal(record);
    const result = {
      id, name: record.name, status: record.status, activity: record.activity,
      model: record.model, thinking: record.thinking,
      updates, nextCursor, hasMore: record.cursor > nextCursor,
      ...(saved?.file && !saved.reviewed && saved.fullLength > DISPLAY_CHARS ? { readFull: reportPage(id, saved.updateCursor), fullLength: saved.fullLength } : {}),
      gap: record.updates.length > 0 && cursor < record.updates[0].cursor - 1,
      uiRequests: record.uiRequests, sessionFile: record.sessionFile,
      logFile: record.logFile, stderrFile: record.stderrFile, error: record.error,
      hold: record.hold, assignment: record.assignment, resultReview: record.resultReview,
      uncertainSubmission: record.uncertainSubmission,
      coordination: record.config.coordination,
    };
    if (acknowledge) {
      this.acknowledgeRead(result, since === undefined);
      result.resultReview = record.resultReview;
    }
    // Acknowledgement uses the live receipt above; callers only receive a detached page.
    return structuredClone(result);
  }
  prepareRead(id: string, since?: number) {
    const data = fitUpdateRead(this.read(id, since, false, true), since ?? this.get(id).readCursor);
    return { data, acknowledge: (byRoot = true) => {
      this.acknowledgeRead(data, since === undefined, byRoot);
      data.resultReview = structuredClone(this.get(id).resultReview);
    } };
  }
  reviewStatus(id: string) {
    const review = this.get(id).resultReview;
    return review && { status: review.status };
  }
  news(id: string): ChildNews {
    const record = this.get(id);
    return {
      id: record.id, name: record.name, status: record.status, activity: record.activity, error: record.error,
      unread: record.updates.filter(update => update.cursor > record.readCursor && !update.consumed && REPORT_KINDS.has(update.kind)).length,
      hold: record.hold && { kind: record.hold.kind, outcome: record.hold.outcome, detail: record.hold.detail },
      uiRequests: record.uiRequests.length ? record.uiRequests.map(({ id, method, title }) => ({ id, method, title })) : undefined,
      depth: record.depth, parentId: record.parentId,
      resultReview: this.reviewStatus(id),
    };
  }
  prepareWaitPage(id: string, callerId: string | undefined, final: boolean, budget: ReportLimits) {
    if (this.reportsDrainedBy(id) !== callerId) return;
    const record = this.get(id);
    const unread = record.updates.filter(u => u.cursor > record.readCursor && !u.consumed);
    const page = fitWaitUpdates(unread, final, record.status, budget);
    if (!page || (!page.prefix.length && !record.uiRequests.length)) return;
    const receipt: ReadReceipt = structuredClone({ id, updates: page.prefix, nextCursor: page.prefix.at(-1)?.cursor ?? record.readCursor, uiRequests: record.uiRequests });
    return { receipt, reports: structuredClone(page.reports) };
  }
}
