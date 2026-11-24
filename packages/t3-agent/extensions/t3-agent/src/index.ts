import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, LOADOUTS, readConfig, type Config, type Loadout } from "./config.ts";
import { detectHost } from "./host.ts";
import { ENTRY_TYPE, Ledger, observe, rebuild, resultPayload, trackRunTab, type Handle } from "./ledger.ts";
import { desiredTools, nextActive } from "./loadout.ts";
import { buildSection, SECTION } from "./prompt.ts";
import { modeLabel, runtimeMode, t3ToolName, T3_PREFIX, type Environment } from "./runtime.ts";
import { readWorkspace, type Workspace } from "./workspace.ts";

export const STATUS_KEY = "t3-agent";
export const LOADOUT_ENTRY = "t3-agent.loadout";
export const REMINDER_TYPE = "t3-agent.reminder";
/** The bridge already declares these; the prompt does not list them again. */
const BRIDGE_DIRECT = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);
/** Above this many, the prompt says "every T3 tool" instead of listing names. */
const MAX_LISTED = 16;

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources");

type Entry = { type: string; customType?: string; data?: unknown };

export default function t3Agent(pi: ExtensionAPI, env: Environment = process.env): void {
  // Outside T3 the package does nothing at all: no tools, commands, prompt text or resources.
  if (detectHost(env) !== "t3") return;

  const mode = runtimeMode(env);
  const ledger = new Ledger();
  let config: Config = DEFAULT_CONFIG;
  let problems: string[] = [];
  let problemsReported = false;
  let sessionLoadout: Loadout | undefined;
  let managed = new Set<string>();
  let declared: string[] = [];
  let workspace: Workspace | undefined;
  let pending: Handle[] = [];
  let openedThisRun = new Set<string>();
  let reminded = false;

  const loadout = () => sessionLoadout ?? config.loadout;

  pi.on("resources_discover", () => ({
    skillPaths: [join(resources, "skills")],
    promptPaths: [join(resources, "prompts")],
  }));

  const applyLoadout = () => {
    const desired = desiredTools({ loadout: loadout(), extra: config.tools, mode, ledger, allTools: pi.getAllTools() });
    const before = pi.getActiveTools();
    const next = nextActive(before, desired, managed);
    managed = next.managed;
    if (next.changed) pi.setActiveTools(next.active);
    declared = pi.getActiveTools().filter(name => name.startsWith(T3_PREFIX) && !BRIDGE_DIRECT.has(name.slice(T3_PREFIX.length)));
  };

  const statusText = () => {
    const counts = [
      [ledger.open("delegate").length, "delegate"],
      [ledger.open("schedule").length, "schedule"],
      [ledger.open("pr").length, "watched PR"],
      [ledger.open("preview").length, "tab"],
    ].filter(([count]) => (count as number) > 0).map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);
    return [`t3-agent: ${modeLabel(mode)}`, `${loadout()} loadout`, ...counts].join(" · ");
  };
  const refreshStatus = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, statusText());

  const restore = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch() as Entry[];
    rebuild(ledger, branch);
    sessionLoadout = undefined;
    for (const entry of branch) {
      const value = (entry.data as { loadout?: unknown } | undefined)?.loadout;
      if (entry.type === "custom" && entry.customType === LOADOUT_ENTRY && LOADOUTS.includes(value as Loadout)) sessionLoadout = value as Loadout;
    }
  };

  const refreshWorkspace = async (ctx: ExtensionContext) => {
    workspace = await readWorkspace((command, args, options) => pi.exec(command, args, options), ctx.cwd);
  };

  pi.on("session_start", async (_event, ctx) => {
    ({ config, problems } = readConfig(ctx.cwd, ctx.isProjectTrusted()));
    restore(ctx);
    await refreshWorkspace(ctx);
    applyLoadout();
    refreshStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    applyLoadout();
    refreshStatus(ctx);
  });

  // A model change can reset the loadout the bridge reconciles; reapply ours after it.
  pi.on("model_select", () => applyLoadout());

  pi.on("before_agent_start", async (event, ctx) => {
    openedThisRun = new Set();
    reminded = false;
    // T3 drops notices outside a turn, so report configuration problems on the first turn.
    if (!problemsReported && problems.length > 0) {
      problemsReported = true;
      ctx.ui.notify(`t3-agent configuration:\n${problems.join("\n")}`, "warning");
    }
    await refreshWorkspace(ctx);
    applyLoadout();
    const section = buildSection({
      mode,
      workspace,
      declared: declared.length > MAX_LISTED ? [] : declared,
      allDeclared: declared.length > MAX_LISTED,
      ledger: ledger.render(),
    });
    const options = event.systemPromptOptions;
    if (options?.sections && options.forceSystemPrompt === undefined) {
      options.sections[SECTION] = section;
      return undefined;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
  });

  pi.on("tool_result", (event, ctx) => {
    const tool = t3ToolName(event.toolName);
    if (tool === undefined || event.isError) return undefined;
    const result = resultPayload(event.content, event.structuredContent);
    trackRunTab(openedThisRun, tool, event.input, result);
    const updates = observe(tool, event.input, result);
    if (updates.length === 0) return undefined;
    for (const update of updates) {
      ledger.apply(update);
      pending.push(update);
    }
    applyLoadout();
    refreshStatus(ctx);
    return undefined;
  });

  const flush = (): SessionBoundaryDraft[] => {
    const drafts = pending.map(data => ({ type: "custom" as const, customType: ENTRY_TYPE, data }));
    pending = [];
    return drafts;
  };

  // Persist ledger changes at the turn boundary, where Pi accepts extension entries.
  pi.on("turn_end", event => {
    if (pending.length === 0) return undefined;
    return { entries: [...event.entries, ...flush()] };
  });

  pi.on("agent_before_settle", event => {
    const entries = [...event.entries, ...flush()];
    const stale = [...openedThisRun].filter(id => ledger.open("preview").some(handle => handle.id === id));
    if (reminded || event.outcome !== "completed" || stale.length === 0) {
      return entries.length === event.entries.length ? undefined : { entries };
    }
    // T3's guidance: close a tab you opened before you reply. Remind once per run.
    reminded = true;
    const tabs = stale.map(id => `\`${id}\``).join(", ");
    return {
      entries: [...entries, {
        type: "custom_message",
        customType: REMINDER_TYPE,
        content: `Automated note from the t3-agent extension, not from the user: you opened T3 preview tab ${tabs} during this turn and it is still open. Close it with \`t3_preview_close\` before you reply, unless the user asked to keep it open or is using it; in that case reply without closing it.`,
        display: false,
      }],
      continue: true,
    };
  });

  pi.on("agent_settled", (_event, ctx) => refreshStatus(ctx));

  pi.registerCommand("t3-agent", {
    description: "T3 agent status, or set this session's T3 tool loadout (lean, standard, full)",
    getArgumentCompletions: prefix => ["status", "ledger", ...LOADOUTS.map(name => `loadout ${name}`), "forget all"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [verb = "status", value] = args.trim().split(/\s+/).filter(Boolean);
      if (verb === "loadout") {
        if (!LOADOUTS.includes(value as Loadout)) {
          ctx.ui.notify(`Usage: /t3-agent loadout ${LOADOUTS.join("|")}. Current: ${loadout()}.`, "warning");
          return;
        }
        sessionLoadout = value as Loadout;
        pi.appendEntry(LOADOUT_ENTRY, { loadout: sessionLoadout });
        applyLoadout();
        refreshStatus(ctx);
        ctx.ui.notify(`t3-agent loadout: ${sessionLoadout} for this session. Declared T3 tools: ${declared.map(name => name.slice(T3_PREFIX.length)).join(", ") || "the bridge's three only"}.`, "info");
        return;
      }
      if (verb === "forget") {
        const closing = ledger.forget(value ?? "");
        if (closing.length === 0) {
          ctx.ui.notify("Usage: /t3-agent forget <id|all>. Nothing open matched.", "warning");
          return;
        }
        for (const close of closing) pi.appendEntry(ENTRY_TYPE, close);
        applyLoadout();
        refreshStatus(ctx);
        ctx.ui.notify(`Forgot ${closing.length} T3 handle${closing.length === 1 ? "" : "s"}. This closes nothing in T3.`, "info");
        return;
      }
      if (verb === "ledger") {
        const pages = ledger.pages();
        for (const page of pages.length ? pages : ["No open T3 handles in this session."]) ctx.ui.notify(page, "info");
        return;
      }
      if (verb !== "status") {
        ctx.ui.notify("Usage: /t3-agent [status | ledger | loadout lean|standard|full | forget <id|all>]", "warning");
        return;
      }
      ctx.ui.notify(statusReport(), "info");
    },
  });

  const statusReport = () => [
    `t3-agent is active: T3 Code launched this Pi (T3_MCP_URL is set).`,
    `Permission mode: ${modeLabel(mode)}.`,
    `Loadout: ${loadout()}${sessionLoadout ? " (set for this session)" : ""}. Declared T3 tools beyond the bridge's: ${declared.map(name => name.slice(T3_PREFIX.length)).join(", ") || "none"}.`,
    workspace ? `Workspace: ${workspace.root}${workspace.branch ? ` on ${workspace.branch}` : ""}${workspace.t3Managed ? " (T3 worktree)" : workspace.linked ? " (linked worktree)" : ""}.` : "Workspace: not a git checkout.",
    `Open handles:\n${ledger.render() ?? "none"}`,
    ...(problems.length > 0 ? [`Configuration problems:\n${problems.join("\n")}`] : []),
  ].join("\n");
}
