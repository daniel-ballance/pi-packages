import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { RpcChild, RpcRejectedError, type Packet } from "./rpc.js";
import type { ManagementRequest } from "./peer-transport.js";
import { isProxiedTool } from "./nesting.js";
import { ActivityFeed, type LiveActivity } from "./activity.js";
import { allows, capacityOf, OMITTED_CHILD_LIMIT, permanentRefusal, reportedLimit, type ChildLimit } from "./child-limit.js";
import type { Composition } from "./policy.js";
import type { ChildPolicy } from "./child-policy.js";
import { PeerBroker, type PeerState } from "./peers.js";
import { noteAssistantCacheHit, noteAutoCompaction, retainFooterExtras, summarizeAgents } from "./usage.js";
import type { WaitEnd } from "./wait.js";

export type InputDisposition = "started" | "queued" | "handled" | "unknown";
export type Status = "starting" | "working" | "waiting_input" | "idle" | "stopping" | "stopped" | "failed";
export interface SpawnOptions {
  name: string; task: string; cwd: string;
  model?: string; thinking?: string; tools?: string[];
  executable?: string; executableArgs?: string[]; cliArgs?: string[];
  inheritExtensions?: boolean; env?: Record<string, string>;
  selection?: Composition;
  childPolicy?: ChildPolicy;
  /** Internal workflow ownership; not exposed by subagent_spawn. */
  workflow?: string; deferTask?: boolean;
  /** Internal: the Child that spawned this one through its proxied tools. */
  parentId?: string;
  coordination?: { owns?: string[]; outputs?: string[] };
}
export interface Update { cursor: number; kind: string; text: string; time: string }
export type InterventionKind = "halt" | "kill";
export interface HumanHold { kind: InterventionKind; at: string; outcome: "pending" | "confirmed" | "failed"; detail?: string }
export interface Assignment { id: string; task: string; status: "running" | "completed" | "failed" | "cancelled"; at: string; finishedAt?: string; resultCursor?: number }
export interface ResultReview { assignmentId: string; status: "unreviewed" | "reviewed"; at?: string }
export interface AgentRecord {
  id: string; name: string; task: string; status: Status;
  config: Omit<SpawnOptions, "env" | "task" | "name" | "workflow" | "deferTask" | "parentId">;
  /** Set for a Child spawned by another Child; depth 1 is a Child of the root Parent. */
  parentId?: string; depth?: number;
  workflow?: string;
  sessionFile: string; sessionId?: string; logFile: string; stderrFile: string;
  createdAt: string; updatedAt: string; pid?: number;
  model?: string; thinking?: string; activity?: string; error?: string; lastError?: string;
  rejected?: boolean; startedAt?: string;
  usage?: unknown; updates: Update[]; cursor: number; readCursor: number;
  lastSubmission?: { disposition: InputDisposition; at: string };
  uiRequests: Packet[]; hadEnvOverrides: boolean;
  runStartCursor?: number; aborted?: boolean; runRevision?: number;
  observedCursors?: number[];
  hold?: HumanHold; assignment?: Assignment; resultReview?: ResultReview;
  /** Prompt RPC timed out: acceptance might be delayed. Only observed process exit fences it. */
  uncertainSubmission?: { at: string; reason: string };
  /** Accepted follow-ups start a new assignment only when their own run begins. */
  queuedAssignments?: { id: string; task: string; at: string; startAt: number }[];
}
export interface Notice { id: string; name: string; kind: string; text: string; cursor: number; key: string; requestId?: string }
export interface ReadReceipt { id: string; updates: Update[]; nextCursor: number; uiRequests: Packet[] }
export interface SlotReservation { readonly id: symbol }
const MAX_LOG = 20 * 1024 * 1024;
const RESERVED = new Set(["--mode", "-p", "--print", "--session", "--session-dir", "--no-session", "--fork", "-c", "--continue", "-r", "--resume", "--export", "--"]);
const BUSY = new Set<Status>(["starting", "working", "waiting_input", "stopping"]);
export const REPORT_KINDS: ReadonlySet<string> = new Set(["assistant", "error", "extension_error", "input_requested", "aborted", "completed", "failure", "human_intervention"]);
function enforcePrivatePath(path: string, mode: number, directory: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe subagent state path: ${path}`);
  chmodSync(path, mode);
}
function enforcePrivatePathIfPresent(path: string, mode: number, directory: boolean) {
  try { enforcePrivatePath(path, mode, directory); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
// Deliberately narrow: a generic failure mentioning cancellation is still a failure.
export function isCancellationError(message: unknown): boolean {
  return typeof message === "string" && /^(?:AbortError:\s*)?(?:(?:(?:the|this) )?operation (?:was )?aborted|request (?:was )?aborted|aborted|cancelled|canceled)[.!]?$/i.test(message.trim());
}

export class SubagentManager {
  private records = new Map<string, AgentRecord>();
  private activityFeeds = new Map<string, ActivityFeed>();
  private children = new Map<string, RpcChild>();
  private logSizes = new Map<string, number>();
  private shuttingDown = false;
  private verifiedTools = new Map<string, string[]>();
  private notices = new Map<string, Notice>();
  private activeRuns = new Set<string>();
  private workflowChildren = new Set<string>();
  private abortIntents = new Map<string, { revision: number; awaitingStart: boolean }>();
  private aborting = new Set<string>();
  private responding = new Set<string>();
  private submitting = new Map<string, number>();
  private reservations = new Map<SlotReservation, number>();
  private reservedSlots = 0;
  private usageRevision = new Map<string, number>();
  private registry: string;
  private interventionHook?: (record: AgentRecord, kind: InterventionKind) => void;
  /** Install a synchronous parent hook to pause owned workflows before any cancellation awaits. */
  setInterventionHook(hook?: (record: AgentRecord, kind: InterventionKind) => void) { this.interventionHook = hook; }
  private management?: (callerId: string, request: ManagementRequest, signal: AbortSignal) => Promise<unknown>;
  /** Serves the proxied delegation tools of Children that were given them. */
  setManagementHandler(handler?: (callerId: string, request: ManagementRequest, signal: AbortSignal) => Promise<unknown>) { this.management = handler; }
  /** In-flight delegated calls per caller, cancelled when the caller's process exits. */
  private callerCalls = new Map<string, Set<AbortController>>();
  /** Direct Children of id (records, live or not). */
  childrenOf(id: string) { return [...this.records.values()].filter(record => record.parentId === id); }
  /** Whether id is ancestor's Child, grandchild, or deeper. */
  isDescendant(id: string, ancestor: string) { return this.ancestorsOf(id).includes(ancestor); }
  /** id's parent, grandparent, and so on up to a Child of the root Parent. */
  private ancestorsOf(id: string) {
    const ancestors: string[] = [];
    for (let current = this.records.get(id)?.parentId; current && !ancestors.includes(current); current = this.records.get(current)?.parentId) ancestors.push(current);
    return ancestors;
  }
  /** Every record below id, live or not, deepest first. */
  private subtree(id: string): AgentRecord[] {
    return this.childrenOf(id).flatMap(child => [...this.subtree(child.id), child]);
  }
  /** Coordinators whose subtree is being cancelled or closed: they and their descendants delegate nothing meanwhile. */
  private fenced = new Map<string, number>();
  private fence(id: string) { this.fenced.set(id, (this.fenced.get(id) ?? 0) + 1); }
  private unfence(id: string) { const n = (this.fenced.get(id) ?? 1) - 1; if (n) this.fenced.set(id, n); else this.fenced.delete(id); }
  readonly peers: PeerBroker;
  constructor(readonly directory: string, private notice: (notice: Notice) => void = () => {}, private changed: () => void = () => {}, private readonly limit: ChildLimit = OMITTED_CHILD_LIMIT, private authorize?: (config: AgentRecord["config"], depth: number) => AgentRecord["config"], readonly peerMessageLimit = 0) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    enforcePrivatePath(directory, 0o700, true);
    this.registry = join(directory, "registry.json");
    let peerState: PeerState | undefined;
    const recoveredHolds: AgentRecord[] = [];
    let discardedQueuedAssignments = false;
    if (enforcePrivatePathIfPresent(this.registry, 0o600, false)) {
      const stored = JSON.parse(readFileSync(this.registry, "utf8"));
      if (stored.version !== 1 || !Array.isArray(stored.agents)) throw new Error("Unsupported subagent registry");
      peerState = stored.peers;
      for (const record of stored.agents as AgentRecord[]) {
        // Keep old cap-preflight artifacts inspectable, but don't count
        // them as agents by default. Never hide actual process launch failures.
        if (!record.sessionId && !record.startedAt && !existsSync(record.sessionFile) &&
            /^Error: Live-child limit \(\d+\) reached;/.test(record.error ?? "")) record.rejected = true;
        // Old stopped records have no trustworthy assignment outcome: do not infer completion.
        if (record.hold && !["halt", "kill"].includes(record.hold.kind)) delete record.hold;
        if (record.hold?.outcome === "pending" || (record.hold?.kind === "halt" && record.hold.outcome === "confirmed" && record.uncertainSubmission)) {
          record.hold.outcome = "failed";
          record.hold.detail = "Parent restarted without reliable halt confirmation; process detached. Inspect for orphaned work before explicit release.";
          recoveredHolds.push(record);
        }
        if (record.assignment?.status === "running") {
          // Recovery cannot prove completion of a previously active assignment.
          record.assignment.status = record.status === "failed" ? "failed" : "cancelled";
          record.assignment.finishedAt ??= record.updatedAt;
          record.assignment.resultCursor ??= record.cursor;
          record.resultReview ??= { assignmentId: record.assignment.id, status: "unreviewed" };
        }
        record.status = record.status === "failed" ? "failed" : "stopped";
        if (record.status === "stopped" && record.error) {
          record.lastError = record.error; delete record.error;
        }
        delete record.pid;
        if (record.queuedAssignments?.length) discardedQueuedAssignments = true;
        record.queuedAssignments = []; // Interrupted follow-ups are never replayed on explicit resume.
        record.uiRequests = [];
        record.activity = "No process attached. Resume explicitly to continue the saved conversation.";
        enforcePrivatePathIfPresent(record.logFile, 0o600, false);
        enforcePrivatePathIfPresent(record.stderrFile, 0o600, false);
        this.records.set(record.id, record);
      }
      // Old registries have no pending queue: never reconstruct already-sent reports.
      for (const notice of (stored.pendingNotices ?? []) as Notice[]) {
        const record = this.records.get(notice.id);
        if (record && notice.kind !== "input_requested" && (notice.kind === "human_intervention" || !record.observedCursors?.includes(notice.cursor))) this.notices.set(notice.key, notice);
      }
    }
    this.peers = new PeerBroker({
      state: peerState, ceiling: peerMessageLimit, persist: () => this.persist(),
      participant: id => {
        const record = this.get(id);
        if (this.shuttingDown || this.aborting.has(id) || record.hold || record.uncertainSubmission) throw new Error("Peer messaging unavailable during shutdown/abort, human hold or uncertain prompt acceptance");
        if (!record.config.selection?.tools.includes("peer_send") || !record.config.tools?.includes("peer_send")) throw new Error(`${id} did not select peer_send`);
        if (!this.children.has(id) || !["idle", "working"].includes(record.status)) throw new Error(`${id} is not a ready live peer (${record.status}); no implicit resume or human-input bypass`);
        return { name: record.name };
      },
      deliver: (id, text) => this.send(id, text, "steer"),
    });
    for (const record of recoveredHolds) {
      const text = `Human ${record.hold!.kind} for ${record.name} (${record.id}): failed (confirmation interrupted by parent restart). ${record.hold!.detail}`;
      this.update(record, "human_intervention", text);
      this.announce(record, "human_intervention", text);
    }
    if (discardedQueuedAssignments) this.persist();
  }
  private persist() {
    const temp = this.registry + ".tmp";
    enforcePrivatePathIfPresent(temp, 0o600, false);
    writeFileSync(temp, JSON.stringify({ version: 1, agents: [...this.records.values()], pendingNotices: [...this.notices.values()], peers: this.peers?.state }, null, 2), { mode: 0o600 });
    enforcePrivatePath(temp, 0o600, false);
    renameSync(temp, this.registry);
    enforcePrivatePath(this.registry, 0o600, false);
    this.changed();
  }
  private update(record: AgentRecord, kind: string, text: string) {
    record.updatedAt = new Date().toISOString();
    record.updates.push({ cursor: ++record.cursor, kind, text: text.slice(0, 12000), time: record.updatedAt });
    record.updates = record.updates.slice(-100);
    this.persist();
  }
  private log(path: string, text: string) {
    const size = this.logSizes.get(path) ?? (existsSync(path) ? statSync(path).size : 0);
    if (size >= MAX_LOG) return;
    const bytes = Buffer.from(text);
    appendFileSync(path, bytes.subarray(0, MAX_LOG - size), { mode: 0o600 });
    this.logSizes.set(path, size + Math.min(bytes.length, MAX_LOG - size));
  }
  private announce(record: AgentRecord, kind: string, text: string, cursor = record.cursor, requestId?: string) {
    if (kind !== "human_intervention" && (this.shuttingDown || this.workflowChildren.has(record.id) || record.observedCursors?.includes(cursor))) return;
    const key = `${record.id}:${cursor}:${kind}`;
    if (this.notices.has(key)) return;
    const notice = { id: record.id, name: record.name, kind, text: text.slice(0, 4000), cursor, key, requestId };
    this.notices.set(key, notice);
    this.persist();
    // Notification scheduling must not prevent a human cancellation; the queue is durable.
    if (kind === "human_intervention") { try { this.notice(notice); } catch { /* retry from persisted queue */ } }
    else if (!this.routedToParent(notice)) this.notice(notice); // Wake the delivery scheduler; don't inject into the parent here.
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
    const parentId = this.records.get(id)?.parentId;
    return parentId && this.children.has(parentId) ? parentId : undefined;
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
    for (const key of keys) {
      const notice = this.notices.get(key);
      if (notice?.kind === "human_intervention") this.notices.delete(key);
      else if (notice) this.observe(this.get(notice.id), [notice.cursor]);
    }
    this.persist();
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
    if (record.assignment?.resultCursor && cursors.includes(record.assignment.resultCursor) && record.resultReview?.assignmentId === record.assignment.id && record.resultReview.status === "unreviewed") {
      record.resultReview = { assignmentId: record.assignment.id, status: "reviewed", at: new Date().toISOString() };
    }
    if (advanceCursor) record.readCursor = Math.max(record.readCursor, receipt.nextCursor);
    this.persist();
  }
  private expireInputNotices(record: AgentRecord) {
    const live = new Set(record.uiRequests.map(request => request.id));
    for (const [key, notice] of this.notices) {
      if (notice.id === record.id && notice.requestId && !live.has(notice.requestId)) this.notices.delete(key);
    }
  }
  get(id: string) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown subagent: ${id}`);
    return record;
  }
  /** Read-only transient view; no read cursor, notices, or child RPCs are touched. */
  activitySnapshot(id: string): LiveActivity {
    const record = this.get(id);
    const snapshot = this.activityFeeds.get(id)?.snapshot() ?? { tools: [], text: "" };
    return record.status === "working" ? snapshot : { ...snapshot, text: "", phase: undefined };
  }
  private child(id: string) {
    this.get(id);
    const child = this.children.get(id);
    if (!child) throw new Error(`${id} has no running process. Use subagent_resume.`);
    return child;
  }
  list(includeRejected = false) {
    return [...this.records.values()].filter(record => includeRejected || !record.rejected).map(({ updates, config, runStartCursor, runRevision, observedCursors, ...record }) => {
      const unreadUpdates = updates.filter(u => u.cursor > record.readCursor);
      // Tool-facing snapshots must not retain nested references to live records.
      return structuredClone({
        ...record, cwd: config.cwd, coordination: config.coordination,
        unread: unreadUpdates.filter(u => REPORT_KINDS.has(u.kind)).length,
        unreadAssistant: unreadUpdates.filter(u => u.kind === "assistant").length,
        unreadUpdates: unreadUpdates.length,
        uiRequests: record.uiRequests.map(({ id, method, title }) => ({ id, method, title })),
      });
    });
  }
  overview(includeRejected = false) {
    return { totals: summarizeAgents(this.list()), agents: this.list(includeRejected) };
  }
  /** Available live-process slots, including in-flight workflow reservations. */
  capacity() {
    return capacityOf(this.limit, this.children.size, this.reservedSlots);
  }
  reserveSlots(count: number): SlotReservation | undefined {
    if (!Number.isInteger(count) || count < 1) throw new Error("Slot reservation count must be a positive integer");
    if (this.shuttingDown) throw new Error("Manager is shutting down");
    const blocked = permanentRefusal(this.limit, count);
    if (blocked) throw new Error(blocked);
    if (!allows(this.limit, this.children.size + this.reservedSlots + count)) return undefined;
    const reservation = { id: Symbol("subagent-slot-reservation") };
    this.reservations.set(reservation, count);
    this.reservedSlots += count;
    return reservation;
  }
  releaseSlots(reservation: SlotReservation) {
    const remaining = this.reservations.get(reservation);
    if (remaining === undefined) return;
    this.reservations.delete(reservation);
    this.reservedSlots -= remaining;
  }
  private claimSlot(reservation: SlotReservation) {
    const remaining = this.reservations.get(reservation);
    if (!remaining) throw new Error("Invalid or exhausted live-child slot reservation");
    this.reservedSlots--;
    if (remaining === 1) this.reservations.delete(reservation);
    else this.reservations.set(reservation, remaining - 1);
  }
  private preflight(config: AgentRecord["config"], depth: number, overrides?: Record<string, string>, reservation?: SlotReservation, capacityReserved = false) {
    if (this.shuttingDown) throw new Error("Manager is shutting down");
    if (this.authorize && overrides) throw new Error("Environment overrides are disabled by managed spawn policy");
    const checked = this.authorize ? this.authorize(config, depth) : config;
    if (!capacityReserved) {
      if (reservation) {
        if (!this.reservations.get(reservation)) throw new Error("Invalid or exhausted live-child slot reservation");
      } else if (!allows(this.limit, this.children.size + this.reservedSlots + 1)) {
        throw new Error(permanentRefusal(this.limit, 1) ?? `Live-child limit (${reportedLimit(this.limit)}) reached; close an idle child first.`);
      }
    }
    if (!isAbsolute(checked.cwd) || !statSync(checked.cwd).isDirectory()) throw new Error("cwd must be an existing absolute directory");
    if ((checked.cliArgs ?? []).some(arg => RESERVED.has(arg.split("=")[0]))) throw new Error("cliArgs cannot override manager-owned RPC mode/session flags, print/export modes, or contain --");
    return checked;
  }
  read(id: string, since?: number, acknowledge = true) {
    const record = this.get(id);
    const cursor = since ?? record.readCursor;
    const updates: Update[] = [];
    let size = 0;
    for (const update of record.updates.filter(u => u.cursor > cursor)) {
      if (size + update.text.length > 24000 && updates.length) break;
      updates.push(update); size += update.text.length;
    }
    const nextCursor = updates.at(-1)?.cursor ?? cursor;
    const result = {
      id, name: record.name, status: record.status, activity: record.activity,
      model: record.model, thinking: record.thinking,
      updates, nextCursor, hasMore: record.cursor > nextCursor,
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
  private assertReleased(record: AgentRecord) {
    if (record.hold) throw new Error(`${record.id} is under human ${record.hold.kind} hold; parent must releaseHold explicitly.`);
    // A held coordinator's subtree stays still even if a descendant's own hold was released first.
    const held = this.ancestorsOf(record.id).find(id => this.records.get(id)?.hold);
    if (held) throw new Error(`${record.id} is below ${held}, which is under human ${this.records.get(held)!.hold!.kind} hold; release it first.`);
  }
  /** A held Child, or one whose subtree is being cancelled or closed, cannot start or steer more work. */
  private assertDelegationOpen(record: AgentRecord) {
    this.assertReleased(record);
    const fenced = [record.id, ...this.ancestorsOf(record.id)].find(id => this.fenced.has(id));
    if (fenced) throw new Error(`Delegation refused: ${fenced} and the work it delegated are being cancelled or closed.`);
  }
  private beginAssignment(record: AgentRecord, task: string, id: string = randomUUID(), at = new Date().toISOString()) {
    record.assignment = { id, task, status: "running", at };
    record.resultReview = undefined;
    this.persist();
  }
  async spawn(options: SpawnOptions, reservation?: SlotReservation) {
    const id = `subagent-${randomUUID().slice(0, 8)}`;
    const { name, task, env, workflow, deferTask, parentId, ...requested } = options;
    const depth = parentId ? (this.get(parentId).depth ?? 1) + 1 : 1;
    if (!name.trim() || !task.trim()) throw new Error("name and task must not be empty");
    // No record/session/log paths for requests rejected before any launch attempt.
    const config = this.preflight(requested, depth, env, reservation);
    if (reservation) this.claimSlot(reservation);
    const record: AgentRecord = {
      id, name, task, config, workflow, status: "stopped", ...(parentId ? { parentId, depth } : {}),
      sessionFile: join(this.directory, `${id}.session.jsonl`),
      logFile: join(this.directory, `${id}.events.jsonl`),
      stderrFile: join(this.directory, `${id}.stderr.log`),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      updates: [], cursor: 0, readCursor: 0, uiRequests: [], hadEnvOverrides: !!env,
    };
    this.records.set(id, record);
    if (workflow) this.workflowChildren.add(id);
    try {
      await this.start(record, env, !!reservation);
      if (!deferTask) await this.send(id, task);
      return this.summary(id);
    } catch (error) {
      if (record.hold) return this.summary(id); // A concurrent human intervention owns this lifecycle.
      if (this.children.has(id)) await this.close(id);
      this.workflowChildren.delete(id);
      record.status = "failed";
      record.error = String(error);
      this.update(record, "error", String(error));
      throw new Error(`${id}: ${error}. Diagnostics: ${record.stderrFile}`);
    }
  }
  private async start(record: AgentRecord, overrides?: Record<string, string>, capacityReserved = false) {
    this.assertReleased(record);
    if (this.children.has(record.id)) throw new Error(`${record.id} already has a process`);
    const config = this.preflight(record.config, record.depth ?? 1, overrides, undefined, capacityReserved);
    enforcePrivatePathIfPresent(record.logFile, 0o600, false);
    enforcePrivatePathIfPresent(record.stderrFile, 0o600, false);
    record.config = config;
    const extra = config.cliArgs ?? [];
    const args = [...(config.executableArgs ?? [])];
    if (!config.inheritExtensions) args.push("--no-extensions");
    // --models replaces the user's enabledModels for this launch: a Child never cycles
    // models, and patterns naming providers it lacks only print warnings.
    if (config.model) args.push("--model", config.model, "--models", config.model);
    if (config.thinking) args.push("--thinking", config.thinking);
    // A CLI name allowlist cannot include not-yet-discovered MCP tools. Managed
    // children use the mandatory guard for both activation and execution instead.
    if (!config.childPolicy) {
      if (config.tools?.length) args.push("--tools", config.tools.join(","));
      else if (config.tools) args.push("--no-tools");
    }
    args.push(...extra, "--mode", "rpc", "--session", record.sessionFile);
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT: "1" };
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    if (this.authorize && overrides) throw new Error("Environment overrides are disabled by managed spawn policy");
    Object.assign(env, overrides);
    env.PI_SUBAGENT = "1";
    delete env.PI_SUBAGENT_POLICY;
    if (config.selection) env.PI_SUBAGENT_ALLOWED_TOOLS = JSON.stringify(config.tools ?? []);
    if (config.childPolicy) env.PI_SUBAGENT_POLICY = JSON.stringify(config.childPolicy);
    this.verifiedTools.delete(record.id);
    this.abortIntents.delete(record.id);
    this.activeRuns.delete(record.id);
    record.aborted = false;
    record.status = "starting";
    record.error = undefined;
    record.uiRequests = [];
    const child = new RpcChild({
      executable: config.executable || "pi", args, cwd: resolve(config.cwd), env,
      peerRequest: config.selection?.tools.includes("peer_send") && this.peerMessageLimit > 0 ? async packet => {
        if (this.children.get(record.id) !== child) throw new Error("Stale peer process");
        return this.peers.send(record.id, packet.recipient, packet.message);
      } : undefined,
      manageRequest: config.selection?.tools.some(isProxiedTool) && !record.workflow ? async (request, cancelled) => {
        if (this.children.get(record.id) !== child) throw new Error("Stale child process");
        if (!this.management) throw new Error("Delegation is not available from this parent");
        this.assertDelegationOpen(record);
        // A call outlives its caller only as a cancelled operation: nobody can receive its result.
        const controller = new AbortController();
        // Also when the Child cancels the call itself (its tool was aborted or timed out).
        if (cancelled.aborted) controller.abort(cancelled.reason);
        else cancelled.addEventListener("abort", () => controller.abort(cancelled.reason), { once: true });
        const calls = this.callerCalls.get(record.id) ?? new Set<AbortController>();
        this.callerCalls.set(record.id, calls.add(controller));
        try { return await this.management(record.id, request, controller.signal); }
        finally { calls.delete(controller); if (!calls.size && this.callerCalls.get(record.id) === calls) this.callerCalls.delete(record.id); }
      } : undefined,
      event: packet => this.event(record, packet),
      stderr: text => this.log(record.stderrFile, text),
      exit: error => {
        this.peers.interrupt(record.id);
        for (const call of this.callerCalls.get(record.id) ?? []) call.abort(new Error(`${record.id} exited; its delegated call was cancelled`));
        this.callerCalls.delete(record.id);
        this.children.delete(record.id);
        this.activeRuns.delete(record.id);
        this.abortIntents.delete(record.id);
        record.queuedAssignments = [];
        delete record.uncertainSubmission; // An observed close fences late RPC acceptance.
        delete record.pid;
        const expected = record.status === "stopping" || this.shuttingDown || !!record.hold;
        record.status = expected ? "stopped" : "failed";
        record.activity = expected ? "Stopped; saved conversation available" : "Process exited";
        record.uiRequests = [];
        this.expireInputNotices(record);
        if (!expected) record.error = error?.message || "Child exited unexpectedly";
        if (record.assignment?.status === "running") {
          record.assignment.status = record.hold || expected ? "cancelled" : "failed";
          record.assignment.finishedAt = new Date().toISOString();
          this.update(record, "lifecycle", `Assignment ${record.assignment.status} when process exited.`);
          record.assignment.resultCursor = record.cursor;
          record.resultReview = { assignmentId: record.assignment.id, status: "unreviewed" };
        }
        if (expected && record.error) { record.lastError = record.error; delete record.error; }
        this.update(record, expected ? "lifecycle" : "error", expected ? "Child stopped; conversation saved." : record.error!);
        if (!expected) this.announce(record, "failure", record.error!);
        // Its Children's unread reports were waiting for it; they now go to the root.
        const released = [...this.notices.values()].find(notice => this.records.get(notice.id)?.parentId === record.id);
        if (released) this.notice(released);
      },
    });
    this.children.set(record.id, child);
    record.pid = child.child.pid;
    if (record.pid) record.startedAt ??= new Date().toISOString();
    this.persist();
    const state = await child.request({ type: "get_state" });
    this.assertReleased(record);
    if (!state.sessionFile || resolve(state.sessionFile) !== resolve(record.sessionFile)) {
      throw new Error("Child did not use the managed persistent session file");
    }
    if (config.selection) {
      const expected = config.selection.model;
      const actual = state.model ? `${state.model.provider}/${state.model.id}:${state.thinkingLevel}` : "no-model";
      if (actual !== expected) throw new Error(`Child resolved ${actual}, expected exactly ${expected}; refusing fallback.`);
      await child.request({ type: "prompt", message: "/_child-policy-check" });
      this.assertReleased(record);
      const tools = this.verifiedTools.get(record.id);
      const delegating = (name: string) => isProxiedTool(name) && !record.workflow && (config.tools ?? []).includes(name);
      if (!tools || tools.some(name => name.startsWith("subagent_") && !delegating(name)) || (config.tools ?? []).some(name => !tools.includes(name))) {
        throw new Error("Child tool policy check failed: selected tools unavailable, or mandatory guard did not load.");
      }
    }
    record.sessionId = state.sessionId;
    record.model = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
    record.thinking = state.thinkingLevel;
    record.usage = noteAutoCompaction(record.usage, state.autoCompactionEnabled);
    this.assertReleased(record);
    record.status = state.isStreaming ? "working" : "idle";
    this.update(record, "lifecycle", `Child ready: ${record.model ?? "no model"}, thinking=${record.thinking}`);
    await this.refreshUsage(record);
  }
  private async refreshUsage(record: AgentRecord, timeout = 1000) {
    const child = this.children.get(record.id);
    if (!child) return;
    const revision = (this.usageRevision.get(record.id) ?? 0) + 1;
    this.usageRevision.set(record.id, revision);
    try {
      const stats = await child.request({ type: "get_session_stats" }, timeout);
      // Ignore older responses and responses from a replaced/stopped process.
      if (this.children.get(record.id) !== child || this.usageRevision.get(record.id) !== revision) return;
      record.usage = retainFooterExtras(record.usage, stats);
      this.persist(); // Also refreshes the parent's footer while the child is busy.
    } catch { /* Keep the last known cumulative snapshot on failure. */ }
  }
  /** Refresh live snapshots before a user listing. Stopped children keep their last stats. */
  async refreshUsageSnapshots() {
    await Promise.all([...this.children.keys()].map(id => {
      const record = this.records.get(id);
      return record ? this.refreshUsage(record) : undefined;
    }));
  }
  private event(record: AgentRecord, packet: Packet) {
    this.log(record.logFile, JSON.stringify(packet) + "\n");
    let activity = this.activityFeeds.get(record.id);
    if (!activity) this.activityFeeds.set(record.id, activity = new ActivityFeed());
    try { activity.accept(packet); }
    catch { this.activityFeeds.delete(record.id); } // Cosmetic data must never break execution.
    switch (packet.type) {
      case "agent_start":
        if (record.queuedAssignments?.length && !record.hold && record.queuedAssignments[0].startAt <= (record.runRevision ?? 0) + 1) {
          const next = record.queuedAssignments.shift()!;
          this.beginAssignment(record, next.task, next.id, next.at);
        }
        record.runRevision = (record.runRevision ?? 0) + 1;
        this.activeRuns.add(record.id);
        const intent = this.abortIntents.get(record.id);
        if (intent?.awaitingStart) { intent.revision = record.runRevision; intent.awaitingStart = false; }
        else this.abortIntents.delete(record.id);
        record.runStartCursor = record.cursor;
        record.aborted = false;
        // A prompt accepted before its start event can be closed immediately.
        // Track cancellation identity without reviving the stopping lifecycle.
        if (record.status === "stopping") { this.persist(); break; }
        if (record.hold && !this.aborting.has(record.id) && record.hold.kind === "halt") {
          // A prompt accepted just before the hold may start after the first abort.
          queueMicrotask(() => { if (record.hold?.kind === "halt" && this.children.has(record.id) && !this.aborting.has(record.id)) void this.abort(record.id).catch(() => {}); });
        }
        record.status = "working"; record.error = undefined; record.activity = "Working";
        this.persist(); break;
      case "tool_execution_start":
        record.activity = `Tool: ${packet.toolName}`; this.changed(); break;
      case "message_end": {
        const message = packet.message;
        if (message?.role === "user") {
          const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((c: Packet) => c.type === "text").map((c: Packet) => c.text).join("\n");
          this.peers.received(record.id, text);
        }
        if (message?.role === "assistant") record.usage = noteAssistantCacheHit(record.usage, message);
        if (message?.role === "assistant" || message?.role === "toolResult") void this.refreshUsage(record);
        if (message?.role !== "assistant") break;
        const text = (message.content ?? []).filter((c: Packet) => c.type === "text").map((c: Packet) => c.text).join("\n");
        if (text) this.update(record, "assistant", text);
        const intent = this.abortIntents.get(record.id);
        const requestedAbort = intent && !intent.awaitingStart && intent.revision === (record.runRevision ?? 0);
        const cancelled = message.stopReason === "aborted" ||
          (message.stopReason === "error" && requestedAbort && isCancellationError(message.errorMessage));
        if (cancelled) {
          if (record.assignment?.status === "running") record.assignment.status = "cancelled";
          if (!record.aborted) {
            record.aborted = true;
            this.update(record, "aborted", "Work cancelled; child remains available for instructions.");
          }
        } else if (message.stopReason === "error") {
          if (record.assignment?.status === "running") record.assignment.status = "failed";
          record.error = message.errorMessage || "Assistant request failed";
          this.update(record, "error", record.error!);
        }
        break;
      }
      case "entry_appended": {
        const entry = packet.entry;
        if (entry?.customType === "child-policy-check" && Array.isArray(entry.data?.tools) && !entry.data?.errors?.length) {
          this.verifiedTools.set(record.id, entry.data.tools);
        }
        // Classifiers and idle cache warming can persist usage without an assistant message.
        if (["usage", "compaction", "branch_summary"].includes(entry?.type)) void this.refreshUsage(record);
        break;
      }
      case "turn_end":
      case "compaction_end":
        void this.refreshUsage(record); break;
      case "agent_settled": {
        const intent = this.abortIntents.get(record.id);
        const humanCancellation = !!record.hold && !!intent && !intent.awaitingStart && intent.revision === (record.runRevision ?? 0);
        this.activeRuns.delete(record.id);
        this.abortIntents.delete(record.id);
        if (record.status === "stopping") break;
        record.runRevision = (record.runRevision ?? 0) + 1;
        record.status = record.error ? "failed" : "idle";
        record.activity = record.error ? "Run failed; process remains available" : record.aborted ? "Work aborted; waiting for instructions" : "Waiting for instructions";
        record.uiRequests = [];
        this.expireInputNotices(record);
        const kind = record.error ? "failure" : record.aborted ? "aborted" : "completed";
        if (record.assignment?.status === "running") record.assignment.status = record.error ? "failed" : record.aborted ? "cancelled" : "completed";
        const last = record.updates.findLast(u => u.kind === (record.error ? "error" : record.aborted ? "aborted" : "assistant") && u.cursor > (record.runStartCursor ?? 0));
        const text = record.error || last?.text || "Run settled without a text response.";
        if (!last) this.update(record, kind, text);
        if (record.assignment && !record.assignment.finishedAt) {
          record.assignment.finishedAt = new Date().toISOString();
          record.assignment.resultCursor = last?.cursor ?? record.cursor;
          record.resultReview = { assignmentId: record.assignment.id, status: record.observedCursors?.includes(record.assignment.resultCursor) ? "reviewed" : "unreviewed" };
        }
        this.persist();
        // The human hold has its own durable requested/outcome notices. Do not
        // also report its routine cancellation; a genuine failure still reports.
        if (!(humanCancellation && kind === "aborted")) this.announce(record, kind, text, last?.cursor ?? record.cursor);
        void this.refreshUsage(record);
        break;
      }
      case "extension_error":
        this.update(record, "extension_error", packet.error || JSON.stringify(packet)); break;
      case "extension_ui_request":
        if (record.status === "stopping" || record.hold) break;
        if (["confirm", "select", "input", "editor"].includes(packet.method)) {
          record.uiRequests.push(packet);
          record.status = "waiting_input";
          this.update(record, "input_requested", JSON.stringify(packet));
          this.announce(record, "input_requested", JSON.stringify(packet), record.cursor, packet.id);
        }
        break;
    }
  }
  summary(id: string) { return this.list(true).find(record => record.id === id)!; }
  async send(id: string, message: string, behavior?: "steer" | "followUp") {
    if (!message.trim()) throw new Error("message must not be empty");
    if (this.aborting.has(id)) throw new Error("Abort is still in progress; wait for its acknowledgement before sending another task.");
    const record = this.get(id);
    this.assertReleased(record);
    if (record.uncertainSubmission) throw new Error(`${id} has uncertain prompt acceptance; close or kill its process before sending more work.`);
    const child = this.child(id);
    // Acceptance can precede agent_start on a later stdout chunk. Reserve the
    // busy state first so an immediate wait cannot mistake acceptance for idle.
    const previous = record.status;
    const revision = record.runRevision;
    if (previous !== "waiting_input") {
      record.status = "working";
      record.activity = "Submitting prompt / awaiting agent events";
    }
    const priorAssignment = record.assignment;
    const priorReview = record.resultReview;
    const queued = !message.startsWith("/") && behavior === "followUp" && previous === "working"
      ? { id: randomUUID(), task: message, at: new Date().toISOString(), startAt: (record.runRevision ?? 0) + (this.activeRuns.has(id) ? 1 : 2) } : undefined;
    if (queued) (record.queuedAssignments ??= []).push(queued);
    else if (!message.startsWith("/") && (!record.assignment || record.assignment.status !== "running")) this.beginAssignment(record, message);
    this.persist();
    this.submitting.set(id, (this.submitting.get(id) ?? 0) + 1);
    let disposition: InputDisposition = "unknown";
    try {
      try {
        const response = await child.request({ type: "prompt", message, ...(behavior ? { streamingBehavior: behavior } : {}) });
        if (["started", "queued", "handled"].includes(response?.disposition)) disposition = response.disposition;
        record.lastSubmission = { disposition, at: new Date().toISOString() };
        // A human hold installed while prompt acceptance was pending owns all later state.
        if (record.hold) {
          // Acceptance after the first clear_queue/abort can enqueue a fresh run.
          if (record.hold.kind === "halt" && this.children.get(id) === child && !this.aborting.has(id)) await this.abort(id).catch(() => {});
          throw new Error(`${id} was held while prompt acceptance was pending`);
        }
        // An input hook can consume ordinary text too: acceptance need not schedule work.
        if (disposition === "handled") {
          if (queued) record.queuedAssignments = record.queuedAssignments?.filter(item => item !== queued);
          else if (record.runRevision === revision && record.assignment !== priorAssignment) {
            record.assignment = priorAssignment; record.resultReview = priorReview;
          }
        }
        if ((disposition === "handled" || message.startsWith("/")) && record.runRevision === revision) {
          const state = await child.request({ type: "get_state" });
          if (record.runRevision === revision && !record.hold) {
            record.usage = noteAutoCompaction(record.usage, state.autoCompactionEnabled);
            record.status = record.uiRequests.length ? "waiting_input" : state.isStreaming ? "working" : "idle";
            if (record.status === "idle") record.activity = disposition === "handled" ? "Input handled; no task run scheduled" : "Waiting for instructions";
          }
        }
      } catch (error) {
        if (!(error instanceof RpcRejectedError) && /^Error: RPC prompt timed out;/.test(String(error)) && this.children.get(id) === child) {
          record.uncertainSubmission ??= { at: new Date().toISOString(), reason: "Prompt acceptance timed out; a late run may still start." };
          if (record.hold?.kind === "halt" && record.hold.outcome === "confirmed") {
            record.hold.outcome = "failed";
            record.hold.detail = "Prompt acceptance timed out after halt confirmation; a late run may still start. Kill or close the process before release.";
            const text = `Human halt for ${record.name} (${id}): failed. ${record.hold.detail}`;
            this.update(record, "human_intervention", text);
            this.announce(record, "human_intervention", text);
          }
        }
        if (error instanceof RpcRejectedError && !record.hold) {
          if (queued) record.queuedAssignments = record.queuedAssignments?.filter(item => item !== queued);
          else if (record.assignment !== priorAssignment) { record.assignment = priorAssignment; record.resultReview = priorReview; }
        }
        if (record.runRevision === revision && this.children.has(id) && !record.hold) {
          if (String(error).includes("timed out")) record.activity = "Prompt acceptance unknown after timeout; inspect before retrying.";
          else record.status = previous;
        }
        this.persist();
        throw error;
      }
      if (record.hold) throw new Error(`${id} was held while prompt acceptance was pending`);
      this.update(record, "sent", message);
      return { ...this.summary(id), disposition };
    } finally {
      const remaining = (this.submitting.get(id) ?? 1) - 1;
      if (remaining) this.submitting.set(id, remaining);
      else this.submitting.delete(id);
    }
  }
  private markAbortIntent(record: AgentRecord) {
    if (this.activeRuns.has(record.id) || record.status === "working" || record.status === "waiting_input") {
      this.abortIntents.set(record.id, { revision: record.runRevision ?? 0, awaitingStart: !this.activeRuns.has(record.id) });
    }
  }
  async abort(id: string) {
    const record = this.get(id);
    // Cancelling a coordinator cancels the work it delegated: fenced first, so it
    // cannot delegate more meanwhile, then every live descendant, deepest first.
    this.fence(id);
    try {
      const failures: string[] = [];
      for (const descendant of this.subtree(id)) {
        // One already being aborted is awaited, so its outcome is reported too.
        const run = this.abortRuns.get(descendant.id) ?? (this.children.has(descendant.id) ? this.abortOne(descendant) : undefined);
        await run?.catch(error => { failures.push(`${descendant.id}: ${String(error)}`); });
      }
      const summary = await this.abortOne(record);
      return failures.length ? { ...summary, subtreeFailures: failures } : summary;
    } finally { this.unfence(id); }
  }
  /** In-flight single-process aborts, so that a subtree abort can await one it did not start. */
  private abortRuns = new Map<string, Promise<ReturnType<SubagentManager["summary"]>>>();
  private abortOne(record: AgentRecord): Promise<ReturnType<SubagentManager["summary"]>> {
    if (this.aborting.has(record.id)) return Promise.reject(new Error("Abort is already in progress"));
    const run = this.abortProcess(record).finally(() => { if (this.abortRuns.get(record.id) === run) this.abortRuns.delete(record.id); });
    this.abortRuns.set(record.id, run);
    return run;
  }
  private async abortProcess(record: AgentRecord) {
    const id = record.id;
    const child = this.child(id);
    if (this.aborting.has(id)) throw new Error("Abort is already in progress");
    this.aborting.add(id);
    record.queuedAssignments = [];
    this.persist(); // Durable before clear_queue can discard a queued follow-up.
    this.markAbortIntent(record); // Before awaiting anything: adapters may emit cancellation immediately.
    try {
      await child.request({ type: "clear_queue" });
      this.markAbortIntent(record); // A queued run may have started while clearing.
      await child.request({ type: "abort" });
      return this.summary(id);
    } finally {
      this.peers.interrupt(id);
      this.aborting.delete(id);
      // On timeout the run may still deliver cancellation later. Keep its scoped
      // intent until settle/new-run/exit, rather than misclassifying a late abort.
      if (!this.activeRuns.has(id) && record.status !== "working") this.abortIntents.delete(id);
    }
  }
  /** The hold is persisted synchronously before the hook or any asynchronous cancellation. */
  private supersedes(record: AgentRecord, kind: InterventionKind) {
    return !record.hold || (kind === "kill" && (record.hold.kind === "halt" || (record.hold.kind === "kill" && record.hold.outcome === "failed")));
  }
  async intervene(id: string, kind: InterventionKind, beforeCancel?: (record: AgentRecord, kind: InterventionKind) => void, nested = false) {
    if (kind !== "halt" && kind !== "kill") throw new Error("Invalid human intervention kind");
    const record = this.get(id);
    if (!this.supersedes(record, kind)) throw new Error(`${id} is already under human ${record.hold!.kind} hold`);
    const hold: HumanHold = { kind, at: new Date().toISOString(), outcome: "pending" };
    record.hold = hold;
    record.queuedAssignments = [];
    this.update(record, "human_intervention", `Human ${kind} requested for ${record.name} (${id}); cancellation pending.`);
    const cursor = record.cursor;
    let hookError: unknown;
    try { this.interventionHook?.(record, kind); beforeCancel?.(record, kind); }
    catch (error) { hookError = error; }
    this.announce(record, "human_intervention", `Human ${kind} requested for ${record.name} (${id}); cancellation pending.`, cursor);
    try {
      const child = this.children.get(id);
      if (kind === "kill") {
        this.peers.interrupt(id);
        if (!child) throw new Error("No managed process attached; force termination cannot be confirmed. Inspect for orphaned work.");
        await child.kill();
      } else if (child) {
        await this.abortOne(record); // Pi acknowledges abort only after its session becomes idle. Descendants are held below.
        if (this.children.get(id) !== child) throw new Error("Process exited before halt confirmation");
        const state = await child.request({ type: "get_state" });
        if (state.isStreaming) throw new Error("Abort acknowledged but child still reports streaming; cancellation unconfirmed");
      }
      if (hookError) throw new Error(`Workflow pause hook failed: ${String(hookError)}`);
      if (kind === "halt" && record.uncertainSubmission) throw new Error("Prompt acceptance remains unknown; halt cannot be confirmed. Kill or close the process before release.");
      hold.outcome = "confirmed";
      hold.detail = kind === "kill" ? "Process force-killed (SIGKILL); conversation retained." : child
        ? "Queues cleared and active work cancelled; process/conversation retained."
        : "No managed process attached; hold applied to saved conversation.";
    } catch (error) {
      hold.outcome = "failed";
      hold.detail = String(error);
    }
    if (record.hold !== hold) {
      hold.outcome = "failed";
      hold.detail = `Superseded by human ${record.hold?.kind ?? "intervention"}; prior ${kind} result cannot confirm current state.`;
    }
    if (record.hold === hold && record.assignment?.status === "running" && (hold.outcome === "confirmed" || !this.children.has(id))) {
      record.assignment.status = "cancelled";
      record.assignment.finishedAt = new Date().toISOString();
      record.assignment.resultCursor = record.cursor;
      record.resultReview = { assignmentId: record.assignment.id, status: "unreviewed" };
    }
    const text = `Human ${kind} for ${record.name} (${id}): ${hold.outcome}. ${hold.detail}`;
    this.update(record, "human_intervention", text);
    // Separate final notice: the requested notice may already be in flight with
    // its original text. Delivery of that receipt must never erase confirmation.
    this.announce(record, "human_intervention", text);
    // The hold already blocks this Child's delegation and its descendants' (assertReleased
    // checks ancestors). Hold every descendant too, saved ones included, so that none
    // resumes when this hold is released first. A saved descendant has no process to kill.
    if (!nested) for (const descendant of this.subtree(id).reverse()) {
      const descendantKind = kind === "kill" && this.children.has(descendant.id) ? "kill" : "halt";
      if (!this.supersedes(descendant, descendantKind)) continue;
      await this.intervene(descendant.id, descendantKind, beforeCancel, true).catch(() => {});
    }
    return this.summary(id);
  }
  /** Parent-only release: clearing a hold never resumes, prompts, or restarts work. */
  releaseHold(id: string) {
    const record = this.get(id);
    if (!record.hold) throw new Error(`${id} has no human hold`);
    if (record.uncertainSubmission) throw new Error(`${id} has uncertain prompt acceptance; kill or close its process before releasing the hold (inspect for orphans after a crash).`);
    if (this.aborting.has(id) || this.submitting.has(id) || [...this.responding].some(key => key.startsWith(`${id}:`)) || record.hold.outcome === "pending") {
      throw new Error(`${id} intervention/submission is still in flight; wait before releasing the hold`);
    }
    delete record.hold;
    this.update(record, "lifecycle", "Human hold released by parent; no work started.");
    return this.summary(id);
  }
  async close(id: string, preserveNotices = false) {
    const record = this.get(id);
    // Closing a coordinator closes everything it delegated, deepest first, fenced
    // so that it cannot delegate more while its subtree closes.
    this.fence(id);
    try {
      const failures: string[] = [];
      for (const descendant of this.subtree(id)) await this.closeOne(descendant, preserveNotices).catch(error => { failures.push(`${descendant.id}: ${String(error)}`); });
      const summary = await this.closeOne(record, preserveNotices);
      return failures.length ? { ...summary, subtreeFailures: failures } : summary;
    } finally { this.unfence(id); }
  }
  private async closeOne(record: AgentRecord, preserveNotices: boolean) {
    const id = record.id;
    record.queuedAssignments = [];
    this.workflowChildren.delete(id);
    // Explicit close means abandon ordinary reports, never human intervention.
    // Reload/exit shutdown deliberately preserves unread results for recovery.
    if (!preserveNotices) {
      this.observe(record, [...this.notices.values()].filter(n => n.id === id && n.kind !== "human_intervention").map(n => n.cursor));
      this.persist();
    }
    const child = this.children.get(id);
    if (!child) {
      if (record.error) { record.lastError = record.error; delete record.error; }
      record.status = "stopped";
      record.activity = "Stopped; retained history available";
      this.persist();
      return this.summary(id);
    }
    this.markAbortIntent(record);
    record.status = "stopping";
    this.peers.interrupt(id);
    this.persist();
    // Cancel active tools before terminating the process. Cleanup still happens
    // if a wedged child cannot acknowledge cancellation.
    await child.request({ type: "clear_queue" }, 1000).catch(() => {});
    await child.request({ type: "abort" }, 2000).catch(() => {});
    // Capture the final cumulative cost even when closing interrupts a run.
    // On failure retain the last known snapshot rather than resetting to zero.
    await this.refreshUsage(record);
    await child.stop();
    return this.summary(id);
  }
  async resume(id: string, message?: string, env?: Record<string, string>) {
    const record = this.get(id);
    this.assertReleased(record);
    if (record.uncertainSubmission) throw new Error(`${id} has uncertain prompt acceptance; inspect for orphaned work before resuming.`);
    if (this.children.has(id)) throw new Error(`${id} already has a process`);
    if (!existsSync(record.sessionFile)) throw new Error("No saved child session exists");
    if (!this.authorize && record.hadEnvOverrides && !env) throw new Error("This child used environment overrides. Supply them again; they are not stored.");
    this.preflight(record.config, record.depth ?? 1, env);
    try {
      await this.start(record, env);
      if (message) await this.send(id, message);
      return this.summary(id);
    } catch (error) {
      if (record.hold) return this.summary(id);
      if (this.children.has(id)) await this.close(id);
      record.status = "failed"; record.error = String(error); this.persist();
      throw error;
    }
  }
  async respond(id: string, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const record = this.get(id);
    this.assertReleased(record);
    if (record.uncertainSubmission) throw new Error(`${id} has uncertain prompt acceptance; close or kill its process before responding.`);
    const key = `${id}:${requestId}`;
    if (this.responding.has(key)) throw new Error("A response to this UI request is already being submitted");
    if (!record.uiRequests.some(r => r.id === requestId)) throw new Error("Unknown or expired UI request");
    const child = this.child(id);
    this.responding.add(key);
    try {
      await child.respond({ type: "extension_ui_response", id: requestId, ...response });
      if (record.hold) throw new Error(`${id} was held while the UI response was being submitted`);
      record.uiRequests = record.uiRequests.filter(r => r.id !== requestId);
      this.expireInputNotices(record);
      if (record.uiRequests.length) record.status = "waiting_input";
      else if (record.status === "waiting_input") {
        record.status = "working";
        record.activity = "UI response queued; awaiting child continuation";
      }
      this.persist();
      return { ...this.summary(id), responseDelivery: { transport: "queued" as const, receipt: "unconfirmed" as const } };
    } finally {
      this.responding.delete(key);
    }
  }
  async wait(ids: readonly string[], mode: "any" | "all", timeoutMs?: number, signal?: AbortSignal, messageQueued?: () => boolean): Promise<WaitEnd> {
    const selected = ids.length ? [...ids] : this.list().map(record => record.id);
    for (const id of selected) this.get(id);
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    const end = (wake: WaitEnd["wake"]): WaitEnd => ({ wake, ids: selected });
    while (true) {
      signal?.throwIfAborted();
      const records = selected.map(id => this.get(id));
      if (records.some(record => record.hold)) return end("hold");
      if (records.some(record => record.status === "waiting_input")) return end("input");
      const ready = records.filter(record => !BUSY.has(record.status)).length;
      if (!selected.length || (mode === "any" ? ready > 0 : ready === selected.length)) return end("settled");
      if (messageQueued?.()) return end("message");
      if (Date.now() >= deadline) return end("timeout");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async shutdown() {
    this.shuttingDown = true;
    this.reservations.clear();
    this.reservedSlots = 0;
    await Promise.all([...this.children.keys()].map(id => this.closeOne(this.get(id), true)));
  }
}
