import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { RpcChild, RpcRejectedError, type Packet } from "./rpc.js";
import type { ManagementRequest } from "./peer-transport.js";
import { isProxiedTool } from "./nesting.js";
import { ActivityFeed, type LiveActivity } from "./activity.js";
import { allows, capacityOf, capacityReachedText, OMITTED_CHILD_LIMIT, permanentRefusal, type ChildLimit } from "./child-limit.js";
import type { Composition } from "./policy.js";
import type { ChildPolicy } from "./child-policy.js";
import { PeerBroker, type PeerState } from "./peers.js";
import { noteAssistantCacheHit, noteAutoCompaction, retainFooterExtras, summarizeAgents } from "./usage.js";
import { BUSY, type WaitEnd } from "./wait.js";
import { REPORT_KINDS } from "./read-page.js";
import { enforcePrivatePath, enforcePrivatePathIfPresent, RegistryStore } from "./registry.js";
import { ReportInbox, type Notice, type ReadReceipt, type SavedReport, type Update } from "./report-inbox.js";
export type { Notice, ReadReceipt, Update } from "./report-inbox.js";
export { reportPage, REPORT_KINDS } from "./read-page.js";
export { BUSY } from "./wait.js";
import { gitEnv, type Worktree } from "./worktree.js";

/** The child's checkout may still be in use. */
export class StopUnconfirmedError extends Error {}
class SubmissionInFlight extends Error {}
export type InputDisposition = "started" | "queued" | "handled" | "unknown";
export type Status = "starting" | "working" | "waiting_input" | "idle" | "stopping" | "stopped" | "failed";
export interface SpawnOptions {
  name: string; task: string; cwd: string;
  /** Resolved checkout created for this spawn, not a request or a launch option. */
  worktree?: Worktree;
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

export type InterventionKind = "halt" | "kill";
export interface HumanHold { kind: InterventionKind; at: string; outcome: "pending" | "confirmed" | "failed"; detail?: string }
export interface Assignment { id: string; task: string; status: "running" | "completed" | "failed" | "cancelled"; at: string; finishedAt?: string; resultCursor?: number }
export interface ResultReview { assignmentId: string; status: "unreviewed" | "reviewed"; at?: string }
export interface AgentRecord {
  id: string; name: string; task: string; status: Status;
  config: Omit<SpawnOptions, "env" | "task" | "name" | "workflow" | "deferTask" | "parentId" | "worktree">;
  worktree?: Worktree;
  /** Set for a Child spawned by another Child; depth 1 is a Child of the root Parent. */
  parentId?: string; depth?: number;
  workflow?: string;
  sessionFile: string; sessionId?: string; logFile: string; stderrFile: string;
  createdAt: string; updatedAt: string; pid?: number;
  model?: string; thinking?: string; activity?: string; error?: string; lastError?: string;
  archiveError?: string; // In-memory placeholder only; its saved row still points to the archive.
  rejected?: boolean; startedAt?: string;
  usage?: unknown; updates: Update[]; cursor: number; readCursor: number;
  lastSubmission?: { disposition: InputDisposition; at: string; workStarted?: false };
  uiRequests: Packet[]; hadEnvOverrides: boolean;
  savedReports?: SavedReport[];
  runStartCursor?: number; aborted?: boolean; runRevision?: number;
  observedCursors?: number[];
  hold?: HumanHold; assignment?: Assignment; resultReview?: ResultReview;
  /** Prompt RPC timed out: acceptance might be delayed. Only observed process exit fences it. */
  uncertainSubmission?: { at: string; reason: string };
  /** A signalled process whose close was never observed still occupies a slot. */
  unconfirmedStop?: string;
  /** Submitted follow-ups are not assignments until a user message is delivered. */
  queuedAssignments?: { id: string; task: string; at: string }[];
  /** parent_send messages used during the assignment they were sent in. */
  parentMessages?: { assignmentId: string; used: number };
}
interface InputDelivery {
  followUp?: string[];
  steering?: string[];
  removed?: { queue: "followUp" | "steering"; text: string; queuedId?: string };
  firstUser?: boolean;
  batch?: boolean;
  lastResult?: Update;
  error?: string;
  cancelled?: boolean;
}

export interface SlotReservation { readonly id: symbol }
const MAX_LOG = 20 * 1024 * 1024;
const RESERVED = new Set(["--mode", "-p", "--print", "--session", "--session-dir", "--no-session", "--fork", "-c", "--continue", "-r", "--resume", "--export", "--"]);

// Deliberately narrow: a generic failure mentioning cancellation is still a failure.
export function isCancellationError(message: unknown): boolean {
  return typeof message === "string" && /^(?:AbortError:\s*)?(?:(?:(?:the|this) )?operation (?:was )?aborted|request (?:was )?aborted|aborted|cancelled|canceled)[.!]?$/i.test(message.trim());
}

// Only ESRCH proves absence; a reused PID or permission failure retains the slot.
function processGone(pid?: number) {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export class SubagentManager {
  private static owners = new Map<string, SubagentManager>();
  private get current() { return SubagentManager.owners.get(this.store.path) === this; }
  private records = new Map<string, AgentRecord>();
  private activityFeeds = new Map<string, ActivityFeed>();
  private children = new Map<string, RpcChild>();
  private logSizes = new Map<string, number>();
  private shuttingDown = false;
  private verifiedTools = new Map<string, string[]>();
  readonly inbox: ReportInbox;
  private activeRuns = new Set<string>();
  private workflowChildren = new Set<string>();
  private abortIntents = new Map<string, { revision: number; awaitingStart: boolean }>();
  private aborting = new Set<string>();
  private responding = new Set<string>();
  private retryableHalts = new WeakSet<HumanHold>();
  private submitting = new Map<string, number>();
  private reservations = new Map<SlotReservation, number>();
  private reservedSlots = 0;
  private usageRevision = new Map<string, number>();
  private readonly store: RegistryStore;
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
  constructor(readonly directory: string, private notice: (notice: Notice) => void = () => {}, private changed: () => void = () => {}, private readonly limit: ChildLimit = OMITTED_CHILD_LIMIT, private authorize?: (config: AgentRecord["config"], depth: number) => AgentRecord["config"], readonly peerMessageLimit = 0, readonly parentMessageLimit = 0) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    enforcePrivatePath(directory, 0o700, true);
    this.store = new RegistryStore(resolve(directory, "registry.json"));
    this.inbox = new ReportInbox({
      directory, lookup: id => this.records.get(id), attached: id => this.children.has(id),
      mayAnnounce: (id, kind) => this.current && (kind === "human_intervention" || (!this.shuttingDown && !this.workflowChildren.has(id))),
      persist: (...changed) => this.persist(...changed), notify: notice => this.notice(notice),
    });
    let peerState: PeerState | undefined;
    const recoveredHolds: AgentRecord[] = [];
    const recoveredChanges = new Set<AgentRecord>();
    const stored = this.store.load();
    if (stored) {
      peerState = stored.peers;
      for (const record of stored.agents) {
        if (record.archiveError) {
          record.activity = record.lastError = record.archiveError;
          this.records.set(record.id, record);
          continue;
        }
        // Keep old cap-preflight artifacts inspectable, but don't count
        // them as agents by default. Never hide actual process launch failures.
        if (!record.sessionId && !record.startedAt && !existsSync(record.sessionFile) &&
            /^Error: Live-child limit \(\d+\) reached(;| across the whole tree)/.test(record.error ?? "")) record.rejected = true;
        // Old stopped records have no trustworthy assignment outcome: do not infer completion.
        if (record.hold && !["halt", "kill"].includes(record.hold.kind)) delete record.hold;
        if (record.hold?.outcome === "pending" || (record.hold?.kind === "halt" && record.hold.outcome === "confirmed" && record.uncertainSubmission)) {
          record.hold.outcome = "failed";
          record.hold.detail = "Parent restarted without reliable halt confirmation; process detached. Inspect for orphaned work before explicit release.";
          recoveredHolds.push(record);
        }
        if (record.assignment && !record.assignment.finishedAt) {
          // Recovery cannot prove completion of a previously active assignment.
          record.assignment.status = record.status === "failed" || record.assignment.status === "failed" ? "failed" : "cancelled";
          record.assignment.finishedAt ??= record.updatedAt;
          record.assignment.resultCursor ??= record.cursor;
          record.resultReview ??= { assignmentId: record.assignment.id, status: "unreviewed" };
        }
        if (record.status === "stopping" || record.uncertainSubmission) record.unconfirmedStop ??= "Stop not confirmed before parent restart.";
        if (record.unconfirmedStop && processGone(record.pid)) {
          delete record.unconfirmedStop; delete record.uncertainSubmission;
          record.status = "stopped"; recoveredChanges.add(record);
        }
        record.status = record.status === "failed" ? "failed" : "stopped";
        if (record.status === "stopped" && record.error) {
          record.lastError = record.error; delete record.error;
        }
        if (record.unconfirmedStop) record.status = "stopping";
        else delete record.pid;
        if (record.queuedAssignments?.length) recoveredChanges.add(record);
        record.queuedAssignments = []; // Interrupted follow-ups are never replayed on explicit resume.
        record.uiRequests = [];
        record.activity = record.unconfirmedStop ?? "No process attached. Resume explicitly to continue the saved conversation.";
        enforcePrivatePathIfPresent(record.logFile, 0o600, false);
        enforcePrivatePathIfPresent(record.stderrFile, 0o600, false);
        if (this.inbox.restoreReports(record)) recoveredChanges.add(record);
        this.records.set(record.id, record);
      }
      this.inbox.restoreNotices(stored.pendingNotices);
    }
    SubagentManager.owners.set(this.store.path, this);
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
      this.inbox.report(record, "human_intervention", text);
    }
    if (recoveredChanges.size) this.persist(...recoveredChanges);
  }
  private persist(...changed: AgentRecord[]) {
    if (!this.current) return;
    this.store.save(this.records.values(), changed, r => !this.children.has(r.id) && !r.unconfirmedStop &&
      (r.status === "stopped" || r.status === "failed"), this.inbox.savedNotices(), this.peers?.state);
    this.changed();
  }

  private update(record: AgentRecord, kind: string, text: string, finalAnswer = false) {
    const update = this.inbox.appendUpdate(record, kind, text, finalAnswer);
    this.persist(record);
    return update;
  }
  private log(path: string, text: string) {
    const size = this.logSizes.get(path) ?? (existsSync(path) ? statSync(path).size : 0);
    if (size >= MAX_LOG) return;
    const bytes = Buffer.from(text);
    appendFileSync(path, bytes.subarray(0, MAX_LOG - size), { mode: 0o600 });
    this.logSizes.set(path, size + Math.min(bytes.length, MAX_LOG - size));
  }
  pendingNotices() { return this.inbox.pendingNotices(); }
  markNoticesDelivered(keys: string[]) { this.inbox.markNoticesDelivered(keys); }
  acknowledgeRead(receipt: ReadReceipt, advanceCursor: boolean, byRoot = true) {
    this.inbox.acknowledgeRead(receipt, advanceCursor, byRoot);
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
    return [...this.records.values()].filter(record => includeRejected || !record.rejected).map(({ updates, config, runStartCursor, runRevision, observedCursors, savedReports, ...record }) => {
      const unreadUpdates = updates.filter(u => u.cursor > record.readCursor && !u.consumed);
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
  private occupiedSlots() {
    return this.children.size + [...this.records.values()].filter(r => r.unconfirmedStop && !this.children.has(r.id)).length;
  }
  /** Available live-process slots, including in-flight workflow reservations. */
  capacity() {
    return capacityOf(this.limit, this.occupiedSlots(), this.reservedSlots);
  }
  reserveSlots(count: number): SlotReservation | undefined {
    if (!Number.isInteger(count) || count < 1) throw new Error("Slot reservation count must be a positive integer");
    if (this.shuttingDown) throw new Error("Manager is shutting down");
    const blocked = permanentRefusal(this.limit, count);
    if (blocked) throw new Error(blocked);
    if (!allows(this.limit, this.occupiedSlots() + this.reservedSlots + count)) return undefined;
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
      } else if (!allows(this.limit, this.occupiedSlots() + this.reservedSlots + 1)) {
        throw new Error(permanentRefusal(this.limit, 1) ?? capacityReachedText(this.capacity(), "manager"));
      }
    }
    if (!isAbsolute(checked.cwd) || !statSync(checked.cwd).isDirectory()) throw new Error("cwd must be an existing absolute directory");
    if ((checked.cliArgs ?? []).some(arg => RESERVED.has(arg.split("=")[0]))) throw new Error("cliArgs cannot override manager-owned RPC mode/session flags, print/export modes, or contain --");
    return checked;
  }
  finalAnswer(id: string) { return this.inbox.finalAnswer(id); }
  readReportPage(id: string, page: string) { return this.inbox.readReportPage(id, page); }
  read(id: string, since?: number, acknowledge = true, allUpdates = false) {
    return this.inbox.read(id, since, acknowledge, allUpdates);
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
    this.persist(record);
  }
  async spawn(options: SpawnOptions, reservation?: SlotReservation) {
    const id = `subagent-${randomUUID().slice(0, 8)}`;
    const { name, task, env, workflow, deferTask, parentId, worktree, ...requested } = options;
    const depth = parentId ? (this.get(parentId).depth ?? 1) + 1 : 1;
    if (!name.trim() || !task.trim()) throw new Error("name and task must not be empty");
    // No record/session/log paths for requests rejected before any launch attempt.
    const config = this.preflight(requested, depth, env, reservation);
    if (reservation) this.claimSlot(reservation);
    const record: AgentRecord = {
      id, name, task, config, workflow, ...(worktree ? { worktree } : {}), status: "stopped", ...(parentId ? { parentId, depth } : {}),
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
      return this.failedLaunch(record, error);
    }
  }
  private async failedLaunch(record: AgentRecord, error: unknown): Promise<never> {
    const { id } = record;
    let cleanup: string | undefined;
    if (this.children.has(id)) {
      try {
        const closed = await this.close(id);
        if (closed.outcome === "unconfirmed") cleanup = [closed.targetDetail, ...closed.subtreeFailures].filter(Boolean).join("; ");
      } catch (stopError) { cleanup = String(stopError); }
    }
    this.workflowChildren.delete(id);
    record.error = String(error);
    if (!cleanup) record.status = "failed";
    const detail = `${id}: ${error}. Diagnostics: ${record.stderrFile}`;
    this.update(record, "error", record.error);
    if (cleanup) throw new StopUnconfirmedError(`${detail}; stop unconfirmed: ${cleanup}`);
    throw new Error(detail, { cause: error });
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
    const env: NodeJS.ProcessEnv = { ...gitEnv(), PI_SUBAGENT: "1" };
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
    const delivery: InputDelivery = {};
    const child = new RpcChild({
      executable: config.executable || "pi", args, cwd: resolve(config.cwd), env,
      peerRequest: config.selection?.tools.includes("peer_send") && this.peerMessageLimit > 0 ? async packet => {
        if (!this.current || this.children.get(record.id) !== child) throw new Error("Stale peer process");
        return this.peers.send(record.id, packet.recipient, packet.message);
      } : undefined,
      manageRequest: config.selection?.tools.some(isProxiedTool) && !record.workflow ? async (request, cancelled) => {
        if (!this.current || this.children.get(record.id) !== child) throw new Error("Stale child process");
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
      parentMessage: config.selection?.tools.includes("parent_send") && this.parentMessageLimit > 0 ? async message => {
        if (!this.current || this.children.get(record.id) !== child) throw new Error("Stale child process");
        return this.messageParent(record, message);
      } : undefined,
      event: packet => { if (this.current) this.event(record, packet, delivery); },
      stderr: text => { if (this.current) this.log(record.stderrFile, text); },
      exit: error => {
        if (!this.current) { this.children.delete(record.id); delete record.unconfirmedStop; return; }
        this.peers.interrupt(record.id);
        for (const call of this.callerCalls.get(record.id) ?? []) call.abort(new Error(`${record.id} exited; its delegated call was cancelled`));
        this.callerCalls.delete(record.id);
        this.children.delete(record.id);
        this.activeRuns.delete(record.id);
        this.abortIntents.delete(record.id);
        record.queuedAssignments = [];
        delete record.unconfirmedStop;
        delete record.uncertainSubmission; // An observed close fences late RPC acceptance.
        delete record.pid;
        const expected = record.status === "stopping" || this.shuttingDown || !!record.hold;
        record.status = expected ? "stopped" : "failed";
        record.activity = expected ? "Stopped; saved conversation available" : "Process exited";
        record.uiRequests = [];
        this.inbox.expireInputNotices(record);
        if (delivery.error) record.error = delivery.error;
        else if (!expected) record.error = error?.message || "Child exited unexpectedly";
        const update = this.inbox.appendUpdate(record, expected ? "lifecycle" : "error", expected ? "Child stopped; conversation saved." : record.error!);
        if (record.assignment?.status === "running") {
          record.assignment.status = expected ? "cancelled" : "failed";
          record.assignment.finishedAt = new Date().toISOString();
          record.assignment.resultCursor = update.cursor;
          record.resultReview = { assignmentId: record.assignment.id, status: "unreviewed" };
        }
        if (expected && record.error) { record.lastError = record.error; delete record.error; }
        if (expected || !this.inbox.announce(record, "failure", record.error!, update.cursor)) this.persist(record);
        // Its Children's unread reports were waiting for it; they now go to the root.
        this.inbox.parentStopped(record.id);
      },
    });
    this.children.set(record.id, child);
    record.pid = child.child.pid;
    if (record.pid) record.startedAt ??= new Date().toISOString();
    this.persist(record);
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
      if (!this.current || this.children.get(record.id) !== child || this.usageRevision.get(record.id) !== revision) return;
      record.usage = retainFooterExtras(record.usage, stats);
      // The footer needs the latest sample now. The next durable transition (including close)
      // checkpoints it; polling cost alone must not rewrite the registry.
      this.changed();
    } catch { /* Keep the last known cumulative snapshot on failure. */ }
  }
  /** Refresh live snapshots before a user listing. Stopped children keep their last stats. */
  async refreshUsageSnapshots() {
    await Promise.all([...this.children.keys()].map(id => {
      const record = this.records.get(id);
      return record ? this.refreshUsage(record) : undefined;
    }));
  }
  private finishAssignment(record: AgentRecord, last: Update | undefined, humanCancellation = false) {
    const kind = record.error ? "failure" : record.aborted ? "aborted" : "completed";
    if (record.assignment?.status === "running") record.assignment.status = record.error ? "failed" : record.aborted ? "cancelled" : "completed";
    const text = record.error || last?.text || (record.aborted ? "Work cancelled; child remains available for instructions." : "Run settled without a text response.");
    if (!last) last = this.inbox.appendUpdate(record, record.error ? "error" : kind, text);
    if (record.assignment && !record.assignment.finishedAt) {
      record.assignment.finishedAt = new Date().toISOString();
      record.assignment.resultCursor = last.cursor;
      record.resultReview = { assignmentId: record.assignment.id, status: this.inbox.wasReviewed(record, last) ? "reviewed" : "unreviewed" };
    }
    // announce commits the result and its wake notice together, before calling
    // the scheduler. A suppressed notice still needs the settlement committed.
    if ((humanCancellation && kind === "aborted") || !this.inbox.announce(record, kind, text, last.cursor)) this.persist(record);
  }
  private deliveredInput(record: AgentRecord, delivery: InputDelivery, text: string) {
    const removed = delivery.removed, first = delivery.firstUser;
    delivery.removed = undefined;
    delivery.firstUser = false;
    if (record.hold || record.status === "stopping") return;
    const queued = record.queuedAssignments ?? [];
    // The queue snapshots contain the text *after* Pi's input hooks. A steer
    // may even be identical to a follow-up; only the depleted queue identifies it.
    const match = removed ? queued.findIndex(q => removed.queue === "followUp" && removed.text === text && q.id === removed.queuedId)
      : delivery.followUp === undefined ? queued.findIndex(q => q.task === text) : -1;
    if (match >= 0) {
      const next = queued.splice(match, 1)[0];
      if (delivery.batch && record.assignment?.status === "running") {
        // Pi's all-at-once mode delivers these together for one assistant answer.
        record.assignment.task += `\n\n${text}`;
        this.persist(record);
      } else {
        if (record.assignment && !record.assignment.finishedAt) {
          record.error = delivery.error; record.aborted = !!delivery.cancelled;
          this.finishAssignment(record, delivery.lastResult);
        }
        delivery.lastResult = undefined; delivery.error = undefined; delivery.cancelled = false;
        record.error = undefined; record.aborted = false;
        this.beginAssignment(record, text, next.id, next.at);
        delivery.batch = true;
      }
    } else if (first && !removed && !delivery.lastResult) {
      // The first prompt can be transformed as well, or an extension can
      // actually start a turn for a slash command.
      if (record.assignment?.status !== "running") this.beginAssignment(record, text);
      else if (record.assignment.task !== text) { record.assignment.task = text; this.persist(record); }
    }
  }
  private event(record: AgentRecord, packet: Packet, delivery: InputDelivery) {
    this.log(record.logFile, JSON.stringify(packet) + "\n");
    let activity = this.activityFeeds.get(record.id);
    if (!activity) this.activityFeeds.set(record.id, activity = new ActivityFeed());
    try { activity.accept(packet); }
    catch { this.activityFeeds.delete(record.id); } // Cosmetic data must never break execution.
    switch (packet.type) {
      case "queue_update":
        // AgentSession removes a delivered user message before message_start.
        delivery.removed = undefined;
        for (const queue of ["steering", "followUp"] as const) {
          const before = delivery[queue], after: string[] = packet[queue] ?? [];
          if (before?.length === after.length + 1) {
            const index = before.findIndex((text, i) => text !== after[i]);
            const text = before[index], pending = record.queuedAssignments;
            delivery.removed = { queue, text, queuedId: (pending?.find(q => q.task === text) ?? pending?.[0])?.id };
          }
          delivery[queue] = after;
        }
        break;
      case "turn_start":
        delivery.batch = false; break;
      case "agent_start":
        delivery.firstUser = true;
        record.runRevision = (record.runRevision ?? 0) + 1;
        this.activeRuns.add(record.id);
        const intent = this.abortIntents.get(record.id);
        if (intent?.awaitingStart) { intent.revision = record.runRevision; intent.awaitingStart = false; }
        else this.abortIntents.delete(record.id);
        delivery.removed = undefined;
        if (!delivery.lastResult) { record.aborted = false; record.error = undefined; }
        // A prompt accepted before its start event can be closed immediately.
        // Track cancellation identity without reviving the stopping lifecycle.
        if (record.status === "stopping") { this.persist(record); break; }
        if (record.hold && !this.aborting.has(record.id) && record.hold.kind === "halt") {
          // A prompt accepted just before the hold may start after the first abort.
          queueMicrotask(() => { if (record.hold?.kind === "halt" && this.children.has(record.id) && !this.aborting.has(record.id)) void this.abort(record.id).catch(() => {}); });
        }
        record.status = "working"; record.activity = "Working";
        this.persist(record); break;
      case "tool_execution_start":
        record.activity = `Tool: ${packet.toolName}`; this.changed(); break;
      case "message_start": {
        const message = packet.message;
        if (message?.role === "user") {
          const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((c: Packet) => c.type === "text").map((c: Packet) => c.text).join("\n");
          this.deliveredInput(record, delivery, text);
          this.peers.received(record.id, text);
        }
        delivery.removed = undefined;
        break;
      }
      case "message_end": {
        const message = packet.message;
        if (message?.role === "assistant") record.usage = noteAssistantCacheHit(record.usage, message);
        if (message?.role === "assistant" || message?.role === "toolResult") void this.refreshUsage(record);
        if (message?.role !== "assistant") break;
        delivery.firstUser = false; delivery.batch = false;
        const text = (message.content ?? []).filter((c: Packet) => c.type === "text").map((c: Packet) => c.text).join("\n");
        const terminal = !["toolUse", "error", "aborted"].includes(message.stopReason) && !message.content?.some((c: Packet) => c.type === "toolCall");
        const intent = this.abortIntents.get(record.id);
        const requestedAbort = intent && !intent.awaitingStart && intent.revision === (record.runRevision ?? 0);
        const cancelled = message.stopReason === "aborted" ||
          (message.stopReason === "error" && requestedAbort && isCancellationError(message.errorMessage));
        // Pi can retry after agent_end. Expose the diagnostic without a failure notice or review.
        if (cancelled && record.status === "stopping" && delivery.error) record.lastError = delivery.error;
        delivery.cancelled = cancelled;
        delivery.error = !cancelled && message.stopReason === "error" ? message.errorMessage || "Assistant request failed" : undefined;
        if (delivery.error) this.update(record, "provider_error", delivery.error);
        const update = text && !cancelled && !delivery.error ? this.update(record, "assistant", text, terminal) : undefined;
        delivery.lastResult = terminal ? update : undefined;
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
        record.error = delivery.error; record.aborted = !!delivery.cancelled;
        delivery.error = undefined; delivery.cancelled = false;
        if (record.status === "stopping") break;
        record.runRevision = (record.runRevision ?? 0) + 1;
        record.status = record.error ? "failed" : "idle";
        record.activity = record.error ? "Run failed; process remains available" : record.aborted ? "Work aborted; waiting for instructions" : "Waiting for instructions";
        record.uiRequests = [];
        this.inbox.expireInputNotices(record);
        this.finishAssignment(record, delivery.lastResult, humanCancellation);
        delivery.lastResult = undefined; delivery.removed = undefined;
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
          this.inbox.report(record, "input_requested", JSON.stringify(packet), "input_requested", packet.id);
        }
        break;
    }
  }
  /**
   * parent_send: a report the Child chose to send now. It reaches the parent the way
   * a finished run's report does (its subagent_wait, else when its turn ends), and a
   * nested Child's message goes to the Child that spawned it. The Child keeps working.
   */
  private messageParent(record: AgentRecord, message: string) {
    if (record.workflow) throw new Error("Workflow workers report to the workflow runtime; parent_send is unavailable.");
    if (this.shuttingDown) throw new Error("The parent is shutting down; put this in your final reply.");
    this.assertReleased(record);
    const assignmentId = record.assignment?.id ?? "";
    if (record.parentMessages?.assignmentId !== assignmentId) record.parentMessages = { assignmentId, used: 0 };
    const limit = this.parentMessageLimit;
    if (record.parentMessages.used >= limit) throw new Error(`Message limit reached for this assignment (${limit}). Put anything else in your final reply; do not retry.`);
    record.parentMessages.used++;
    this.inbox.report(record, "message", message);
    return { delivery: "queued", to: record.parentId ?? "parent", remaining: limit - record.parentMessages.used };
  }
  summary(id: string) { return this.list(true).find(record => record.id === id)!; }
  async send(id: string, message: string, behavior?: "steer" | "followUp") {
    if (!message.trim()) throw new Error("message must not be empty");
    if (this.aborting.has(id)) throw new Error("Abort is still in progress; wait for its acknowledgement before sending another task.");
    const record = this.get(id);
    this.assertDelegationOpen(record);
    if (this.shuttingDown || record.unconfirmedStop) throw new Error("Child is shutting down or stop is unconfirmed");
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
    const queued = behavior === "followUp" && (previous === "working" || previous === "waiting_input")
      ? { id: randomUUID(), task: message, at: new Date().toISOString() } : undefined;
    if (!queued && !message.startsWith("/") && record.assignment?.status !== "running") this.beginAssignment(record, message);
    else {
      if (queued) (record.queuedAssignments ??= []).push(queued);
      this.persist(record);
    }
    this.submitting.set(id, (this.submitting.get(id) ?? 0) + 1);
    let disposition: InputDisposition = "unknown";
    let noWork = false;
    let acceptedUnderHalt: HumanHold | undefined;
    try {
      try {
        const response = await child.request({ type: "prompt", message, ...(behavior ? { streamingBehavior: behavior } : {}) });
        if (["started", "queued", "handled"].includes(response?.disposition)) disposition = response.disposition;
        record.lastSubmission = { disposition, at: new Date().toISOString() };
        // A human hold installed while prompt acceptance was pending owns all later state.
        if (record.hold) {
          // Acceptance after the first clear_queue/abort can enqueue a fresh run.
          if (record.hold.kind === "halt") acceptedUnderHalt = record.hold;
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
            noWork = disposition === "handled" && previous === "idle" && state.isStreaming === false && state.pendingMessageCount === 0;
            if (noWork) record.lastSubmission.workStarted = false;
            if (record.status === "idle") record.activity = noWork ? "Input handled; no task run scheduled" : "Waiting for instructions";
          }
        }
      } catch (error) {
        if (!(error instanceof RpcRejectedError) && /^Error: RPC prompt timed out;/.test(String(error)) && this.children.get(id) === child) {
          record.uncertainSubmission ??= { at: new Date().toISOString(), reason: "Prompt acceptance timed out; a late run may still start." };
          if (record.hold?.kind === "halt" && record.hold.outcome === "confirmed") {
            record.hold.outcome = "failed";
            record.hold.detail = "Prompt acceptance timed out after halt confirmation; a late run may still start. Kill or close the process before release.";
            const text = `Human halt for ${record.name} (${id}): failed. ${record.hold.detail}`;
            this.inbox.report(record, "human_intervention", text);
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
        this.persist(record);
        throw error;
      }
      if (record.hold) throw new Error(`${id} was held while prompt acceptance was pending`);
      this.update(record, "sent", message);
      return { ...this.summary(id), disposition, ...(noWork ? { workStarted: false as const } : {}) };
    } finally {
      const remaining = (this.submitting.get(id) ?? 1) - 1;
      if (remaining) this.submitting.set(id, remaining);
      else this.submitting.delete(id);
      if (acceptedUnderHalt && record.hold === acceptedUnderHalt && this.children.get(id) === child) {
        await this.abortRuns.get(id)?.catch(() => {});
        const stopped = await this.abort(id);
        if (record.hold === acceptedUnderHalt && this.retryableHalts.has(acceptedUnderHalt) && stopped.outcome === "confirmed") {
          acceptedUnderHalt.outcome = "confirmed";
          acceptedUnderHalt.detail = "Late prompt accepted; queues cleared and active work cancelled.";
          this.inbox.report(record, "human_intervention", `Human halt for ${record.name} (${id}): confirmed. ${acceptedUnderHalt.detail}`);
        }
      }
    }
  }
  private markAbortIntent(record: AgentRecord) {
    if (this.activeRuns.has(record.id) || record.status === "working" || record.status === "waiting_input") {
      this.abortIntents.set(record.id, { revision: record.runRevision ?? 0, awaitingStart: !this.activeRuns.has(record.id) });
    }
  }
  /** Keep the fence and collect *all* outcomes, even when the target also fails. */
  private async stopSubtree(id: string, stop: (record: AgentRecord) => Promise<unknown>) {
    const target = this.get(id);
    this.fence(id);
    try {
      const subtreeFailures: string[] = [];
      for (const child of this.subtree(id)) {
        try { await stop(child); }
        catch (error) { subtreeFailures.push(`${child.id}: ${String(error)}`); }
      }
      let targetDetail: string | undefined;
      try { await stop(target); }
      catch (error) { targetDetail = String(error); }
      return { ...this.summary(id), targetOutcome: targetDetail ? "unconfirmed" : "confirmed", targetDetail,
        outcome: targetDetail || subtreeFailures.length ? "unconfirmed" : "confirmed", subtreeFailures };
    } finally { this.unfence(id); }
  }
  async abort(id: string) {
    if (this.aborting.has(id)) throw new Error("Abort is already in progress");
    return this.stopSubtree(id, async record => {
      if (this.children.has(record.id)) await (this.abortRuns.get(record.id) ?? this.abortOne(record));
      else this.checkDetached(record);
    });
  }
  /** Human command only, after independent inspection; never signal a recovered PID. */
  confirmDetachedStop(id: string) {
    const record = this.get(id);
    if (this.children.has(id) || !record.unconfirmedStop) throw new Error("Only a detached, unconfirmed stop can be cleared.");
    delete record.unconfirmedStop; delete record.uncertainSubmission; delete record.pid;
    record.status = "stopped";
    record.activity = "Stop confirmed by operator; no process attached.";
    this.update(record, "lifecycle", record.activity);
  }
  private checkDetached(record: AgentRecord) {
    if (record.unconfirmedStop || record.uncertainSubmission) throw new Error("Process stop unconfirmed; inspect for orphaned work.");
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
    this.persist(record); // Durable before clear_queue can discard a queued follow-up.
    this.markAbortIntent(record); // Before awaiting anything: adapters may emit cancellation immediately.
    try {
      await child.request({ type: "clear_queue" });
      this.markAbortIntent(record); // A queued run may have started while clearing.
      await child.request({ type: "abort" });
      const state = await child.request({ type: "get_state" });
      if (state.isStreaming !== false) throw new Error("Abort acknowledged but child still reports streaming or unknown state; cancellation unconfirmed");
      if (this.submitting.has(id)) throw new SubmissionInFlight("Prompt submission is still in flight; a late run may still start. Cancellation unconfirmed.");
      if (record.uncertainSubmission) throw new Error("Prompt acceptance remains unknown; cancellation unconfirmed. Kill or close the process before release.");
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
    if (kind === "kill" && this.children.has(id)) record.unconfirmedStop = "Awaiting process kill confirmation";
    record.queuedAssignments = [];
    this.inbox.report(record, "human_intervention", `Human ${kind} requested for ${record.name} (${id}); cancellation pending.`);
    let hookError: unknown;
    try { this.interventionHook?.(record, kind); beforeCancel?.(record, kind); }
    catch (error) { hookError = error; }
    let targetDetail: string, targetOutcome: "confirmed" | "unconfirmed", pendingSubmission = false;
    try {
      const child = this.children.get(id);
      if (kind === "kill") {
        this.peers.interrupt(id);
        if (!child) throw new Error("No managed process attached; force termination cannot be confirmed. Inspect for orphaned work.");
        try { await child.kill(); }
        catch (error) { if (this.children.get(id) === child) record.unconfirmedStop = String(error); throw error; }
      } else if (child) await this.abortOne(record);
      else this.checkDetached(record);
      if (hookError) throw new Error(`Workflow pause hook failed: ${String(hookError)}`);
      targetOutcome = "confirmed";
      targetDetail = kind === "kill" ? "Process force-killed (SIGKILL); conversation retained." : child
        ? "Queues cleared and active work cancelled; process/conversation retained."
        : "No managed process attached; hold applied to saved conversation.";
    } catch (error) {
      targetOutcome = "unconfirmed";
      targetDetail = String(error);
      pendingSubmission = error instanceof SubmissionInFlight;
    }
    if (record.hold === hold && record.assignment?.status === "running" && targetOutcome === "confirmed") {
      record.assignment.status = "cancelled";
      record.assignment.finishedAt = new Date().toISOString();
      record.assignment.resultCursor = record.cursor;
      record.resultReview = { assignmentId: record.assignment.id, status: "unreviewed" };
    }
    // Keep the target pending (and unreleasable) until every descendant has an outcome.
    const subtreeFailures: string[] = [];
    if (!nested) for (const descendant of this.subtree(id).reverse()) {
      const descendantKind = kind === "kill" && this.children.has(descendant.id) ? "kill" : "halt";
      try {
        if (this.supersedes(descendant, descendantKind)) await this.intervene(descendant.id, descendantKind, beforeCancel, true);
        if (descendant.hold?.outcome !== "confirmed") subtreeFailures.push(`${descendant.id}: ${descendant.hold?.detail ?? "intervention not confirmed"}`);
      } catch (error) { subtreeFailures.push(`${descendant.id}: ${String(error)}`); }
    }
    if (record.hold !== hold) {
      targetOutcome = "unconfirmed";
      targetDetail = `Superseded by human ${record.hold?.kind ?? "intervention"}; prior ${kind} result cannot confirm current state.`;
    }
    const confirmed = targetOutcome === "confirmed" && !subtreeFailures.length;
    if (pendingSubmission && !hookError && !subtreeFailures.length) this.retryableHalts.add(hold);
    hold.outcome = confirmed ? "confirmed" : "failed";
    hold.detail = subtreeFailures.length
      ? `Target ${id}: ${targetOutcome}. ${targetDetail} Unconfirmed descendants: ${subtreeFailures.join("; ")}` : targetDetail;
    const text = `Human ${kind} for ${record.name} (${id}): ${hold.outcome}. ${hold.detail}`;
    this.inbox.report(record, "human_intervention", text);
    return { ...this.summary(id), hold: structuredClone(hold), targetOutcome, targetDetail, outcome: confirmed ? "confirmed" : "unconfirmed", subtreeFailures };
  }
  /** Parent-only release: clearing a hold never resumes, prompts, or restarts work. */
  releaseHold(id: string) {
    const record = this.get(id);
    if (!record.hold) throw new Error(`${id} has no human hold`);
    if (record.uncertainSubmission) throw new Error(this.children.has(id)
      ? `${id} has uncertain prompt acceptance; kill or close its process before releasing the hold.`
      : `${id} has uncertain prompt acceptance and no attached process. The manager cannot confirm its exit. Inspect for orphaned work before manual recovery.`);
    if (this.aborting.has(id) || this.submitting.has(id) || [...this.responding].some(key => key.startsWith(`${id}:`)) || record.hold.outcome === "pending") {
      throw new Error(`${id} intervention/submission is still in flight; wait before releasing the hold`);
    }
    delete record.hold;
    this.update(record, "lifecycle", "Human hold released by parent; no work started.");
    return this.summary(id);
  }
  async close(id: string, preserveNotices = false) {
    return this.stopSubtree(id, record => this.closeOne(record, preserveNotices));
  }
  private async closeOne(record: AgentRecord, preserveNotices: boolean) {
    const id = record.id;
    record.queuedAssignments = [];
    this.workflowChildren.delete(id);
    // Explicit close means abandon ordinary reports, never human intervention.
    // Reload/exit shutdown deliberately preserves unread results for recovery.
    if (!preserveNotices) this.inbox.dismissRoutine(record);
    const child = this.children.get(id);
    if (!child) {
      this.checkDetached(record);
      if (record.error) { record.lastError = record.error; delete record.error; }
      record.status = "stopped";
      record.activity = "Stopped; retained history available";
      this.persist(record);
      return this.summary(id);
    }
    this.markAbortIntent(record);
    record.status = "stopping";
    record.unconfirmedStop = "Awaiting process close confirmation";
    this.peers.interrupt(id);
    this.persist(record);
    // Cancel active tools before terminating the process. Cleanup still happens
    // if a wedged child cannot acknowledge cancellation.
    await child.request({ type: "clear_queue" }, 1000).catch(() => {});
    await child.request({ type: "abort" }, 2000).catch(() => {});
    // Capture the final cumulative cost even when closing interrupts a run.
    // On failure retain the last known snapshot rather than resetting to zero.
    await this.refreshUsage(record);
    try { await child.stop(); }
    catch (error) {
      record.activity = record.unconfirmedStop = `Process close unconfirmed: ${String(error)}`;
      this.persist(record);
      throw error;
    }
    return this.summary(id);
  }
  async resume(id: string, message?: string, env?: Record<string, string>) {
    const record = this.get(id);
    if (record.archiveError) throw new Error(record.archiveError);
    this.assertDelegationOpen(record);
    this.checkDetached(record);
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
      return this.failedLaunch(record, error);
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
      this.inbox.expireInputNotices(record);
      if (record.uiRequests.length) record.status = "waiting_input";
      else if (record.status === "waiting_input") {
        record.status = "working";
        record.activity = "UI response queued; awaiting child continuation";
      }
      this.persist(record);
      return { ...this.summary(id), responseDelivery: { transport: "queued" as const, receipt: "unconfirmed" as const } };
    } finally {
      this.responding.delete(key);
    }
  }
  /** callerId: the coordinator Child waiting, or undefined for the root Parent. */
  async wait(ids: readonly string[], mode: "any" | "all", timeoutMs?: number, signal?: AbortSignal, messageQueued?: () => boolean, callerId?: string): Promise<WaitEnd> {
    const selected = ids.length ? [...ids] : [...this.records.values()]
      .filter(record => !record.rejected && !record.workflow && this.inbox.reportsDrainedBy(record.id) === callerId)
      .map(record => record.id);
    for (const id of selected) this.get(id);
    const watched = new Set(selected);
    // Only messages this caller will collect: a grandchild's message is its coordinator's.
    const childMessage = () => this.inbox.hasMessage(watched, callerId);
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    const end = (wake: WaitEnd["wake"]): WaitEnd => ({ wake, ids: selected });
    while (true) {
      signal?.throwIfAborted();
      const records = selected.map(id => this.get(id));
      // Descendant results belong to their coordinator; a descendant's dialog or
      // hold belongs to the root. Include blockers in the report, not in readiness.
      const blockers = callerId ? [] : [...this.records.values()].filter(record =>
        !watched.has(record.id) && (record.hold || record.status === "waiting_input")
        && (!ids.length || this.ancestorsOf(record.id).some(id => watched.has(id))));
      if (blockers.length || records.some(record => record.hold || record.status === "waiting_input")) {
        return { wake: [...records, ...blockers].some(record => record.hold) ? "hold" : "input",
          ids: [...selected, ...blockers.map(record => record.id)] };
      }
      const ready = records.filter(record => !BUSY.has(record.status)).length;
      if (!selected.length || (mode === "any" ? ready > 0 : ready === selected.length)) return end("settled");
      if (childMessage()) return end("child_message");
      if (messageQueued?.()) return end("message");
      if (Date.now() >= deadline) return end("timeout");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async shutdown() {
    this.shuttingDown = true;
    this.reservations.clear();
    this.reservedSlots = 0;
    const failures: string[] = [];
    await Promise.all([...this.children.keys()].map(id => this.closeOne(this.get(id), true)
      .catch(error => { failures.push(`${id}: ${String(error)}`); })));
    if (this.current) SubagentManager.owners.delete(this.store.path);
    if (failures.length) throw new Error(`Shutdown unconfirmed: ${failures.join("; ")}`);
  }
}
