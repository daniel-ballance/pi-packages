import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const journalType = "t3-subagents-v1";
type Data = Record<string, unknown>;
type Operation = "delegate" | "cancel";
type Request = { operation: Operation; state: "uncertain" | "accepted"; clientRequestId: string;
  fingerprint: string; taskId?: string; reason?: string; status?: string };
const isObject = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isObject(value)) return "{" + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function toolName(ctx: ExtensionToolContext, operation: string): string {
  if (typeof ctx.executeTool !== "function" || !Array.isArray(ctx.tools)) {
    throw new Error("t3-subagents requires Pi's ExtensionToolContext.executeTool and registered T3 tools. No subprocess or direct-credential fallback is used.");
  }
  const candidates = [`mcp__t3-code__${operation}`, `mcp__t3_code__${operation}`];
  const matches = candidates.filter(name => ctx.tools.some(tool => tool.name === name));
  if (matches.length !== 1) throw new Error(`Expected one registered T3 ${operation} tool; found ${matches.length}. Load T3's injected bridge (and check duplicate extensions).`);
  return matches[0];
}

// T3's bridge flattens both MCP text and structuredContent into one text block.
// Decode identical JSON copies, but reject prose or conflicting result objects.
function decode(text: string): Data {
  let first: Data | undefined, start = 0, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (depth === 0) {
      if (/\s/.test(char)) { start = index + 1; continue; }
      if (char !== "{") throw new Error("Expected JSON object");
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        const data: unknown = JSON.parse(text.slice(start, index + 1));
        if (!isObject(data) || (first && canonical(first) !== canonical(data))) throw new Error("Conflicting JSON results");
        first = data;
        start = index + 1;
      }
    }
  }
  if (!first || depth || quoted) throw new Error("Incomplete JSON result");
  return first;
}

async function call(ctx: ExtensionToolContext, name: string, args: Data, signal?: AbortSignal): Promise<Data> {
  const outcome = await ctx.executeTool(name, args, { signal });
  if (outcome.isError) throw new Error(outcome.result.content.filter(part => part.type === "text").map(part => part.text).join("\n").slice(0, 4000) || "T3 tool failed");
  for (const part of outcome.result.content) {
    if (part.type !== "text") continue;
    try {
      return decode(part.text);
    } catch { /* Other content parts may contain the JSON result. */ }
  }
  throw new Error("T3 returned no JSON object result. Inspect the T3 tool response before retrying.");
}

// Only identity/liveness and cancellation receipts are cached, never summaries.
const metadataKeys = ["taskId", "childThreadId", "childRunId", "childNodeId", "status", "workState",
  "hasPendingChildRuns", "providerInstanceId", "model", "waitTimedOut", "latestTerminalRunId", "latestTerminalStatus"];
const metadata = (data: Data): Data => Object.fromEntries(metadataKeys.filter(key => key in data).map(key => [key, data[key]]));

export class Tasks {
  constructor(private pi: ExtensionAPI) {}

  private journal(ctx: ExtensionToolContext) {
    const requests = new Map<string, Request>(), tasks = new Map<string, Data>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== journalType || !isObject(entry.data) || entry.data.version !== 1) continue;
      const data = entry.data;
      if (data.kind === "request" && typeof data.clientRequestId === "string" && typeof data.fingerprint === "string") {
        const operation = data.operation === "cancel" ? "cancel" : "delegate";
        requests.set(`${operation}:${data.clientRequestId}`, { operation,
          state: data.state === "accepted" || (data.state === undefined && typeof data.taskId === "string") ? "accepted" : "uncertain",
          clientRequestId: data.clientRequestId, fingerprint: data.fingerprint,
          ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
          ...(typeof data.status === "string" ? { status: data.status } : {}) });
      }
      if (data.kind === "task" && isObject(data.task) && typeof data.task.taskId === "string") tasks.set(data.task.taskId, data.task);
    }
    return { requests, tasks };
  }

  private append(data: Data) { this.pi.appendEntry(journalType, { version: 1, ...data }); }

  private intent(ctx: ExtensionToolContext, operation: Operation, args: Data & { clientRequestId: string }): Request {
    const fingerprint = createHash("sha256").update(canonical(args)).digest("hex");
    const previous = this.journal(ctx).requests.get(`${operation}:${args.clientRequestId}`);
    if (previous && previous.fingerprint !== fingerprint) throw new Error(operation === "delegate"
      ? "clientRequestId already identifies a different task brief/selection. Use a new key for each new task or review round."
      : "clientRequestId already identifies a different cancellation task/reason. Retry identical arguments or use a new key.");
    if (previous) return previous;
    const request: Request = { operation, state: "uncertain", clientRequestId: args.clientRequestId, fingerprint,
      ...(operation === "cancel" ? { taskId: args.taskId as string,
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}) } : {}) };
    // Synchronous intent before awaiting transport, including cancellations.
    this.append({ kind: "request", ...request });
    return request;
  }

  list(ctx: ExtensionToolContext): Data {
    const { requests, tasks } = this.journal(ctx);
    return { source: "local-session-branch", requests: [...requests.values()].map(({ fingerprint: _, ...record }) => record),
      tasks: [...tasks.values()],
      note: "Cached identities/liveness and cancellation receipts only. Read a task for current status/result; uncertain operations may already have executed." };
  }

  async catalog(ctx: ExtensionToolContext, signal?: AbortSignal): Promise<Data> {
    return call(ctx, toolName(ctx, "orchestrator_capabilities"), {}, signal);
  }

  async read(ctx: ExtensionToolContext, taskId: string, signal?: AbortSignal): Promise<Data> {
    const data = await call(ctx, toolName(ctx, "task_status"), { taskId }, signal);
    this.observe(ctx, taskId, data);
    return data;
  }

  async cancel(ctx: ExtensionToolContext, args: Data & { taskId: string; clientRequestId: string }, signal?: AbortSignal): Promise<Data> {
    const name = toolName(ctx, "task_cancel");
    const request = this.intent(ctx, "cancel", args);
    if (request.state === "accepted") return { taskId: request.taskId, status: request.status, clientRequestId: request.clientRequestId,
      source: "local-session-branch", note: "Previously accepted cancellation receipt, not confirmed termination or current status. Use t3_subagent_read; not redispatched." };
    try {
      const data = await call(ctx, name, args, signal);
      if (typeof data.status !== "string" || !data.status) throw new Error("T3 cancellation reply had no status");
      this.observe(ctx, args.taskId, data);
      this.append({ kind: "request", ...request, state: "accepted", status: data.status });
      return data;
    } catch (error) {
      throw new Error(`Cancellation outcome uncertain for clientRequestId=${args.clientRequestId}. Inspect T3, or retry only the same task/reason/key. ${String(error).slice(0, 4000)}`);
    }
  }

  private observe(ctx: ExtensionToolContext, taskId: string, data: Data) {
    if (data.taskId !== taskId) throw new Error("T3 reply had a different taskId; no local identity was updated.");
    this.append({ kind: "task", task: { ...this.journal(ctx).tasks.get(taskId), ...metadata(data) } });
  }

  async delegate(ctx: ExtensionToolContext, request: Data & { clientRequestId: string }, signal?: AbortSignal): Promise<Data> {
    const name = toolName(ctx, "delegate_task");
    if (ctx.tools.some(tool => tool.name === "subagent_spawn")) throw new Error("Native subagents is active. Restart this T3 launch with --disable-native-subagents; standalone Pi behavior is unchanged.");
    const intent = this.intent(ctx, "delegate", request);
    if (intent.state === "accepted" && intent.taskId) return { ...this.journal(ctx).tasks.get(intent.taskId), taskId: intent.taskId, clientRequestId: request.clientRequestId,
      source: "local-session-branch", note: "Previously accepted. Use t3_subagent_read for current status/result; not redispatched." };
    try {
      const data = await call(ctx, name, { ...request, mode: "async" }, signal);
      if (typeof data.taskId !== "string" || !data.taskId) throw new Error("T3 delegation reply had no taskId");
      this.append({ kind: "task", task: metadata(data) });
      this.append({ kind: "request", ...intent, state: "accepted", taskId: data.taskId });
      return data;
    } catch (error) {
      throw new Error(`Delegation outcome uncertain for clientRequestId=${request.clientRequestId}. The child may already exist; retry only the same brief/key, or inspect T3. Aborting this call does not cancel the child. ${String(error).slice(0, 4000)}`);
    }
  }
}
