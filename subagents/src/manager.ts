import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { RpcChild, type Packet } from "./rpc.js";
import type { Composition } from "./policy.js";
import { summarizeAgents } from "./usage.js";

export type Status = "starting" | "working" | "waiting_input" | "idle" | "stopping" | "stopped" | "failed";
export interface SpawnOptions {
  name: string; task: string; cwd: string;
  model?: string; thinking?: string; tools?: string[];
  executable?: string; executableArgs?: string[]; cliArgs?: string[];
  inheritExtensions?: boolean; env?: Record<string, string>;
  selection?: Composition;
}
export interface Update { cursor: number; kind: string; text: string; time: string }
export interface AgentRecord {
  id: string; name: string; task: string; status: Status;
  config: Omit<SpawnOptions, "env" | "task" | "name">;
  sessionFile: string; sessionId?: string; logFile: string; stderrFile: string;
  createdAt: string; updatedAt: string; pid?: number;
  model?: string; thinking?: string; activity?: string; error?: string; lastError?: string;
  rejected?: boolean; startedAt?: string;
  usage?: unknown; updates: Update[]; cursor: number; readCursor: number;
  uiRequests: Packet[]; hadEnvOverrides: boolean;
  runStartCursor?: number; aborted?: boolean; runRevision?: number;
  observedCursors?: number[];
}
export interface Notice { id: string; name: string; kind: string; text: string; cursor: number; key: string; requestId?: string }
export interface ReadReceipt { id: string; updates: Update[]; nextCursor: number; uiRequests: Packet[] }
const MAX_LOG = 20 * 1024 * 1024;
const RESERVED = new Set(["--mode", "-p", "--print", "--session", "--session-dir", "--no-session", "--fork", "-c", "--continue", "-r", "--resume", "--export", "--"]);
const BUSY = new Set<Status>(["starting", "working", "waiting_input", "stopping"]);
const REPORT_KINDS = new Set(["assistant", "error", "extension_error", "input_requested", "aborted", "completed", "failure"]);
// Deliberately narrow: a generic failure mentioning cancellation is still a failure.
export function isCancellationError(message: unknown): boolean {
  return typeof message === "string" && /^(?:AbortError:\s*)?(?:(?:(?:the|this) )?operation (?:was )?aborted|request (?:was )?aborted|aborted|cancelled|canceled)[.!]?$/i.test(message.trim());
}

export class SubagentManager {
  private records = new Map<string, AgentRecord>();
  private children = new Map<string, RpcChild>();
  private logSizes = new Map<string, number>();
  private shuttingDown = false;
  private verifiedTools = new Map<string, string[]>();
  private notices = new Map<string, Notice>();
  private activeRuns = new Set<string>();
  private abortIntents = new Map<string, { revision: number; awaitingStart: boolean }>();
  private aborting = new Set<string>();
  private usageRevision = new Map<string, number>();
  private registry: string;
  constructor(readonly directory: string, private notice: (notice: Notice) => void = () => {}, private changed: () => void = () => {}, readonly maxChildren = 4, private authorize?: (config: AgentRecord["config"]) => AgentRecord["config"]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.registry = join(directory, "registry.json");
    if (existsSync(this.registry)) {
      const stored = JSON.parse(readFileSync(this.registry, "utf8"));
      if (stored.version !== 1 || !Array.isArray(stored.agents)) throw new Error("Unsupported subagent registry");
      for (const record of stored.agents as AgentRecord[]) {
        // Keep old cap-preflight artifacts inspectable, but don't count
        // them as agents by default. Never hide actual process launch failures.
        if (!record.sessionId && !record.startedAt && !existsSync(record.sessionFile) &&
            /^Error: Live-child limit \(\d+\) reached;/.test(record.error ?? "")) record.rejected = true;
        record.status = record.status === "failed" ? "failed" : "stopped";
        if (record.status === "stopped" && record.error) {
          record.lastError = record.error; delete record.error;
        }
        delete record.pid;
        record.uiRequests = [];
        record.activity = "No process attached. Resume explicitly to continue the saved conversation.";
        this.records.set(record.id, record);
      }
      // Old registries have no pending queue: never reconstruct already-sent reports.
      for (const notice of (stored.pendingNotices ?? []) as Notice[]) {
        const record = this.records.get(notice.id);
        if (record && notice.kind !== "input_requested" && !record.observedCursors?.includes(notice.cursor)) this.notices.set(notice.key, notice);
      }
    }
  }
  private persist() {
    const temp = this.registry + ".tmp";
    writeFileSync(temp, JSON.stringify({ version: 1, agents: [...this.records.values()], pendingNotices: [...this.notices.values()] }, null, 2), { mode: 0o600 });
    renameSync(temp, this.registry);
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
    if (this.shuttingDown || record.observedCursors?.includes(cursor)) return;
    const key = `${record.id}:${cursor}:${kind}`;
    if (this.notices.has(key)) return;
    const notice = { id: record.id, name: record.name, kind, text: text.slice(0, 4000), cursor, key, requestId };
    this.notices.set(key, notice);
    this.persist();
    this.notice(notice); // Wake the delivery scheduler; don't inject into the parent here.
  }
  pendingNotices(): Notice[] { return [...this.notices.values()]; }
  private observe(record: AgentRecord, cursors: number[]) {
    record.observedCursors = [...new Set([...(record.observedCursors ?? []), ...cursors])].sort((a, b) => a - b).slice(-200);
    const seen = new Set(cursors);
    for (const [key, notice] of this.notices) if (notice.id === record.id && seen.has(notice.cursor)) this.notices.delete(key);
  }
  markNoticesDelivered(keys: string[]) {
    for (const key of keys) {
      const notice = this.notices.get(key);
      if (notice) this.observe(this.get(notice.id), [notice.cursor]);
    }
    this.persist();
  }
  acknowledgeRead(receipt: ReadReceipt, advanceCursor: boolean) {
    const record = this.get(receipt.id);
    const cursors = receipt.updates.map(update => update.cursor);
    const requests = new Set(receipt.uiRequests.map(request => request.id));
    for (const notice of this.notices.values()) {
      if (notice.id === record.id && notice.requestId && requests.has(notice.requestId)) cursors.push(notice.cursor);
    }
    this.observe(record, cursors);
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
  private child(id: string) {
    this.get(id);
    const child = this.children.get(id);
    if (!child) throw new Error(`${id} has no running process. Use subagent_resume.`);
    return child;
  }
  list(includeRejected = false) {
    return [...this.records.values()].filter(record => includeRejected || !record.rejected).map(({ updates, config, runStartCursor, runRevision, observedCursors, ...record }) => {
      const unreadUpdates = updates.filter(u => u.cursor > record.readCursor);
      return {
        ...record, cwd: config.cwd,
        unread: unreadUpdates.filter(u => REPORT_KINDS.has(u.kind)).length,
        unreadAssistant: unreadUpdates.filter(u => u.kind === "assistant").length,
        unreadUpdates: unreadUpdates.length,
        uiRequests: record.uiRequests.map(({ id, method, title }) => ({ id, method, title })),
      };
    });
  }
  overview(includeRejected = false) {
    return { totals: summarizeAgents(this.list()), agents: this.list(includeRejected) };
  }
  private preflight(config: AgentRecord["config"], overrides?: Record<string, string>) {
    if (this.shuttingDown) throw new Error("Manager is shutting down");
    if (this.children.size >= this.maxChildren) throw new Error(`Live-child limit (${this.maxChildren}) reached; close an idle child first.`);
    if (this.authorize && overrides) throw new Error("Environment overrides are disabled by managed spawn policy");
    const checked = this.authorize ? this.authorize(config) : config;
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
      updates, nextCursor, hasMore: record.cursor > nextCursor,
      gap: record.updates.length > 0 && cursor < record.updates[0].cursor - 1,
      uiRequests: record.uiRequests, sessionFile: record.sessionFile,
      logFile: record.logFile, stderrFile: record.stderrFile, error: record.error,
    };
    if (acknowledge) this.acknowledgeRead(result, since === undefined);
    return result;
  }
  async spawn(options: SpawnOptions) {
    const id = `subagent-${randomUUID().slice(0, 8)}`;
    const { name, task, env, ...requested } = options;
    if (!name.trim() || !task.trim()) throw new Error("name and task must not be empty");
    // No record/session/log paths for requests rejected before any launch attempt.
    const config = this.preflight(requested, env);
    const record: AgentRecord = {
      id, name, task, config, status: "stopped",
      sessionFile: join(this.directory, `${id}.session.jsonl`),
      logFile: join(this.directory, `${id}.events.jsonl`),
      stderrFile: join(this.directory, `${id}.stderr.log`),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      updates: [], cursor: 0, readCursor: 0, uiRequests: [], hadEnvOverrides: !!env,
    };
    this.records.set(id, record);
    try {
      await this.start(record, env);
      await this.send(id, task);
      return this.summary(id);
    } catch (error) {
      if (this.children.has(id)) await this.close(id);
      record.status = "failed";
      record.error = String(error);
      this.update(record, "error", String(error));
      throw new Error(`${id}: ${error}. Diagnostics: ${record.stderrFile}`);
    }
  }
  private async start(record: AgentRecord, overrides?: Record<string, string>) {
    if (this.children.has(record.id)) throw new Error(`${record.id} already has a process`);
    const config = this.preflight(record.config, overrides);
    record.config = config;
    const extra = config.cliArgs ?? [];
    const args = [...(config.executableArgs ?? [])];
    if (!config.inheritExtensions) args.push("--no-extensions");
    if (config.model) args.push("--model", config.model);
    if (config.thinking) args.push("--thinking", config.thinking);
    if (config.tools?.length) args.push("--tools", config.tools.join(","));
    else if (config.tools) args.push("--no-tools");
    args.push(...extra, "--mode", "rpc", "--session", record.sessionFile);
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT: "1" };
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    if (this.authorize && overrides) throw new Error("Environment overrides are disabled by managed spawn policy");
    Object.assign(env, overrides);
    env.PI_SUBAGENT = "1";
    if (config.selection) env.PI_SUBAGENT_ALLOWED_TOOLS = JSON.stringify(config.tools ?? []);
    this.verifiedTools.delete(record.id);
    this.abortIntents.delete(record.id);
    this.activeRuns.delete(record.id);
    record.aborted = false;
    record.status = "starting";
    record.error = undefined;
    record.uiRequests = [];
    const child = new RpcChild({
      executable: config.executable || "pi", args, cwd: resolve(config.cwd), env,
      event: packet => this.event(record, packet),
      stderr: text => this.log(record.stderrFile, text),
      exit: error => {
        this.children.delete(record.id);
        this.activeRuns.delete(record.id);
        this.abortIntents.delete(record.id);
        delete record.pid;
        const expected = record.status === "stopping" || this.shuttingDown;
        record.status = expected ? "stopped" : "failed";
        record.activity = expected ? "Stopped; saved conversation available" : "Process exited";
        record.uiRequests = [];
        this.expireInputNotices(record);
        if (!expected) record.error = error?.message || "Child exited unexpectedly";
        else if (record.error) { record.lastError = record.error; delete record.error; }
        this.update(record, expected ? "lifecycle" : "error", expected ? "Child stopped; conversation saved." : record.error!);
        if (!expected) this.announce(record, "failure", record.error!);
      },
    });
    this.children.set(record.id, child);
    record.pid = child.child.pid;
    if (record.pid) record.startedAt ??= new Date().toISOString();
    this.persist();
    const state = await child.request({ type: "get_state" });
    if (!state.sessionFile || resolve(state.sessionFile) !== resolve(record.sessionFile)) {
      throw new Error("Child did not use the managed persistent session file");
    }
    if (config.selection) {
      const expected = config.selection.model;
      const actual = state.model ? `${state.model.provider}/${state.model.id}:${state.thinkingLevel}` : "no-model";
      if (actual !== expected) throw new Error(`Child resolved ${actual}, expected exactly ${expected}; refusing fallback.`);
      await child.request({ type: "prompt", message: "/_child-policy-check" });
      const tools = this.verifiedTools.get(record.id);
      if (!tools || tools.some(name => name.startsWith("subagent_")) || (config.tools ?? []).some(name => !tools.includes(name))) {
        throw new Error("Child tool policy check failed: selected tools unavailable, or mandatory guard did not load.");
      }
    }
    record.sessionId = state.sessionId;
    record.model = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
    record.thinking = state.thinkingLevel;
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
      record.usage = stats;
      this.persist(); // Also refreshes the parent's footer while the child is busy.
    } catch { /* Keep the last known cumulative snapshot on failure. */ }
  }
  private event(record: AgentRecord, packet: Packet) {
    this.log(record.logFile, JSON.stringify(packet) + "\n");
    switch (packet.type) {
      case "agent_start":
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
        record.status = "working"; record.error = undefined; record.activity = "Working";
        this.persist(); break;
      case "tool_execution_start":
        record.activity = `Tool: ${packet.toolName}`; this.changed(); break;
      case "message_end": {
        const message = packet.message;
        if (message?.role === "assistant" || message?.role === "toolResult") void this.refreshUsage(record);
        if (message?.customType === "child-policy-check" && Array.isArray(message.details?.tools)) {
          this.verifiedTools.set(record.id, message.details.tools);
        }
        if (message?.role !== "assistant") break;
        const text = (message.content ?? []).filter((c: Packet) => c.type === "text").map((c: Packet) => c.text).join("\n");
        if (text) this.update(record, "assistant", text);
        const intent = this.abortIntents.get(record.id);
        const requestedAbort = intent && !intent.awaitingStart && intent.revision === (record.runRevision ?? 0);
        const cancelled = message.stopReason === "aborted" ||
          (message.stopReason === "error" && requestedAbort && isCancellationError(message.errorMessage));
        if (cancelled) {
          if (!record.aborted) {
            record.aborted = true;
            this.update(record, "aborted", "Work cancelled; child remains available for instructions.");
          }
        } else if (message.stopReason === "error") {
          record.error = message.errorMessage || "Assistant request failed";
          this.update(record, "error", record.error!);
        }
        break;
      }
      case "turn_end":
      case "compaction_end":
        void this.refreshUsage(record); break;
      case "agent_settled": {
        this.activeRuns.delete(record.id);
        this.abortIntents.delete(record.id);
        if (record.status === "stopping") break;
        record.runRevision = (record.runRevision ?? 0) + 1;
        record.status = record.error ? "failed" : "idle";
        record.activity = record.error ? "Run failed; process remains available" : record.aborted ? "Work aborted; waiting for instructions" : "Waiting for instructions";
        record.uiRequests = [];
        this.expireInputNotices(record);
        const kind = record.error ? "failure" : record.aborted ? "aborted" : "completed";
        const last = record.updates.findLast(u => u.kind === (record.error ? "error" : record.aborted ? "aborted" : "assistant") && u.cursor > (record.runStartCursor ?? 0));
        const text = record.error || last?.text || "Run settled without a text response.";
        if (!last) this.update(record, kind, text);
        this.persist();
        this.announce(record, kind, text, last?.cursor ?? record.cursor);
        void this.refreshUsage(record);
        break;
      }
      case "extension_error":
        this.update(record, "extension_error", packet.error || JSON.stringify(packet)); break;
      case "extension_ui_request":
        if (record.status === "stopping") break;
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
    const child = this.child(id);
    // Acceptance can precede agent_start on a later stdout chunk. Reserve the
    // busy state first so an immediate wait cannot mistake acceptance for idle.
    const previous = record.status;
    const revision = record.runRevision;
    if (previous !== "waiting_input") {
      record.status = "working";
      record.activity = "Submitting prompt / awaiting agent events";
    }
    this.persist();
    try {
      await child.request({ type: "prompt", message, ...(behavior ? { streamingBehavior: behavior } : {}) });
      // Slash commands can complete without ever starting an agent run.
      if (message.startsWith("/") && record.runRevision === revision) {
        const state = await child.request({ type: "get_state" });
        if (record.runRevision === revision) record.status = state.isStreaming ? "working" : "idle";
      }
    } catch (error) {
      if (record.runRevision === revision && this.children.has(id)) {
        if (String(error).includes("timed out")) record.activity = "Prompt acceptance unknown after timeout; inspect before retrying.";
        else record.status = previous;
      }
      this.persist();
      throw error;
    }
    this.update(record, "sent", message);
    return this.summary(id);
  }
  private markAbortIntent(record: AgentRecord) {
    if (this.activeRuns.has(record.id) || record.status === "working" || record.status === "waiting_input") {
      this.abortIntents.set(record.id, { revision: record.runRevision ?? 0, awaitingStart: !this.activeRuns.has(record.id) });
    }
  }
  async abort(id: string) {
    const record = this.get(id);
    const child = this.child(id);
    if (this.aborting.has(id)) throw new Error("Abort is already in progress");
    this.aborting.add(id);
    this.markAbortIntent(record); // Before awaiting anything: adapters may emit cancellation immediately.
    try {
      await child.request({ type: "clear_queue" });
      this.markAbortIntent(record); // A queued run may have started while clearing.
      await child.request({ type: "abort" });
      return this.summary(id);
    } finally {
      this.aborting.delete(id);
      // On timeout the run may still deliver cancellation later. Keep its scoped
      // intent until settle/new-run/exit, rather than misclassifying a late abort.
      if (!this.activeRuns.has(id) && record.status !== "working") this.abortIntents.delete(id);
    }
  }
  async close(id: string, preserveNotices = false) {
    const record = this.get(id);
    // Explicit close means abandon pending notifications, not erase results.
    // Reload/exit shutdown deliberately preserves unread results for recovery.
    if (!preserveNotices) {
      this.observe(record, this.pendingNotices().filter(n => n.id === id).map(n => n.cursor));
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
    if (this.children.has(id)) throw new Error(`${id} already has a process`);
    if (!existsSync(record.sessionFile)) throw new Error("No saved child session exists");
    if (!this.authorize && record.hadEnvOverrides && !env) throw new Error("This child used environment overrides. Supply them again; they are not stored.");
    this.preflight(record.config, env);
    try {
      await this.start(record, env);
      if (message) await this.send(id, message);
      return this.summary(id);
    } catch (error) {
      if (this.children.has(id)) await this.close(id);
      record.status = "failed"; record.error = String(error); this.persist();
      throw error;
    }
  }
  respond(id: string, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const record = this.get(id);
    if (!record.uiRequests.some(r => r.id === requestId)) throw new Error("Unknown or expired UI request");
    this.child(id).respond({ type: "extension_ui_response", id: requestId, ...response });
    record.uiRequests = record.uiRequests.filter(r => r.id !== requestId);
    this.expireInputNotices(record);
    record.status = record.uiRequests.length ? "waiting_input" : "working";
    this.persist();
    return this.summary(id);
  }
  async wait(ids: string[], mode: "any" | "all", timeoutMs: number, signal?: AbortSignal) {
    const selected = ids.length ? ids : this.list().map(record => record.id);
    for (const id of selected) this.get(id);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const statuses = selected.map(id => this.summary(id));
      const ready = statuses.filter(r => !BUSY.has(r.status));
      if (!selected.length || (mode === "any" ? ready.length > 0 : ready.length === selected.length)) return { timedOut: false, agents: statuses };
      // Human/extension input must be surfaced, not hidden behind a long wait.
      if (statuses.some(r => r.status === "waiting_input")) return { timedOut: false, needsInput: true, agents: statuses };
      if (Date.now() >= deadline) return { timedOut: true, agents: statuses };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async shutdown() {
    this.shuttingDown = true;
    await Promise.all([...this.children.keys()].map(id => this.close(id, true)));
  }
}
