// p3stack's hand-written extension: the poteto-mode toggle, ask_user, the role
// table and its setup command. The skills it serves are generated; see AGENTS.md.
// Written against the subset of Pi's extension API it uses, so the package needs
// no Pi SDK of its own; the package-layout test loads it through Pi's real loader.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { doctor } from "./src/doctor.ts";
import { detectHost, registerHostAware } from "./src/host.ts";
import { agentDir, BUDGETS, candidates, CODE_ROLES, JUDGMENT_ROLES, PANEL_ROLES, liveRoles, type Budget, type ModelInfo } from "./src/roles.ts";

interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}
interface Context {
  cwd: string; hasUI: boolean; mode?: string; ui: Ui; isProjectTrusted(): boolean;
  model?: { provider: string; id: string };
  getThinkingLevel(): string;
  executeTool(name: string, args: object): Promise<{ content: unknown; structuredContent?: unknown; isError?: boolean }>;
  modelRegistry: { getAvailable(): ModelInfo[] };
  sessionManager: { getBranch(): { type: string; customType?: string; data?: unknown }[] };
}
interface Pi {
  registerTool(tool: object): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: Context) => Promise<void> }): void;
  on(event: string, handler: (event: any, ctx: Context) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  getAllTools(): { name: string; exposure?: string }[];
  events: { emit(channel: string, data: unknown): void };
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modeSkill = join(packageDir, "skills", "poteto-mode", "SKILL.md");
const agentRecipe = join(packageDir, "agents", "poteto-agent.md");
const MODE = "p3stack";
const TURN = "p3stack-turn";
/** Opens the short recipe for Children that only investigate. */
const READER = "You are a read-only delegate in a poteto-mode run.";
const OTHER = "Other (type an answer)";
// The subagents package replies synchronously on this channel; see its README.
const CATALOG_CHANNEL = "subagents:catalog";
const text = (body: string, structuredContent?: unknown) => ({ content: [{ type: "text", text: body }], details: structuredContent ?? {}, ...(structuredContent ? { structuredContent } : {}) });
const format = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const targetSchema = Type.Object({ providerInstanceId: Type.String(), model: Type.String(), options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), value: Type.String() }))) });
const selectionSchema = Type.Union([Type.String(), targetSchema]);

export default function p3stack(pi: Pi) {
  let modeOn = false;
  const showMode = (ctx: Context) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("p3stack", modeOn ? "p3stack on" : undefined);
  };
  const rebuild = async (_event: unknown, ctx: Context) => {
    modeOn = false;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === MODE) modeOn = (entry.data as { on?: boolean } | undefined)?.on === true;
    showMode(ctx);
  };
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);

  pi.on("before_agent_start", event => {
    const sections = event?.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (sections) {
      if (modeOn) sections[MODE] = `Read ${modeSkill} and follow it.`;
      else delete sections[MODE];
    }
    if (!modeOn || event?.messageType !== "user") return;
    return { message: { customType: TURN, display: false, content: `[poteto-mode is on] Before anything else, route this request: read ${modeSkill} if you have not read it in this session, pick the matching playbook, read that playbook, put its steps in the todo list verbatim, and follow them. Before delegating, call \`p3stack_roles\` for the role models. Only a question about the mode itself skips this.` } };
  });

  pi.registerCommand("p3stack", {
    description: "Turn poteto-mode on or off, show status, or write the T3 contract report. /p3stack on | off | status | doctor",
    handler: async (args, ctx) => {
      const want = args.trim();
      if (want === "doctor") {
        const file = doctor(pi);
        if (ctx.hasUI) ctx.ui.notify(`Wrote ${file}`, "info");
        return;
      }
      if (want === "on" || want === "off") {
        modeOn = want === "on";
        pi.appendEntry(MODE, { on: modeOn });
        showMode(ctx);
      }
      if (ctx.hasUI) ctx.ui.notify(want === "on" || want === "off" || want === "status" || !want ? `poteto-mode is ${modeOn ? "on" : "off"}.` : "Usage: /p3stack on | off | status | doctor", "info");
    },
  });

  pi.on("tool_call", event => {
    if (!modeOn || !["subagent_spawn", "mcp__t3-code__delegate_task"].includes(event?.toolName)) return;
    const input = event.input as { task?: unknown; tools?: unknown; role?: unknown };
    if (typeof input?.task !== "string" || input.task.includes(agentRecipe) || input.task.startsWith(READER)) return;
    const readOnly = event.toolName === "subagent_spawn"
      ? Array.isArray(input.tools) && !["edit", "write", "subagent_spawn"].some(tool => (input.tools as unknown[]).includes(tool))
      : input.role === "research" || input.role === "review";
    input.task = readOnly
      ? `${READER} Answer only this brief: do not read the poteto-mode skill, start a playbook, or delegate. Prove each claim (run read-only commands where they settle it) and cite file:line evidence. Report in the shape the brief asks, plainly and briefly; your report is input to your parent's decision.\n\n${input.task}`
      : `Before any work, read ${agentRecipe} and follow it; the poteto-mode skill is at ${modeSkill}.\n\n${input.task}`;
  });

  pi.registerTool({
    name: "ask_user", label: "Ask the Human",
    description: "Ask the human a product or preference question that no experiment can settle, with choices or free text. Without an interactive UI nobody is asked: apply the default you state and say so.",
    promptSnippet: "ask_user: ask the human only for product or preference calls; otherwise decide and report",
    exposure: "model-only",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 12, description: "Choices; omit for a free-text answer." })),
      allowOther: Type.Optional(Type.Boolean({ description: "Also offer a free-text answer beside the options." })),
      default: Type.Optional(Type.String({ maxLength: 500, description: "What you will do if nobody answers." })),
    }, { additionalProperties: false }),
    async execute(_call: string, args: { question: string; options?: string[]; allowOther?: boolean; default?: string }, _signal: unknown, _update: unknown, ctx: Context) {
      const fallback = args.default ? `apply your default (${args.default})` : "apply a reasonable default";
      if (!ctx.hasUI) return text(`No one can be asked: this session has no interactive UI. ${fallback[0]!.toUpperCase()}${fallback.slice(1)} and say so in your reply.`);
      let answer: string | undefined;
      if (args.options) {
        answer = await ctx.ui.select(args.question, args.allowOther ? [...args.options, OTHER] : args.options);
        if (answer === OTHER) answer = await ctx.ui.input(args.question);
        else if (answer !== undefined) return text(`The human chose: ${answer}`);
      } else answer = await ctx.ui.input(args.question);
      return answer === undefined || answer.trim() === ""
        ? text(`The human dismissed the question. ${fallback[0]!.toUpperCase()}${fallback.slice(1)} and say so in your reply.`)
        : text(`The human answered: ${answer}`);
    },
  });

  registerHostAware(pi as { registerTool(tool: object): void }, {
    name: "p3stack_roles", label: "p3stack Roles",
    description: "Resolve every p3stack role against the live catalog. Return exact provider/model:thinking identities or ready T3 targets, and report unavailable roles.",
    parameters: Type.Object({}, { additionalProperties: false }),
    reachesTools: () => ["mcp__t3-code__orchestrator_capabilities"],
    outputSchema: Type.Object({ source: Type.String(), budget: Type.Optional(Type.String()), roles: Type.Record(Type.String(), Type.Union([selectionSchema, Type.Array(selectionSchema)])), problems: Type.Array(Type.String()) }),
    async execute(_call: string, _args: unknown, _signal: unknown, _update: unknown, ctx: Context) {
      const resolved = await liveRoles(pi, ctx);
      const lines = Object.entries(resolved.roles).map(([role, value]) => `${role}: ${format(value)}`);
      const head = `Role defaults from ${resolved.source}${resolved.budget ? ` (budget ${resolved.budget})` : ""}.`;
      return text([head, ...resolved.problems, ...lines].join("\n"), resolved);
    },
  }, { duplicatesT3: false });

  const readCatalog = () => {
    let catalog: { spawnEnabled: boolean; models: string[] } | undefined;
    pi.events.emit(CATALOG_CHANNEL, { reply: (value: typeof catalog) => { catalog = value; } });
    return catalog as typeof catalog;
  };

  pi.registerCommand("p3stack-setup", {
    description: "Choose a thinking budget, a code model and a judgment model, and write ~/.pi/agent/p3stack.json for every p3stack role",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      // Under T3, roles name T3 targets that only the model can list; the skill does that.
      if (detectHost() === "t3") { ctx.ui.notify("Under T3 Code, run /skill:setup-pstack: it reads T3's model catalog.", "info"); return; }
      // With subagents loaded, roles must name identities its allowlist permits. A command
      // cannot call subagent_catalog, so ask over the event bus; no reply means an older subagents.
      const withSubagents = pi.getAllTools().some(tool => tool.name === "subagent_catalog");
      const catalog = withSubagents ? readCatalog() : undefined;
      if (withSubagents) {
        if (!catalog) { ctx.ui.notify("This subagents version cannot share its catalog with a command. Run /skill:setup-pstack: it reads subagent_catalog.", "info"); return; }
        if (!catalog.spawnEnabled) { ctx.ui.notify("Your subagents policy does not permit spawning, so no role can run. Check subagent_catalog or /subagents diagnostics.", "warning"); return; }
      }
      const models = ctx.modelRegistry.getAvailable();
      if (!catalog && !models.length) { ctx.ui.notify("No models are available to Pi; configure one first.", "warning"); return; }
      const budgetLabel = await ctx.ui.select("Thinking budget for p3stack roles", BUDGETS.map(budget => budget.label));
      const budget = BUDGETS.find(entry => entry.label === budgetLabel);
      if (!budget) { ctx.ui.notify("Setup cancelled; nothing written.", "info"); return; }
      const names = candidates(budget.name as Budget, models, catalog?.models);
      if (!names.length) { ctx.ui.notify(`No ${catalog ? "permitted " : ""}model offers thinking at or below ${budget.level}. Choose a larger budget${catalog ? " or permit more models in subagents.json" : ""}.`, "warning"); return; }
      const code = await ctx.ui.select("Model for code roles (feature, bug-fix, swarm workers, explorers)", names);
      const judgment = code && await ctx.ui.select("Model for judgment and prose roles (a different family suits review panels)", names);
      if (!code || !judgment) { ctx.ui.notify("Setup cancelled; nothing written.", "info"); return; }
      const roles = Object.fromEntries([
        ...CODE_ROLES.map(role => [role, code]), ...JUDGMENT_ROLES.map(role => [role, judgment]),
        ...PANEL_ROLES.map(role => [role, [judgment, code]]),
      ]);
      const path = join(agentDir(), "p3stack.json");
      if (existsSync(path) && !await ctx.ui.confirm("Replace the role defaults?", `${path} exists; setup rewrites it whole.`)) { ctx.ui.notify("Kept the existing file.", "info"); return; }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ budget: `${budget.name} (${budget.level})`, roles }, null, 2) + "\n");
      ctx.ui.notify(`Wrote ${path}: code roles on ${code}, judgment roles on ${judgment}.${catalog ? " Both are permitted by your subagents policy." : ""}`, "info");
    },
  });
}
