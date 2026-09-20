import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { RpcChild, type Packet } from "./rpc.js";

export type Status = "starting" | "working" | "waiting_input" | "idle" | "stopping" | "stopped" | "failed";
export interface SpawnOptions {
  name: string; task: string; cwd: string;
  model?: string; thinking?: string; tools?: string[];
  executable?: string; executableArgs?: string[]; cliArgs?: string[];
  inheritExtensions?: boolean; env?: Record<string, string>;
}
export interface Update { cursor: number; kind: string; text: string; time: string }
export interface AgentRecord {
  id: string; name: string; task: string; status: Status;
  config: Omit<SpawnOptions, "env" | "task" | "name">;
  sessionFile: string; sessionId?: string; logFile: string; stderrFile: string;
  createdAt: string; updatedAt: string; pid?: number;
  model?: string; thinking?: string; activity?: string; error?: string;
  usage?: unknown; updates: Update[]; cursor: number; readCursor: number;
  uiRequests: Packet[]; hadEnvOverrides: boolean;
  runStartCursor?: number; aborted?: boolean; runRevision?: number;
}
export interface Notice { id: string; name: string; kind: string; text: string }
const MAX_LOG = 20 * 1024 * 1024;
const RESERVED = new Set(["--mode", "-p", "--print", "--session", "--session-dir", "--no-session", "--fork", "-c", "--continue", "-r", "--resume", "--export", "--"]);
const BUSY = new Set<Status>(["starting", "working", "waiting_input", "stopping"]);

export class SubagentManager {
  private records = new Map<string, AgentRecord>();
  private children = new Map<string, RpcChild>();
  private logSizes = new Map<string, number>();
  private shuttingDown = false;
  private registry: string;
  constructor(readonly directory: string, private notice: (notice: Notice) => void = () => {}, private changed: () => void = () => {}, readonly maxChildren = 4) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.registry = join(directory, "registry.json");
    if (existsSync(this.registry)) {
      const stored = JSON.parse(readFileSync(this.registry, "utf8"));
      if (stored.version !== 1 || !Array.isArray(stored.agents)) throw new Error("Unsupported subagent registry");
      for (const record of stored.agents as AgentRecord[]) {
        record.status = record.status === "failed" ? "failed" : "stopped";
        delete record.pid;
        record.uiRequests = [];
        record.activity = "No process attached. Resume explicitly to continue the saved conversation.";
        this.records.set(record.id, record);
      }
    }
  }
  private persist() {
    const temp = this.registry + ".tmp";
    writeFileSync(temp, JSON.stringify({ version: 1, agents: [...this.records.values()] }, null, 2), { mode: 0o600 });
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
  private announce(record: AgentRecord, kind: string, text: string) {
    if (!this.shuttingDown) this.notice({ id: record.id, name: record.name, kind, text: text.slice(0, 4000) });
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
  list() {
    return [...this.records.values()].map(({ updates, config, runStartCursor, runRevision, aborted, ...record }) => ({
      ...record, cwd: config.cwd, unread: updates.filter(u => u.cursor > record.readCursor).length,
      uiRequests: record.uiRequests.map(({ id, method, title }) => ({ id, method, title })),
    }));
  }
  read(id: string, since?: number) {
    const record = this.get(id);
    const cursor = since ?? record.readCursor;
    const updates: Update[] = [];
    let size = 0;
    for (const update of record.updates.filter(u => u.cursor > cursor)) {
      if (size + update.text.length > 24000 && updates.length) break;
      updates.push(update); size += update.text.length;
    }
    const nextCursor = updates.at(-1)?.cursor ?? cursor;
    if (since === undefined) { record.readCursor = nextCursor; this.persist(); }
    return {
      id, name: record.name, status: record.status, activity: record.activity,
      updates, nextCursor, hasMore: record.cursor > nextCursor,
      gap: record.updates.length > 0 && cursor < record.updates[0].cursor - 1,
      uiRequests: record.uiRequests, sessionFile: record.sessionFile,
      logFile: record.logFile, stderrFile: record.stderrFile, error: record.error,
    };
  }
  async spawn(options: SpawnOptions) {
    const id = `subagent-${randomUUID().slice(0, 8)}`;
    const { name, task, env, ...config } = options;
    if (!name.trim() || !task.trim()) throw new Error("name and task must not be empty");
    if (!isAbsolute(config.cwd)) throw new Error("cwd must be an absolute path");
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
      record.error = String(error);
      if (this.children.has(id)) await this.close(id);
      record.status = "failed";
      this.update(record, "error", String(error));
      throw new Error(`${id}: ${error}. Diagnostics: ${record.stderrFile}`);
    }
  }
  private async start(record: AgentRecord, overrides?: Record<string, string>) {
    if (this.shuttingDown) throw new Error("Manager is shutting down");
    if (this.children.has(record.id)) throw new Error(`${record.id} already has a process`);
    if (this.children.size >= this.maxChildren) throw new Error(`Live-child limit (${this.maxChildren}) reached; close an idle child first.`);
    const config = record.config;
    const extra = config.cliArgs ?? [];
    if (extra.some(arg => RESERVED.has(arg.split("=")[0]))) throw new Error("cliArgs cannot override manager-owned RPC mode/session flags, print/export modes, or contain --");
    const args = [...(config.executableArgs ?? [])];
    if (!config.inheritExtensions) args.push("--no-extensions");
    if (config.model) args.push("--model", config.model);
    if (config.thinking) args.push("--thinking", config.thinking);
    if (config.tools?.length) args.push("--tools", config.tools.join(","));
    else if (config.tools) args.push("--no-tools");
    args.push(...extra, "--mode", "rpc", "--session", record.sessionFile);
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT: "1" };
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    Object.assign(env, overrides);
    record.status = "starting";
    record.error = undefined;
    record.uiRequests = [];
    const child = new RpcChild({
      executable: config.executable || "pi", args, cwd: resolve(config.cwd), env,
      event: packet => this.event(record, packet),
      stderr: text => this.log(record.stderrFile, text),
      exit: error => {
        this.children.delete(record.id);
        delete record.pid;
        const expected = record.status === "stopping" || this.shuttingDown;
        record.status = expected ? "stopped" : "failed";
        record.activity = expected ? "Stopped; saved conversation available" : "Process exited";
        record.uiRequests = [];
        if (!expected) record.error = error?.message || "Child exited unexpectedly";
        this.update(record, expected ? "lifecycle" : "error", expected ? "Child stopped; conversation saved." : record.error!);
        if (!expected) this.announce(record, "failure", record.error!);
      },
    });
    this.children.set(record.id, child);
    record.pid = child.child.pid;
    this.persist();
    const state = await child.request({ type: "get_state" });
    if (!state.sessionFile || resolve(state.sessionFile) !== resolve(record.sessionFile)) {
      throw new Error("Child did not use the managed persistent session file");
    }
    record.sessionId = state.sessionId;
    record.model = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
    record.thinking = state.thinkingLevel;
    record.status = state.isStreaming ? "working" : "idle";
    this.update(record, "lifecycle", `Child ready: ${record.model ?? "no model"}, thinking=${record.thinking}`);
  }
  private event(record: AgentRecord, packet: Packet) {
    this.log(record.logFile, JSON.stringify(packet) + "\n");
    switch (packet.type) {
      case "agent_start":
        if (record.status === "stopping") break;
        record.runRevision = (record.runRevision ?? 0) + 1;
        record.runStartCursor = record.cursor;
        record.aborted = false;
        record.status = "working"; record.error = undefined; record.activity = "Working";
        this.persist(); break;
      case "tool_execution_start":
        record.activity = `Tool: ${packet.toolName}`; this.changed(); break;
      case "message_end": {
        const message = packet.message;
        if (message?.role !== "assistant") break;
        const text = (message.content ?? []).filter((c: Packet) => c.type === "text").map((c: Packet) => c.text).join("\n");
        if (text) this.update(record, "assistant", text);
        if (message.stopReason === "aborted") record.aborted = true;
        if (message.stopReason === "error") {
          record.error = message.errorMessage || "Assistant request failed";
          this.update(record, "error", record.error!);
        }
        break;
      }
      case "agent_settled": {
        if (record.status === "stopping") break;
        record.runRevision = (record.runRevision ?? 0) + 1;
        record.status = record.error ? "failed" : "idle";
        record.activity = record.error ? "Run failed; process remains available" : "Waiting for instructions";
        record.uiRequests = [];
        this.persist();
        const last = record.updates.findLast(u => u.kind === "assistant" && u.cursor > (record.runStartCursor ?? 0));
        this.announce(record, record.error ? "failure" : record.aborted ? "aborted" : "completed", record.error || last?.text || "Run settled without a text response.");
        void this.children.get(record.id)?.request({ type: "get_session_stats" }).then(stats => {
          record.usage = stats; this.persist();
        }).catch(() => {});
        break;
      }
      case "extension_error":
        this.update(record, "extension_error", packet.error || JSON.stringify(packet)); break;
      case "extension_ui_request":
        if (["confirm", "select", "input", "editor"].includes(packet.method)) {
          record.uiRequests.push(packet);
          record.status = "waiting_input";
          this.update(record, "input_requested", JSON.stringify(packet));
          this.announce(record, "input_requested", JSON.stringify(packet));
        }
        break;
    }
  }
  summary(id: string) { return this.list().find(record => record.id === id)!; }
  async send(id: string, message: string, behavior?: "steer" | "followUp") {
    if (!message.trim()) throw new Error("message must not be empty");
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
  async abort(id: string) {
    const child = this.child(id);
    await child.request({ type: "clear_queue" });
    await child.request({ type: "abort" });
    return this.summary(id);
  }
  async close(id: string) {
    const record = this.get(id);
    const child = this.children.get(id);
    if (!child) return this.summary(id);
    record.status = "stopping";
    this.persist();
    // Cancel active tools before terminating the process. Cleanup still happens
    // if a wedged child cannot acknowledge cancellation.
    await child.request({ type: "clear_queue" }, 1000).catch(() => {});
    await child.request({ type: "abort" }, 2000).catch(() => {});
    await child.stop();
    return this.summary(id);
  }
  async resume(id: string, message?: string, env?: Record<string, string>) {
    const record = this.get(id);
    if (this.children.has(id)) throw new Error(`${id} already has a process`);
    if (!existsSync(record.sessionFile)) throw new Error("No saved child session exists");
    if (record.hadEnvOverrides && !env) throw new Error("This child used environment overrides. Supply them again; they are not stored.");
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
    record.status = record.uiRequests.length ? "waiting_input" : "working";
    this.persist();
    return this.summary(id);
  }
  async wait(ids: string[], mode: "any" | "all", timeoutMs: number, signal?: AbortSignal) {
    const selected = ids.length ? ids : [...this.records.keys()];
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
    await Promise.all([...this.children.keys()].map(id => this.close(id)));
  }
}
