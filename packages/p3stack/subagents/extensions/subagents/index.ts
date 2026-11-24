import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { FooterComponent, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SubagentManager } from "./src/manager.js";
import { decorateFooter, formatSubagentSummary, installFooterDecoration } from "./src/footer.js";
import { capacityReachedText } from "./src/child-limit.js";
import { builtInPolicy, loadedExtensions, SubagentPolicy } from "./src/policy.js";
import { isSupervisoryNotice, NoticeScheduler } from "./src/notifications.js";
import { childNews, DEFAULT_WAIT_MODE, messageLatch, waitReport, withCurrentReviews, type ChildNews } from "./src/wait.js";
import { normalizeCoordination, coordinationWarnings, recoverySummary } from "./src/coordination.js";
import { cardsFromDetails, listingLine } from "./src/card.js";
import { summarizeAgents } from "./src/usage.js";
import { subagentRenderers } from "./src/render.js";
import { Workflows } from "./src/workflows.js";
import { managerWorkflowHost } from "./src/workflow-host.js";
import { registerWorkflowUI } from "./src/workflow-ui.js";
import { inspectorSource } from "./src/inspector-data.js";
import { showInspector, type InspectorPanel } from "./src/inspector.js";
import { HerdrStatus } from "./src/herdr.js";
import { detectHost } from "./src/host.js";
import { describeLoop, formatInterval, LoopController, loopTickMessage, parseInterval, type LoopState } from "./src/loop.js";
import { createWorktree, planWorktree, releaseCreationLock, removeWorktree, type Worktree } from "./src/worktree.js";
import { SHARED_SCHEMAS, TOOL_SPECS } from "./src/tool-schemas.js";
import { fitDelegatedReply, isProxiedTool } from "./src/nesting.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { Value } from "typebox/value";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const { id, message } = SHARED_SCHEMAS;
type SpawnReceipt = ChildNews & {
  model?: string; thinking?: string; worktree?: Worktree;
  coordinationWarnings: ReturnType<typeof coordinationWarnings>;
  coordinationWarningCount: number;
  overlapsOutsideYourSubtree?: number;
};
const noticeKeys = (details: unknown): string[] => {
  if (!details || typeof details !== "object" || !("noticeKeys" in details) || !Array.isArray(details.noticeKeys)) return [];
  return details.noticeKeys.filter((key): key is string => typeof key === "string");
};

/** Event-bus channel: emit `{ reply(catalog) }`; replies synchronously with `{ spawnEnabled, models: ["provider/model:thinking", ...] }`. */
export const CATALOG_CHANNEL = "subagents:catalog";

/** Custom footers emit `{ lines, width, reply(lines) }`; decoration replies synchronously using the live summary. */
export const FOOTER_CHANNEL = "subagents:footer";

export default function subagents(pi: ExtensionAPI) {
  // Explicitly loading this package in a child still does not enable recursion.
  if (process.env.PI_SUBAGENT === "1") return;
  if (detectHost() !== "t3") pi.on("resources_discover", () => ({
    skillPaths: [fileURLToPath(new URL("../../skills", import.meta.url))],
  }));
  pi.registerFlag("disable-native-subagents", {
    description: "Disable native subagent tools, managers, workflows and notifications for this launch",
    type: "boolean", default: false,
  });
  // Pi applies parsed CLI flags after factories load. Register nothing else
  // until session_start, including on reload with the same launch flags.
  // Inside T3 Code, T3's own delegated tasks are the subagent system. The whole
  // manager duplicates it, so nothing registers, not even deferred tools.
  let initialized = false;
  pi.on("session_start", (_event, ctx) => {
    if (initialized || pi.getFlag("disable-native-subagents") === true || detectHost() === "t3") return;
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    initialized = true;
    initializeSubagents(pi, ctx);
  });
}

function initializeSubagents(pi: ExtensionAPI, initialContext: ExtensionContext) {
  // The root's own tools also serve proxied calls from Children (nesting.ts).
  const proxiable = new Map<string, ToolDefinition<any, any>>();
  function registerTool<P extends TSchema, D>(tool: ToolDefinition<P, D>) {
    if (isProxiedTool(tool.name)) proxiable.set(tool.name, tool);
    pi.registerTool(tool);
  }
  /** Set while a Child's proxied call runs: who is asking. */
  const delegation = new AsyncLocalStorage<{ callerId: string }>();
  let manager: SubagentManager | undefined;
  let notifications: NoticeScheduler | undefined;
  let policy: SubagentPolicy | undefined;
  let workflows: Workflows | undefined;
  let inspector: InspectorPanel | undefined;
  let loops: LoopController | undefined;
  const loaded = () => loadedExtensions([...pi.getCommands().filter(command => command.source === "extension"), ...pi.getAllTools()]);
  const getPolicy = (ctx: ExtensionContext) => policy ??= new SubagentPolicy({
    cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted(),
    guardPath: fileURLToPath(new URL("./src/child-guard.ts", import.meta.url)),
    models: () => ctx.modelRegistry.getAvailable().map(model => ({ ...model, thinkingLevels: getSupportedThinkingLevels(model) })),
    builtIn: builtInPolicy(loaded()),
    loadedExtensions: loaded,
    // Undocumented but present in 0.99.2 and 1.2.0; without it the check is skipped.
    extensionProviders: () => (ctx.modelRegistry as { getRegisteredProviderIds?: () => readonly string[] }).getRegisteredProviderIds?.() ?? [],
    toolSources: () => Object.fromEntries(pi.getAllTools().filter(tool => tool.sourceInfo?.path).map(tool => [tool.name, tool.sourceInfo!.path])),
    tools: () => {
      const names = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", ...(process.platform === "win32" ? ["powershell"] : [])]);
      for (const tool of pi.getAllTools()) {
        if (tool.exposure === "hidden") names.delete(tool.name); else names.add(tool.name);
      }
      return [...names];
    },
  });
  let context: ExtensionContext | undefined;
  let footerLabel = "";
  let restoreFooter: (() => void) | undefined;
  let herdr: HerdrStatus | undefined;
  let stopHerdrEvents: (() => void) | undefined;
  let stopCatalogEvents: (() => void) | undefined;
  let stopFooterEvents: (() => void) | undefined;
  const runningWorkflows = () => workflows ? (workflows.inspect() as { runs: { status: string; name: string }[] }).runs.filter(r => ["running", "pausing"].includes(r.status)) : [];
  const reportActivity = () => herdr?.subagents({
    children: manager ? summarizeAgents(manager.list()).active : 0, workflows: runningWorkflows().length,
  });
  const refresh = () => {
    reportActivity();
    if (!manager || !context?.hasUI) return;
    footerLabel = formatSubagentSummary(manager.list(), manager.capacity().limit);
    // Also requests a render, but don't add our old third row in the TUI.
    context.ui.setStatus("subagents", context.mode === "tui" ? undefined : footerLabel || undefined);
  };
  const get = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("subagents requires TUI or RPC mode");
    context = ctx;
    if (!manager) {
      const policy = getPolicy(ctx);
      manager = new SubagentManager(join(getAgentDir(), "subagents", ctx.sessionManager.getSessionId()), () => notifications?.wake(), refresh, policy.childLimit, (config, depth) => {
        if (!config.selection) throw new Error("Legacy child has no allowlisted composition. Spawn a new child using subagent_catalog instead of resuming unrestricted v1 parameters.");
        return { ...policy.compile(config.cwd, config.selection, depth), coordination: config.coordination };
      }, policy.config?.peerMessageLimit ?? 0, policy.config?.parentMessageLimit ?? 0);
      manager.setInterventionHook((record, kind) => {
        if (record.workflow) getWorkflows(ctx).holdForIntervention(record.id, `User ${kind === "halt" ? "halted" : "killed"} ${record.name} (${record.id})`, record.workflow);
      });
      manager.setManagementHandler((callerId, request, signal) => delegate(callerId, request.op, request.args, signal));
    }
    return manager;
  };
  const getWorkflows = (ctx: ExtensionContext) => workflows ??= new Workflows(join(get(ctx).directory, "workflows"), managerWorkflowHost(get(ctx), () => getPolicy(ctx)), () => {
    reportActivity();
    if (context?.hasUI && workflows) {
      const running = runningWorkflows();
      context.ui.setStatus("workflows", context.mode !== "tui" && running.length ? `workflow: ${running[0].name}` : undefined);
    }
    notifications?.wake();
  });
  const showLoop = () => {
    const state = loops?.status();
    if (context?.hasUI) context.ui.setStatus("loop", state ? `loop ${state.iteration}/${state.maxIterations} · every ${formatInterval(state.intervalMs)}` : undefined);
  };
  // A human intervention reaches the parent before any autonomous tick.
  const supervisionPending = () => [...manager?.pendingNotices() ?? [], ...workflows?.pendingNotices() ?? []].some(isSupervisoryNotice);
  const getLoops = (ctx: ExtensionContext) => loops ??= new LoopController({
    policy: () => getPolicy(ctx).config?.loops,
    idle: () => context?.isIdle() === true && !supervisionPending(),
    send: tick => {
      pi.sendMessage({ customType: "subagent-loop-tick", content: loopTickMessage(tick), display: true, details: tick }, { triggerTurn: true, deliverAs: "followUp" });
      showLoop();
    },
    ended: (reason, state, requested) => {
      if (!requested) {
        try { pi.sendMessage({ customType: "subagent-loop-end", content: `LOOP ENDED — ${JSON.stringify(state.task)} ${reason}.`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" }); }
        catch { pi.appendEntry("subagent-loop-end", { task: state.task, reason }); }
      }
      if (!requested && context?.hasUI) context.ui.notify(`Loop ended: ${reason}`, "info");
      showLoop();
    },
  });
  // Shared by subagent_loop and /loop, so both answer the same way.
  const loopAction = (ctx: ExtensionContext, request: { op: "start"; task: string; intervalMs: number; maxIterations?: number; maxDurationMs?: number } | { op: "stop"; by: string } | { op: "status" }) => {
    const controller = getLoops(ctx);
    let text: string, state: LoopState | undefined;
    if (request.op === "start") {
      const { op: _op, ...loop } = request;
      state = controller.start(loop);
      text = `Started a loop: ${describeLoop(state)}.`;
    } else if (request.op === "stop") {
      state = controller.stop(`stopped by the ${request.by}`);
      text = state ? `Stopped the loop after ${state.iteration} of ${state.maxIterations} ticks.` : "No loop is running.";
    } else {
      state = controller.status();
      text = state ? `Loop running: ${describeLoop(state)}.` : "No loop is running.";
    }
    showLoop();
    return { text, state };
  };
  // A Child's proxied call: same tool, same validation, scoped to its own subtree.
  // Replies cross the private pipe (fitDelegatedReply); never spill to a file in the
  // root's private directory, which the Child need not be able to read.
  const fitReply = (data: unknown) => fitDelegatedReply(data);
  const delegate = async (callerId: string, op: string, raw: Record<string, unknown>, signal?: AbortSignal) => {
    const ctx = context;
    const tool = proxiable.get(`subagent_${op}`);
    if (!ctx || !manager || !tool) throw new Error("Delegation is not available from this parent session");
    if (!manager.get(callerId).config.selection?.tools.includes(tool.name)) throw new Error(`${tool.name} was not granted to this child`);
    if (!Value.Check(tool.parameters, raw)) {
      const errors = [...Value.Errors(tool.parameters, raw)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`);
      throw new Error(`Invalid subagent_${op} arguments: ${errors.join("; ")}`);
    }
    const scoped = manager, args = { ...raw };
    const own = (target: unknown) => {
      if (typeof target !== "string" || !scoped.isDescendant(target, callerId)) throw new Error(`${String(target)} is not one of your Children or their descendants.`);
    };
    if (op === "send" || op === "read" || op === "close") own(args.id);
    if (op === "wait") {
      const ids = (args.ids as string[] | undefined) ?? scoped.childrenOf(callerId).filter(record => !record.rejected).map(record => record.id);
      if (!ids.length) throw new Error("You have no Children to wait for.");
      ids.forEach(own);
      args.ids = ids;
    }
    if (op === "list") {
      const agents = scoped.overview(args.includeRejected === true).agents.filter(agent => scoped.isDescendant(agent.id, callerId));
      return fitReply({ totals: summarizeAgents(agents), agents });
    }
    // These tools use only session-level context; a proxied call has no tool loadout of its own.
    const output = await delegation.run({ callerId }, () => tool.execute(`delegated-${randomUUID()}`, args as never, signal, undefined, ctx as ExtensionToolContext));
    signal?.throwIfAborted(); // The caller exited: nobody can receive this.
    // result() spilled an oversized reply to the root's directory: send the text instead.
    const details = output.details && typeof output.details === "object" && "fullResult" in output.details
      ? { truncated: true, preview: output.content.map(part => part.type === "text" ? part.text : "").join("\n") } : output.details;
    return fitReply(details);
  };
  const result = (data: unknown, ctx: ExtensionContext) => {
    const text = JSON.stringify(data, null, 2);
    const truncated = truncateHead(text, { maxBytes: 30000, maxLines: 1000 });
    if (!truncated.truncated) return { content: [{ type: "text" as const, text }], details: data };
    const path = join(get(ctx).directory, `result-${randomUUID()}.json`);
    writeFileSync(path, text, { mode: 0o600 });
    return { content: [{ type: "text" as const, text: `${truncated.content}\n[Truncated. Full result: ${path}]` }], details: { fullResult: path } };
  };

  const startSession = (ctx: ExtensionContext) => {
    context = ctx;
    // Other extensions (p3stack's setup) read which models a Child may use. Commands
    // cannot call tools, so the bus carries a synchronous reply; nothing else is shared.
    stopCatalogEvents ??= pi.events.on(CATALOG_CHANNEL, request => {
      const reply = (request as { reply?: unknown } | undefined)?.reply;
      if (typeof reply !== "function" || !context) return;
      const catalog = getPolicy(context).catalog();
      reply({ spawnEnabled: catalog.spawnEnabled, models: catalog.models.map(model => model.id) });
    });
    restoreFooter?.();
    if (ctx.mode === "tui") {
      stopFooterEvents ??= pi.events.on(FOOTER_CHANNEL, request => {
        const data = request as { lines?: string[]; width?: number; reply?: (lines: string[]) => void } | undefined;
        if (!context || !Array.isArray(data?.lines) || typeof data.width !== "number" || typeof data.reply !== "function") return;
        const theme = context.ui.theme;
        data.reply(decorateFooter(data.lines, data.width, footerLabel, text => theme.fg("dim", text)));
      });
      restoreFooter = installFooterDecoration(FooterComponent.prototype,
        () => footerLabel, text => ctx.ui.theme.fg("dim", text));
      // Like herdr's own integration, TUI only: RPC/print parents have no pane to show.
      herdr ??= HerdrStatus.fromEnv(process.env, (): Record<string, string> => {
        const file = ctx.sessionManager.getSessionFile();
        return file?.startsWith("/") ? { agent_session_path: file } : { agent_session_id: ctx.sessionManager.getSessionId() };
      });
      stopHerdrEvents ??= herdr && pi.events.on("herdr:blocked", data => herdr?.blocked(data));
      herdr?.start(!ctx.isIdle());
    }
    if (ctx.mode === "tui" || ctx.mode === "rpc") {
      const manager = get(ctx);
      // Recover delivery receipts if a reload/crash happened after the report
      // entered history but before the registry acknowledgement was persisted.
      const delivered = ctx.sessionManager.getEntries().flatMap(entry =>
        entry.type === "custom_message" && entry.customType === "subagent-report" ? noticeKeys(entry.details) : []);
      const workflows = getWorkflows(ctx);
      if (delivered.length) { manager.markNoticesDelivered(delivered); workflows.markNoticesDelivered(delivered); }
      notifications?.dispose();
      notifications = new NoticeScheduler({
        idle: () => context?.isIdle() === true,
        pending: () => [...manager.pendingNotices(), ...workflows.pendingNotices()],
        send: batch => pi.sendMessage({
          customType: "subagent-report", content: batch.content, display: true,
          details: { noticeKeys: batch.notices.map(notice => notice.key) },
        }, { deliverAs: batch.supervisory && !context?.isIdle() ? "steer" : "followUp", triggerTurn: true }),
        error: error => ctx.ui.notify(`Subagent report delivery failed; unread reports retained: ${error}`, "warning"),
      });
      notifications.wake();
      refresh();
      const policy = getPolicy(ctx);
      policy.catalog();
      if (policy.diagnostics.length) ctx.ui.notify(`Subagent policy: ${policy.diagnostics.length} diagnostic(s). See /subagents diagnostics.`, "warning");
    }
  };
  pi.on("session_start", (_event, ctx) => startSession(ctx));
  pi.on("agent_start", () => { notifications?.busy(); herdr?.parent(true); });
  pi.on("agent_settled", (_event, ctx) => {
    notifications?.wake();
    loops?.settled();
    if (ctx.isIdle()) herdr?.parent(false);
  });
  pi.on("message_end", event => {
    if ("customType" in event.message && event.message.customType === "subagent-report") {
      const keys = noticeKeys(event.message.details);
      if (keys.length) {
        manager?.markNoticesDelivered(keys);
        workflows?.markNoticesDelivered(keys);
        notifications?.delivered(keys);
      }
    }
  });
  pi.on("session_shutdown", async () => {
    loops?.dispose();
    loops = undefined;
    inspector?.close();
    inspector = undefined;
    notifications?.dispose();
    notifications = undefined;
    const herdrCleared = herdr?.dispose();
    herdr = undefined;
    stopHerdrEvents?.();
    stopHerdrEvents = undefined;
    stopCatalogEvents?.();
    stopCatalogEvents = undefined;
    stopFooterEvents?.();
    stopFooterEvents = undefined;
    try { await workflows?.shutdown(); await manager?.shutdown(); }
    finally {
      await herdrCleared;
      restoreFooter?.();
      restoreFooter = undefined;
      footerLabel = "";
      manager = undefined;
      workflows = undefined;
      context?.ui.setStatus("workflows", undefined);
      policy = undefined;
      context = undefined;
    }
  });

  const displayName = (kind: "child" | "workflow", id: string) => {
    try {
      return kind === "workflow" ? workflows?.get(id).definition.name : manager?.get(id).name;
    } catch {
      return undefined;
    }
  };
  const render = (action: Parameters<typeof subagentRenderers>[0]) => subagentRenderers(action, displayName);
  registerWorkflowUI(pi, getWorkflows, result, displayName);

  registerTool({
    name: "subagent_catalog", label: "Subagent Catalog",
    ...render("catalog"),
    ...TOOL_SPECS.subagent_catalog,
    async execute(_call, _args, _signal, _update, ctx) {
      const callerId = delegation.getStore()?.callerId;
      const childDepth = callerId ? (get(ctx).get(callerId).depth ?? 1) + 1 : 1;
      const catalog = getPolicy(ctx).catalog(childDepth);
      return result(callerId ? { ...catalog, delegation: { childDepth, maxDepth: catalog.maxDepth, childrenMayDelegate: childDepth < catalog.maxDepth } } : catalog, ctx);
    },
  });
  registerTool({
    name: "subagent_loop", label: "Subagent Loop",
    ...render("loop"),
    description: "Start periodic idle-parent turns with a task and intervalSeconds, or get status or stop. Put the stop condition in the task; stop explicitly when met.",
    parameters: Type.Object({
      op: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")]),
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "start: what each tick should do, including its stop condition." })),
      intervalSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "start: seconds between ticks; at least the policy minimum." })),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1, description: "start: at most this many ticks; defaults to the policy maximum." })),
      maxDurationMinutes: Type.Optional(Type.Integer({ minimum: 1, description: "start: stop after this long; defaults to the policy maximum." })),
    }, { additionalProperties: false }),
    async execute(_call, args, _signal, _update, ctx) {
      if (args.op === "start" && (args.task === undefined || args.intervalSeconds === undefined)) throw new Error("start needs task and intervalSeconds");
      const { text, state } = loopAction(ctx, args.op === "start"
        ? { op: "start", task: args.task!, intervalMs: args.intervalSeconds! * 1000, maxIterations: args.maxIterations,
            maxDurationMs: args.maxDurationMinutes === undefined ? undefined : args.maxDurationMinutes * 60_000 }
        : args.op === "stop" ? { op: "stop", by: "parent" } : { op: "status" });
      return { content: [{ type: "text" as const, text }], details: state ?? {} };
    },
  });
  registerTool({
    name: "subagent_spawn", label: "Spawn Subagent",
    ...render("spawn"),
    ...TOOL_SPECS.subagent_spawn,
    async execute(_call, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { name, task, cwd: requested, coordination: declared, worktree: wanted, ...selection } = args;
      const manager = get(ctx);
      const policy = getPolicy(ctx);
      // A proxied spawn from a Child: the new Child joins that Child's subtree.
      const parentId = delegation.getStore()?.callerId;
      const depth = parentId ? (manager.get(parentId).depth ?? 1) + 1 : 1;
      let config = policy.compile(requested, selection, depth);
      const capacity = manager.capacity();
      // A delegating Child sees only its own subtree, in errors and warnings too.
      const visible = <T extends { id: string }>(records: T[]) => parentId ? records.filter(record => manager.isDescendant(record.id, parentId)) : records;
      if (!capacity.available) throw new Error(`${capacityReachedText(capacity, parentId ? "nested" : "root")} Recovery: ${JSON.stringify(recoverySummary(visible(manager.list()), capacity))}`);
      if (!name.trim() || !task.trim()) throw new Error("name and task must not be empty");
      // Everything is checked before git writes anything, the destination included.
      const plan = wanted ? planWorktree({ cwd: requested, name, ...(typeof wanted === "object" ? wanted : {}) }) : undefined;
      if (plan) policy.newDirectory(plan.path);
      normalizeCoordination(declared, plan?.path ?? requested);
      const creationLock = plan ? `pending subagent spawn ${randomUUID()}` : undefined;
      let worktree: Worktree | undefined, accepted = false;
      try {
        if (plan) worktree = createWorktree(plan, creationLock);
        const cwd = worktree?.path ?? requested;
        if (worktree) config = policy.compile(cwd, selection, depth);
        const coordination = normalizeCoordination(declared, cwd);
        const child = await manager.spawn({ name, task, ...config, coordination, ...(parentId ? { parentId } : {}) });
        accepted = true; // A lost receipt must not remove a live child's checkout.
        if (worktree && creationLock) releaseCreationLock(worktree, creationLock);
        const record = manager.get(child.id);
        const all = coordinationWarnings(coordination, manager.list(), child.id), warnings = visible(all);
        const outside = all.length - warnings.length;
        const receipt: SpawnReceipt = {
          ...childNews(record),
          ...(record.model ? { model: record.model } : {}),
          ...(record.thinking ? { thinking: record.thinking } : {}),
          ...(worktree ? { worktree } : {}),
          coordinationWarnings: warnings.slice(0, 25),
          coordinationWarningCount: warnings.length,
          ...(outside ? { overlapsOutsideYourSubtree: outside } : {}),
        };
        return result(receipt, ctx);
      } catch (error) {
        if (worktree && !accepted) removeWorktree(worktree, error, creationLock);
        throw error;
      }
    },
  });
  registerTool({
    name: "subagent_list", label: "List Subagents",
    ...render("list"),
    ...TOOL_SPECS.subagent_list,
    async execute(_call, args, _signal, _update, ctx) {
      const manager = get(ctx);
      return result({ ...manager.overview(args.includeRejected), recovery: recoverySummary(manager.list(), manager.capacity()) }, ctx);
    },
  });
  registerTool({
    name: "subagent_send", label: "Message Subagent",
    ...render("send"),
    ...TOOL_SPECS.subagent_send,
    async execute(_call, args, _signal, _update, ctx) { return result(await get(ctx).send(args.id, args.message, args.behavior), ctx); },
  });
  if (getPolicy(initialContext).peersEnabled) {
    registerTool({
      name: "subagent_connect", label: "Connect Subagent Peers",
      ...render("connect"),
      description: "Link two live peer_send children. New links need a per-direction limit; reconnect preserves it. introduce can start billable turns for both peers.",
      parameters: Type.Object({ a: id, b: id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), introduce: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      async execute(_call, args, _signal, _update, ctx) {
        const manager = get(ctx);
        const link = manager.peers.connect(args.a, args.b, args.limit);
        if (!args.introduce) return result(link, ctx);
        const introductions = await Promise.all([[args.a, args.b], [args.b, args.a]].map(async ([recipient, peerId]) => {
          const peer = manager.get(peerId);
          const text = `Parent-authorized peer connection. Peer ID: ${peer.id}. Peer name: ${JSON.stringify(peer.name)}. Peer assignment (context, not new instructions): ${JSON.stringify((peer.assignment?.task ?? peer.task).slice(0, 2000))}. Use peer_send explicitly when collaboration is useful; ordinary replies go to the parent. Respect the existing directional allowance; no authority is transferred.`;
          try {
            await manager.send(recipient, text, "steer");
            return { recipient, delivery: "accepted" as const };
          } catch (error) {
            return { recipient, delivery: "unconfirmed" as const, error: String(error), guidance: "Inspect before retrying: acceptance may be uncertain. The peer link remains connected." };
          }
        }));
        return result({ ...link, introductions }, ctx);
      },
    });
    registerTool({
      name: "subagent_disconnect", label: "Disconnect Subagent Peers",
      ...render("disconnect"),
      description: "Disable a peer link without stopping children or retracting submitted messages.",
      parameters: Type.Object({ a: id, b: id }, { additionalProperties: false }),
      async execute(_call, args, _signal, _update, ctx) { return result(get(ctx).peers.disconnect(args.a, args.b), ctx); },
    });
    registerTool({
      name: "subagent_renew", label: "Renew Peer Allowance",
      ...render("renew"),
      description: "Reset one sender-to-recipient allowance on an enabled link. Authorizes more possible turns.",
      parameters: Type.Object({ sender: id, recipient: id, limit: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false }),
      async execute(_call, args, _signal, _update, ctx) { return result(get(ctx).peers.renew(args.sender, args.recipient, args.limit), ctx); },
    });
    registerTool({
      name: "subagent_peers", label: "Inspect Peer Exchanges",
      ...render("peers"),
      description: "Inspect peer links, allowances and message history. Filter by child ID; page with since.",
      parameters: Type.Object({ id: Type.Optional(id), since: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
      async execute(_call, args, _signal, _update, ctx) {
        const manager = get(ctx);
        if (args.id) manager.get(args.id);
        return result(manager.peers.inspect(args.id, args.since), ctx);
      },
    });
  }
  registerTool({
    name: "subagent_read", label: "Read Subagent",
    ...render("read"),
    ...TOOL_SPECS.subagent_read,
    async execute(_call, args, _signal, _update, ctx) {
      const manager = get(ctx);
      const data = manager.read(args.id, args.since, false);
      const output = result(data, ctx);
      // If the formatter spills to disk, don't claim unseen updates were read.
      if (output.details === data) manager.acknowledgeRead(data, args.since === undefined, !delegation.getStore());
      return output;
    },
  });
  const rootLatch = messageLatch();
  registerTool({
    name: "subagent_wait", label: "Wait for Subagents",
    ...render("wait"),
    ...TOOL_SPECS.subagent_wait,
    async execute(_call, args, signal, _update, ctx) {
      const manager = get(ctx), callerId = delegation.getStore()?.callerId;
      const operatorMessageQueued = callerId ? undefined : () => rootLatch(ctx.hasPendingMessages());
      const end = await manager.wait(args.ids ?? [], args.mode ?? DEFAULT_WAIT_MODE,
        args.timeoutSeconds === undefined ? undefined : args.timeoutSeconds * 1000, signal, operatorMessageQueued, callerId);
      signal?.throwIfAborted();
      const { report, receipts } = waitReport(manager, end, args.collect ?? true, callerId, undefined, args.final ?? false);
      const output = result(report, ctx);
      if (output.details !== report) return output;
      for (const receipt of receipts) manager.acknowledgeRead(receipt, true, !callerId);
      // Acknowledgement only turns unreviewed into reviewed, which is shorter, so this still fits.
      return result(withCurrentReviews(manager, report), ctx);
    },
  });
  registerTool({
    name: "subagent_abort", label: "Abort Subagent Work",
    ...render("abort"),
    description: "Cancel queued and current work in this subtree; keep live children available for redirection.",
    parameters: Type.Object({ id }),
    async execute(_call, args, _signal, _update, ctx) { return result(await get(ctx).abort(args.id), ctx); },
  });
  registerTool({
    name: "subagent_close", label: "Close Subagent",
    ...render("close"),
    ...TOOL_SPECS.subagent_close,
    async execute(_call, args, _signal, _update, ctx) { return result(await get(ctx).close(args.id), ctx); },
  });
  registerTool({
    name: "subagent_release_hold", label: "Release Human Hold",
    ...render("release-hold"),
    description: "Discuss the intervention with the user first. Release each held child, then its workflow. Release does not resume work.",
    parameters: Type.Object({ id: Type.String({ description: "Held child or workflow ID." }) }, { additionalProperties: false }),
    async execute(_call, args, _signal, _update, ctx) {
      const manager = get(ctx), engine = getWorkflows(ctx);
      if (engine.list().some(run => run.id === args.id)) {
        engine.releaseIntervention(args.id);
        const run = engine.get(args.id);
        return result({ id: run.id, name: run.definition.name, status: run.status, holdReleased: true, workStarted: false }, ctx);
      }
      const child = manager.releaseHold(args.id);
      if (child.workflow) engine.releaseIntervention(args.id);
      return result({ ...child, holdReleased: true, workStarted: false, workflowRequiresRelease: child.workflow }, ctx);
    },
  });
  registerTool({
    name: "subagent_resume", label: "Resume Subagent",
    ...render("resume"),
    description: "Restart a stopped child's saved conversation under current policy; optionally send a new message. No automatic replay.",
    parameters: Type.Object({ id, message: Type.Optional(message) }, { additionalProperties: false }),
    async execute(_call, args, _signal, _update, ctx) { return result(await get(ctx).resume(args.id, args.message), ctx); },
  });
  registerTool({
    name: "subagent_respond", label: "Respond to Subagent UI",
    ...render("respond"),
    description: "Answer a dialog from subagent_read with one of value, confirmed or cancelled. Ask the user for human decisions. Queued does not confirm receipt.",
    parameters: Type.Object({ id, requestId: Type.String(), value: Type.Optional(Type.String()), confirmed: Type.Optional(Type.Boolean()), cancelled: Type.Optional(Type.Boolean()) }),
    async execute(_call, { id, requestId, ...response }, _signal, _update, ctx) {
      if (Object.values(response).filter(v => v !== undefined).length !== 1) throw new Error("Supply exactly one of value, confirmed, cancelled");
      return result(await get(ctx).respond(id, requestId, response), ctx);
    },
  });
  pi.registerCommand("loop", {
    description: "Wake this session on an interval: /loop <30s|5m|1h> <task>, /loop stop, or /loop for status. Needs a loops policy.",
    handler: async (args, ctx) => {
      const say = (text: string, kind: "info" | "warning" = "info") => { if (ctx.hasUI) ctx.ui.notify(text, kind); };
      const [first = "", ...rest] = args.trim().split(/\s+/);
      try {
        if (!first) { say(loopAction(ctx, { op: "status" }).text); return; }
        if (first === "stop") { say(loopAction(ctx, { op: "stop", by: "user" }).text); return; }
        const intervalMs = parseInterval(first);
        if (intervalMs === undefined || !rest.length) { say("Usage: /loop <30s|5m|1h> <task> | /loop stop | /loop", "warning"); return; }
        say(`${loopAction(ctx, { op: "start", task: rest.join(" "), intervalMs }).text} Stop it with /loop stop.`);
      } catch (error) { say(error instanceof Error ? error.message : String(error), "warning"); }
    },
  });
  pi.registerCommand("subagents", {
    description: "Observe agents/workflows; list, diagnostics, emergency halt <id>, confirmed kill <id>. The parent manages agents.",
    handler: async (args, ctx) => {
      const [action, target] = args.trim().split(/\s+/);
      const manager = get(ctx);
      if (!action && ctx.mode === "tui") {
        if (inspector) return;
        try {
          const intervene = async (id: string, kind: "halt" | "kill") => {
            const child = await manager.intervene(id, kind);
            return { ok: child.hold?.outcome === "confirmed", message: child.hold?.detail ?? `${kind} requested; parent notified. Work remains held.` };
          };
          await showInspector(ctx, inspectorSource(manager, getWorkflows(ctx)), panel => { inspector = panel; }, {
            halt: id => intervene(id, "halt"), kill: id => intervene(id, "kill"),
          });
        }
        finally { inspector = undefined; }
        return;
      }
      if (action === "diagnostics") {
        const policy = getPolicy(ctx);
        policy.catalog();
        ctx.ui.notify(`Policy: ${policy.source}\n${policy.diagnostics.join("\n") || "No policy diagnostics."}`, policy.diagnostics.length ? "warning" : "info");
        return;
      }
      if ((action === "halt" || action === "kill") && target) {
        const child = manager.get(target);
        if (action === "kill" && !await ctx.ui.confirm("kill subagent process?", `Force-stop ${child.name} (${child.id})? Saved history remains, edits are not rolled back, and detached subprocesses may remain. The parent will be notified and work held.`)) return;
        const outcome = await manager.intervene(target, action);
        const confirmed = outcome.hold?.outcome === "confirmed";
        ctx.ui.notify(`${action} ${outcome.hold?.outcome ?? "unknown"} · ${child.name.toLowerCase()} (${child.id})\n${outcome.hold?.detail ?? "Inspect the worker state."}\nparent notified; work remains held.${!confirmed && action === "halt" ? `\nIf necessary, use /subagents kill ${child.id} for confirmed break-glass process termination.` : ""}`, confirmed ? "info" : "warning");
        return;
      }
      else if (action && action !== "list") throw new Error("Usage: /subagents [list | diagnostics | halt <id> | kill <id>]. Ask the parent to manage agents.");
      await manager.refreshUsageSnapshots();
      ctx.ui.notify(cardsFromDetails(manager.list(), "summary").map(card => listingLine(card).text).join("\n") || "No subagents tracked.", "info");
    },
  });
  // session_start handlers added during dispatch run on the next event only.
  startSession(initialContext);
}
