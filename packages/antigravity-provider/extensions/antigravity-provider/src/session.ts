import { randomUUID } from "node:crypto";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import type { Api, Model, StreamOptions, ThinkingLevel, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolRequest, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { messageOf, withSignal } from "./errors.js";
import { catalog, findConfigSelect, thinkingFor, thoughtOptions, type ThoughtLevel } from "./models.js";
import { answerPermission, asRecord, cancelQuestion, mapUpdate, mergeCall, piTool, terminal, type ObservedCall, type ToolFrame } from "./observed.js";
import { AgyProcess, type ProcessOptions } from "./process.js";
import { appendPrompt, instructionsUpdate, runtimeNote, type Forwarded } from "./prompt.js";
import { Response, type AgyPromptResponse } from "./response.js";
import { assistantKey, inputBlocks, isFailedTurn, seedBlocks, toolResult, type Entry, type UserBlock } from "./transcript.js";
import { AWAIT, STAND_IN, failure, stillRunning } from "./tools.js";

const ABORTED = "Request was aborted";
const DRAIN_BATCH_DELAY_MS = 5;
const RESULT_BYTES = 8 * 1024 * 1024;
const END: AgyPromptResponse = { stopReason: "end_turn" };

export interface Loadout {
  standIn: boolean;
  active: ReadonlySet<string>;
  tools: Tool[];
}
interface SessionBinding extends ProcessOptions {
  toolTimeoutMs?: number;
  loadout(): Loadout;
  now(): number;
  settled(): void;
  wake(id: string): boolean;
  window(model: string, size: number): void;
}
interface Slot {
  response: Response;
  model: Model<Api>;
  forwarded: Forwarded;
  reasoning?: ThinkingLevel;
  options?: StreamOptions;
  ended: AbortController;
  detach(): void;
}
interface RespondRequest {
  model: Model<Api>;
  fresh: readonly Entry[];
  seed: boolean;
  forwarded: Forwarded;
  loadout: Loadout;
  reasoning?: ThinkingLevel;
  options?: StreamOptions;
}
interface Held {
  result: Promise<CallToolResult>;
  readonly settled: boolean;
  resolve(value: CallToolResult): void;
}
type Native = ObservedCall & {
  phase: "seen" | "offered" | "executing" | "blocked" | "reported" | "fallback" | "detached";
  change?: () => void;
  detached?: string;
};
type Pending = { kind: "native"; call: Native } | { kind: "mcp"; tool: ToolCall; held: Held; target: string; args: ToolCall["arguments"]; signal: AbortSignal };
interface Work {
  notification?: SessionNotification;
  chunk?: { kind: "text" | "thinking"; text: string };
  pending?: Pending;
  line?: string;
}
type State = { kind: "idle"; abortedIds?: ReadonlySet<string> }
  | { kind: "preparing"; slot: Slot; expected: Map<string, Pending>; abortedIds?: ReadonlySet<string> }
  | { kind: "open"; slot: Slot } | { kind: "paused"; slot: Slot; expected: Map<string, Pending> }
  | { kind: "cancelling"; slot: Slot; timer: NodeJS.Timeout; abortedIds?: ReadonlySet<string>; done: PromiseWithResolvers<void> }
  | { kind: "closed" };
type Prompt = { kind: "none" } | { kind: "running" } | { kind: "finished"; result: AgyPromptResponse };
export type RoutedCall = { kind: "native"; call: ObservedCall; approve(): void; reject(): void; abort(): void;
  wait(onUpdate: () => void, signal?: AbortSignal): Promise<void>; readonly detached?: string }
  | { kind: "mcp"; name: string; args: Record<string, unknown>; signal: AbortSignal; abort(): void };

function isInput(input: unknown): input is UserBlock[] {
  return Array.isArray(input) && input.every((block: UserBlock | null) => block &&
    ((block.type === "text" && typeof block.text === "string") ||
      (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")));
}

function followsAbort(entries: readonly Entry[], abortedIds: ReadonlySet<string> | undefined): boolean {
  const remaining = new Set(abortedIds);
  const count = remaining.size;
  return entries.length >= count &&
    entries.slice(0, count).every(entry => entry.kind === "toolResult" && remaining.delete(entry.message.toolCallId)) &&
    entries.slice(count).every(entry => entry.kind === "user" || entry.kind === "wake");
}

export class AgentSession {
  private state: State = { kind: "idle" };
  private prompt: Prompt = { kind: "none" };
  private readonly process: AgyProcess;
  private readonly prefix = randomUUID().replaceAll("-", "").slice(0, 24);
  private readonly ids = new Map<string, string>();
  private readonly native = new Map<string, Native>();
  private readonly mcpNames = new Map<string, string>();
  private readonly seenMcp = new Set<string>();
  private readonly holds = new Set<Held>();
  private readonly polls = new Map<string, Held>();
  private readonly late = new Map<string, CallToolResult>();
  private readonly queue: Work[] = [];
  private readonly keys: string[] = [];
  private readonly input: UserBlock[] = [];
  private sentInstructions: { model: string; forwarded: Forwarded };
  private config: SessionConfigOption[] | null | undefined;
  private levels = new Map<string, ThoughtLevel[]>();
  private sessionId?: string;
  private lastModel?: string;
  private drainTimer?: NodeJS.Timeout;
  private draining?: Slot;
  private wakeId?: string;
  private loadout: Loadout;
  private fallbackShown = false;
  private sequence = 0;
  lastUsed: number;

  constructor(private readonly binding: SessionBinding, readonly scope: string | undefined, model: string,
    forwarded: Forwarded, loadout: Loadout, readonly toolless: boolean) {
    this.lastUsed = binding.now();
    this.sentInstructions = { model, forwarded };
    this.loadout = loadout;
    this.process = new AgyProcess(binding, appendPrompt(model, forwarded), toolless ? undefined : () => this.currentTools(), {
      update: msg => this.update(msg), permission: req => this.permission(req),
      call: (req, signal) => this.call(req, signal), failed: message => { void this.close(message); },
    });
  }

  get closed(): boolean { return this.state.kind === "closed"; }
  get spare(): boolean { return this.state.kind === "idle"; }
  get paused(): boolean { return this.state.kind === "paused"; }
  private newId(): string { return `ag_${this.prefix}_${(++this.sequence).toString(36)}`; }

  private id(acpId: string): string {
    const existing = this.ids.get(acpId);
    if (existing) return existing;
    const id = this.newId();
    this.ids.set(acpId, id);
    return id;
  }
  private extends(entries: readonly Entry[]): boolean {
    return this.keys.every((key, index) => key === entries[index]?.key);
  }

  continues(scope: string | undefined, entries: readonly Entry[]): Entry[] | undefined {
    if (this.toolless || this.scope !== scope || !this.extends(entries)) return;
    const fresh = entries.slice(this.keys.length);
    const state = this.state;
    const supplied = new Set(fresh.flatMap(entry => entry.kind === "toolResult" ? [entry.message.toolCallId] : []));
    if (state.kind === "idle" && fresh.length && followsAbort(fresh, state.abortedIds)) return fresh;
    if (state.kind === "paused" && [...state.expected.keys()].every(id => supplied.has(id)) &&
      fresh.every(entry => entry.kind === "user" || entry.kind === "wake" || (entry.kind === "toolResult" && state.expected.has(entry.message.toolCallId)))) return fresh;
  }

  conflicts(scope: string | undefined, entries: readonly Entry[]): boolean {
    return !this.toolless && scope === this.scope && ["preparing", "open", "cancelling"].includes(this.state.kind) &&
      (scope !== undefined || this.keys.length > 0 && this.extends(entries));
  }

  refreshTools(): void { if (!this.toolless && !this.closed) this.process.toolsChanged(this.currentTools()); }

  requestWake(): void {
    if (this.toolless || !this.spare || !this.queue.length || this.wakeId) return;
    const id = randomUUID();
    if (this.binding.wake(id)) this.wakeId = id;
  }

  respond({ model, fresh, seed, forwarded, loadout, reasoning, options }: RespondRequest): Response {
    const response = new Response(model);
    const previous = this.state;
    const expected = previous.kind === "paused" ? previous.expected : new Map<string, Pending>();
    if (previous.kind === "paused") previous.slot.detach();
    else this.fallbackShown = false;
    this.loadout = loadout;
    this.lastUsed = this.binding.now();
    this.refreshTools();
    this.wakeId = undefined;
    const ended = new AbortController();
    const abort = () => this.abort(slot);
    const slot: Slot = { response, model, forwarded, reasoning, options, ended,
      detach: () => { options?.signal?.removeEventListener("abort", abort); ended.abort(); } };
    this.state = { kind: "preparing", slot, expected, abortedIds: previous.kind === "idle" ? previous.abortedIds : undefined };
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    else void this.prepare(slot, fresh, seed, expected).catch(error => {
      if (!slot.ended.signal.aborted) void this.close(messageOf(error));
    });
    return response;
  }

  private async prepare(slot: Slot, entries: readonly Entry[], seed: boolean, expected: Map<string, Pending>): Promise<void> {
    const ready = await withSignal(this.process.ready, slot.ended.signal);
    if (!this.sessionId) {
      this.sessionId = ready.sessionId;
      this.config = ready.configOptions;
      this.levels = new Map(catalog(ready).map(row => [row.model.id, row.levels]));
    }
    const { model, options } = slot;
    const results = entries.flatMap(entry => entry.kind === "toolResult" && expected.has(entry.message.toolCallId) ? [entry.message] : []);
    const input = seed ? seedBlocks(entries) : inputBlocks(entries);
    const replacement = await withSignal(Promise.resolve(options?.onPayload?.({
      model: model.id, session: seed ? "new" : "continued", effort: thinkingFor(this.levels.get(model.id) ?? [], slot.reasoning),
      toolResults: Object.fromEntries(results.map(result => [result.toolCallId, toolResult(result)])), input,
    }, model)), slot.ended.signal);
    slot.ended.signal.throwIfAborted();
    const replacedInput = asRecord(replacement)?.input;
    this.input.push(...(isInput(replacedInput) ? replacedInput : input));
    this.keys.push(...entries.map(entry => entry.key));
    this.state = { kind: "open", slot };
    for (const result of results) this.deliver(expected.get(result.toolCallId)!, result);
    this.scheduleDrain();
  }

  private async configure(id: string, reasoning: ThinkingLevel | undefined, signal: AbortSignal): Promise<void> {
    const change = async (key: string, value: string) => {
      if (findConfigSelect(this.config, key)?.currentValue === value) return;
      const { configOptions } = await withSignal(this.process.requestConfig(key, value), signal);
      if (findConfigSelect(configOptions, key)?.currentValue !== value) throw new Error(`agy did not apply ${key}=${value}.`);
      this.config = configOptions;
    };
    if (!this.levels.has(id)) throw new Error(`Antigravity model ${id} is not available with this agy account.`);
    await change("model", id);
    const allowed = thoughtOptions(this.config);
    const effort = thinkingFor(this.levels.get(id)!.filter(level => allowed.includes(level)), reasoning);
    if (effort) await change("thought_level", effort);
    this.lastModel = id;
  }

  private async startPrompt(slot: Slot, input: UserBlock[]): Promise<void> {
    const model = slot.model.id;
    await this.configure(model, slot.reasoning, slot.ended.signal);
    slot.ended.signal.throwIfAborted();
    const previous = this.sentInstructions;
    const update = instructionsUpdate(previous.forwarded, slot.forwarded, previous.model === model ? undefined : runtimeNote(model));
    this.sentInstructions = { model, forwarded: slot.forwarded };
    this.prompt = { kind: "running" };
    void this.process.prompt(update ? [{ type: "text", text: update }, ...input] : input).then(result => {
      if (this.closed) return;
      if (this.state.kind === "cancelling") { this.cancelled(this.state); return; }
      this.prompt = { kind: "finished", result };
      for (const call of this.native.values()) {
        if (!terminal(call) && (call.phase === "offered" || call.phase === "executing" || call.phase === "seen")) {
          this.detachCall(call, "Still running in Antigravity; later updates will appear in the conversation.");
        }
      }
      this.scheduleDrain();
    }, error => { void this.close(messageOf(error)); });
  }

  private scheduleDrain(): void {
    if (this.state.kind === "idle") { this.requestWake(); return; }
    if (this.state.kind !== "open" || this.draining === this.state.slot || this.drainTimer) return;
    const slot = this.state.slot;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      if (this.state.kind !== "open" || this.state.slot !== slot) return;
      this.draining = slot;
      void this.drain(slot).catch(error => {
        if (!slot.ended.signal.aborted) void this.close(messageOf(error));
      }).finally(() => {
        if (this.draining === slot) this.draining = undefined;
        if (this.queue.length || this.prompt.kind === "finished") this.scheduleDrain();
      });
    }, DRAIN_BATCH_DELAY_MS);
  }

  private async drain(slot: Slot): Promise<void> {
    const batch = new Map<string, Pending>();
    const boundary = this.queue.findIndex(work => work.pending?.kind === "mcp");
    const lastNative = (boundary < 0 ? this.queue : this.queue.slice(0, boundary)).findLast(work => work.pending?.kind === "native");
    let nativeAhead = lastNative !== undefined;
    while (this.queue.length) {
      const next = this.queue[0];
      if (batch.size && (next.pending?.kind === "mcp" || !nativeAhead && (next.chunk || next.line))) break;
      if (next === lastNative) nativeAhead = false;
      this.queue.shift();
      if (next.notification && slot.options?.onProviderStreamEvent) {
        await withSignal(Promise.resolve(slot.options.onProviderStreamEvent(next.notification, slot.model)), slot.ended.signal);
      }
      if (this.state.kind !== "open" || this.state.slot !== slot) return;
      if (next.chunk) slot.response.chunk(next.chunk.kind, next.chunk.text);
      if (next.line) slot.response.chunk("text", `\n${next.line}\n`);
      if (next.pending?.kind === "native") {
        const { call } = next.pending;
        if (!this.loadout.standIn || this.toolless) {
          call.phase = "fallback";
          this.rejectPermission(call);
          if (!this.toolless) {
            if (!this.fallbackShown) slot.response.chunk("text", "\nAntigravity's stand-in tool is not active; Pi will deny permissions for agy's own tools and show their activity as text.\n");
            this.fallbackShown = true;
            slot.response.chunk("text", this.line(call));
          }
        } else {
          call.phase = "offered";
          batch.set(this.newId(), next.pending);
        }
      } else if (next.pending?.kind === "mcp") {
        const { tool, held, signal, target } = next.pending;
        if (signal.aborted) continue;
        if (!this.renderMcpForLoadout(next.pending)) { held.resolve(this.missing(target)); continue; }
        batch.set(tool.id, next.pending);
        break;
      }
    }
    if (batch.size) { this.pause(slot, batch); return; }
    if (this.prompt.kind === "running") return;
    const result = this.prompt.kind === "finished" ? this.prompt.result : END;
    this.prompt = { kind: "none" };
    const late = this.lateBlocks();
    this.late.clear();
    if ((this.input.length || late.length) && result.stopReason === "end_turn") {
      slot.response.addUsage(result);
      await this.startPrompt(slot, [...late, ...this.input.splice(0)]);
      return;
    }
    this.input.length = 0;
    slot.response.complete(result);
    if (!isFailedTurn(slot.response.output)) this.keys.push(assistantKey(slot.response.output));
    slot.detach();
    this.state = { kind: "idle" };
    this.lastUsed = this.binding.now();
    if (this.toolless) void this.close();
    this.binding.settled();
  }

  private pause(slot: Slot, expected: Map<string, Pending>): void {
    this.state = { kind: "paused", slot, expected };
    for (const [id, pending] of expected) {
      if (pending.kind === "mcp") slot.response.tool(pending.tool);
      else {
        const { title, kind, input } = pending.call;
        slot.response.tool({ type: "toolCall", id, name: STAND_IN, arguments: { title, kind, ...(input === undefined ? {} : { input: input as ToolCall["arguments"][string] }) } });
      }
    }
    slot.response.finish("toolUse");
    this.keys.push(assistantKey(slot.response.output));
    this.yieldToQueuedPiWork();
  }

  private yieldToQueuedPiWork(): void {
    const state = this.state;
    if (state.kind !== "paused" || !this.queue.some(work => work.pending)) return;
    // Pi cannot run another batch until every card in this one has returned.
    for (const pending of state.expected.values()) {
      if (pending.kind === "native" && pending.call.kind !== "question" && !terminal(pending.call)) {
        this.detachCall(pending.call, "Still running in Antigravity; this card returned so Pi can handle another request.");
      }
    }
  }

  private detachCall(call: Native, note: string): void {
    call.detached ??= note;
    call.change?.();
  }

  private update(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId || this.closed || this.state.kind === "cancelling") return;
    const update = mapUpdate(notification.update);
    const work: Work = { notification };
    if (update?.kind === "window") {
      if (this.lastModel) this.binding.window(this.lastModel, update.size);
    } else if (update?.kind === "text" || update?.kind === "thinking") work.chunk = update;
    else if (update?.kind === "start" || update?.kind === "change") {
      const { frame } = update;
      const mcp = piTool(frame);
      if ((mcp || this.seenMcp.has(frame.toolCallId)) && !frame.toolCallId.startsWith("interaction_")) {
        if (mcp && !this.seenMcp.has(frame.toolCallId)) this.mcpNames.set(frame.toolCallId, mcp);
        this.seenMcp.add(frame.toolCallId);
        if (frame.status === "completed" || frame.status === "failed") this.mcpNames.delete(frame.toolCallId);
      } else if (!this.toolless) {
        const { call, first } = this.observe(frame);
        if (first && call.kind !== "question") work.pending = { kind: "native", call };
        else if (terminal(call) && (call.phase === "fallback" || call.phase === "detached")) {
          work.line = this.line(call);
          this.retire(call);
        }
      }
    }
    if (!this.spare || work.chunk || work.pending || work.line) this.enqueue(work);
  }

  private observe(frame: ToolFrame): { call: Native; first: boolean } {
    const id = frame.toolCallId;
    const existing = this.native.get(id);
    const call: Native = existing ?? { id, phase: "seen", title: "Antigravity action", kind: id.startsWith("interaction_") ? "question" : "other", status: "pending", diff: [] };
    if (!terminal(call) && call.phase !== "reported") {
      mergeCall(call, frame);
      call.change?.();
    }
    if (!existing) this.native.set(id, call);
    return { call, first: !existing };
  }

  private enqueue(work: Work): void {
    this.queue.push(work);
    if (work.pending) this.yieldToQueuedPiWork();
    this.scheduleDrain();
  }

  private permission(request: RequestPermissionRequest): RequestPermissionResponse | Promise<RequestPermissionResponse> {
    const { toolCall: frame, options } = request;
    const question = frame.toolCallId.startsWith("interaction_");
    const reject = () => question ? cancelQuestion() : answerPermission(options, false);
    if (request.sessionId !== this.sessionId || this.toolless || this.closed || this.state.kind === "cancelling") return reject();
    if (!question) {
      const name = piTool(frame) ?? this.mcpNames.get(frame.toolCallId);
      if (name) {
        this.seenMcp.add(frame.toolCallId);
        this.mcpNames.set(frame.toolCallId, name);
        return answerPermission(options, this.canAutoApproveMcp(name));
      }
    }
    const { call, first } = this.observe(frame);
    if (call.pendingPermission || call.phase === "blocked" || call.phase === "fallback" || call.phase === "reported" || terminal(call) || !this.loadout.standIn) {
      if (first || question && call.phase === "seen" && !call.pendingPermission) this.enqueue({ pending: { kind: "native", call } });
      return reject();
    }
    const pending = Promise.withResolvers<RequestPermissionResponse>();
    call.pendingPermission = { options, answer: response => { call.pendingPermission = undefined; pending.resolve(response); } };
    if (call.phase === "executing" && !question) this.approvePermission(call);
    if (call.phase === "detached") {
      call.phase = "seen";
      call.detached = undefined;
      this.enqueue({ pending: { kind: "native", call } });
    } else if (first || question && call.phase === "seen") this.enqueue({ pending: { kind: "native", call } });
    return pending.promise;
  }

  private approvePermission(call: ObservedCall): void {
    const pending = call.pendingPermission;
    if (pending) pending.answer(answerPermission(pending.options, true));
  }

  private rejectPermission(call: ObservedCall): void {
    const pending = call.pendingPermission;
    if (pending) pending.answer(call.kind === "question" ? cancelQuestion() : answerPermission(pending.options, false));
  }

  private line(call: ObservedCall): string {
    return `\n[Antigravity: ${call.title} (${call.status})${call.output ? `\n${call.output}` : ""}]\n`;
  }

  private mcpRoute(name: string, live: Loadout): "direct" | "stand-in" | "await" | undefined {
    if (name === AWAIT) return "await";
    if (live.active.has(name) && this.loadout.active.has(name)) return "direct";
    if (live.standIn && this.loadout.standIn) return "stand-in";
  }

  private canAutoApproveMcp(name: string): boolean {
    return this.currentTools().some(tool => tool.name === name);
  }

  private renderMcpForLoadout({ tool, target, args }: Extract<Pending, { kind: "mcp" }>): boolean {
    const live = this.binding.loadout();
    if (!live.tools.some(tool => tool.name === target)) return false;
    switch (this.mcpRoute(target, live)) {
      case "direct":
        tool.name = target;
        tool.arguments = args;
        return true;
      case "stand-in":
        tool.name = STAND_IN;
        tool.arguments = { title: `Pi: ${target}`, kind: "pi_tool", input: { name: target, arguments: args } };
        return true;
      default: return false;
    }
  }

  private currentTools(): Tool[] {
    if (this.toolless) return [];
    const live = this.binding.loadout();
    return live.tools.filter(tool => this.mcpRoute(tool.name, live));
  }

  private missing(name: string): CallToolResult {
    return failure(`Unavailable Pi tool ${name}. Available tools: ${this.currentTools().map(tool => tool.name).join(", ") || "none"}.`);
  }

  private async call(request: CallToolRequest, signal: AbortSignal): Promise<CallToolResult> {
    if (this.toolless || this.closed || this.state.kind === "cancelling") return failure("Pi is not accepting MCP calls in this turn.");
    const { name, arguments: args } = request.params;
    const match = [...this.mcpNames].find(([, tool]) => tool === name);
    if (match) this.mcpNames.delete(match[0]);
    if (!this.currentTools().some(tool => tool.name === name)) return this.missing(name);
    if (name === AWAIT) {
      const wanted = args?.id;
      if (typeof wanted !== "string") return failure(`${AWAIT} requires an id from a still-running notice.`);
      const late = this.late.get(wanted);
      if (late) { this.late.delete(wanted); return late; }
      const state = this.state;
      const expected = state.kind === "paused" || state.kind === "preparing" ? state.expected.get(wanted) : undefined;
      if (expected?.kind !== "mcp" || this.polls.has(wanted)) return failure(`No uncollected Pi tool result for ${wanted}.`);
      const poll = this.hold(wanted, signal);
      this.polls.set(wanted, poll);
      try { return await poll.result; }
      finally { if (this.polls.get(wanted) === poll) this.polls.delete(wanted); }
    }
    const piId = match ? this.id(match[0]) : this.newId();
    const { toolSummary: _summary, ...argumentsForPi } = (args ?? {}) as ToolCall["arguments"];
    const held = this.hold(piId, signal);
    this.enqueue({ pending: { kind: "mcp", tool: { type: "toolCall", id: piId, name, arguments: argumentsForPi },
      held, target: name, args: argumentsForPi, signal } });
    return held.result;
  }

  private hold(id: string, signal: AbortSignal): Held {
    const deferred = Promise.withResolvers<CallToolResult>();
    let settled = false;
    const abort = () => held.resolve(failure("The MCP request was interrupted."));
    const held: Held = { result: deferred.promise, get settled() { return settled; }, resolve: value => {
      if (settled) return;
      settled = true;
      this.holds.delete(held);
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      deferred.resolve(value);
    } };
    this.holds.add(held);
    const timer = setTimeout(() => held.resolve(stillRunning(id)), this.binding.toolTimeoutMs ?? 150_000).unref();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return held;
  }

  private deliver(pending: Pending, message: ToolResultMessage): void {
    if (pending.kind === "native") {
      const { call } = pending;
      if (call.phase === "offered") this.reject(call);
      if (terminal(call) || call.kind === "question" && !call.pendingPermission) this.retire(call);
      return;
    }
    const id = pending.tool.id;
    const value = toolResult(message);
    let bounded = Buffer.byteLength(JSON.stringify(value)) <= RESULT_BYTES ? value : failure("Pi's tool result exceeds the bridge's 8 MiB limit. Use a smaller tool request.");
    const poll = this.polls.get(id);
    if (poll && !poll.settled) poll.resolve(bounded);
    else if (pending.held.settled) this.late.set(id, bounded);
    else {
      const combined = { ...bounded, content: [...bounded.content, ...this.lateBlocks()] };
      if (Buffer.byteLength(JSON.stringify(combined)) <= RESULT_BYTES) { this.late.clear(); bounded = combined; }
      pending.held.resolve(bounded);
    }
  }

  private lateBlocks(): Extract<CallToolResult["content"][number], { type: "text" | "image" }>[] {
    return [...this.late].flatMap(([id, result]) => [
      { type: "text", text: `[Late Pi tool result for ${id}${result.isError ? " (error)" : ""}; the tool already ran. Do not call it again.]` },
      ...result.content.filter(item => item.type === "text" || item.type === "image"),
      { type: "text", text: "[End of late Pi tool result]" },
    ]);
  }

  rejectUnexecuted(id: string): void {
    const state = this.state;
    const pending = state.kind === "paused" || state.kind === "preparing" ? state.expected.get(id) : undefined;
    if (pending?.kind === "native" && pending.call.phase === "offered") this.reject(pending.call);
  }

  private reject(call: Native): void {
    call.phase = "blocked";
    this.rejectPermission(call);
  }

  private retire(call: Native): void {
    call.phase = "reported";
    call.input = call.output = undefined;
    call.diff = [];
  }

  route(id: string): RoutedCall | undefined {
    const state = this.state;
    if (state.kind !== "paused") return;
    const pending = state.expected.get(id);
    if (!pending) return;
    const abort = () => this.abort(state.slot);
    if (pending.kind === "mcp") return { kind: "mcp", name: pending.target, args: pending.args, signal: pending.signal, abort };
    const { call } = pending;
    if (call.phase !== "offered") return;
    call.phase = "executing";
    return { kind: "native", call, abort, approve: () => this.approvePermission(call), reject: () => this.reject(call),
      get detached() { return terminal(call) ? undefined : call.detached; },
      async wait(onUpdate, signal) {
        const complete = Promise.withResolvers<void>();
        const notify = call.change = () => {
          if (terminal(call) || call.detached) complete.resolve();
          else onUpdate();
        };
        try { notify(); await (signal ? withSignal(complete.promise, signal) : complete.promise); }
        finally {
          call.change = undefined;
          if (call.phase !== "reported") call.phase = call.detached && !terminal(call) ? "detached" : "reported";
        }
      },
    };
  }

  async abandon(): Promise<void> {
    if (this.state.kind === "paused") this.abort(this.state.slot);
    if (this.state.kind === "cancelling") await this.state.done.promise;
  }

  private release(reason: string): void {
    for (const call of this.native.values()) {
      this.rejectPermission(call);
      if (!terminal(call)) {
        call.status = "failed";
        call.output = reason;
        call.change?.();
      }
    }
    for (const held of this.holds) held.resolve(failure(reason));
    this.queue.length = 0;
    this.input.length = 0;
    this.late.clear();
    this.mcpNames.clear();
    this.wakeId = undefined;
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  }

  private abort(slot: Slot): void {
    const state = this.state;
    if (!("slot" in state) || state.slot !== slot || state.kind === "cancelling") return;
    const abortedIds = state.kind === "preparing" ? state.abortedIds ?? new Set(state.expected.keys())
      : state.kind === "paused" ? new Set(state.expected.keys()) : undefined;
    slot.detach();
    this.release(ABORTED);
    if (this.prompt.kind === "running") {
      this.state = { kind: "cancelling", slot, abortedIds, done: Promise.withResolvers(),
        timer: setTimeout(() => { void this.close(ABORTED); }, 2_000).unref() };
      this.process.cancel();
    } else if (!this.sessionId) {
      slot.response.finish("aborted", ABORTED);
      void this.close(ABORTED);
    } else this.cancelled({ slot, abortedIds });
  }

  private cancelled({ slot, timer, abortedIds, done }: { slot: Slot; timer?: NodeJS.Timeout;
    abortedIds?: ReadonlySet<string>; done?: PromiseWithResolvers<void> }): void {
    clearTimeout(timer);
    this.prompt = { kind: "none" };
    slot.response.finish("aborted", ABORTED);
    this.state = { kind: "idle", abortedIds };
    done?.resolve();
    this.binding.settled();
  }

  close(message = "The Pi session ended."): Promise<void> {
    const state = this.state;
    this.state = { kind: "closed" };
    this.release(message);
    if (state.kind === "cancelling") {
      clearTimeout(state.timer);
      state.done.resolve();
    }
    if ("slot" in state) {
      state.slot.response.finish(state.kind === "cancelling" ? "aborted" : "error", message);
      state.slot.detach();
    }
    return this.process.close();
  }
}
