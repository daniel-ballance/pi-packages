// pistack's hand-written extension: the poteto-mode toggle, ask_user, the role
// table and its setup command. The skills it serves are generated; see AGENTS.md.
// Written against the subset of Pi's extension API it uses, so the package needs
// no Pi SDK of its own; the package-layout test loads it through Pi's real loader.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { installFooterPrefix, type Measure } from "./src/footer.ts";
import { detectHost, registerHostAware } from "./src/host.ts";
import { agentDir, BUDGETS, candidates, CODE_ROLES, JUDGMENT_ROLES, PANEL_ROLES, resolveRoles, type Budget, type ModelInfo } from "./src/roles.ts";

interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}
interface Context {
  cwd: string; hasUI: boolean; mode?: string; ui: Ui; isProjectTrusted(): boolean;
  modelRegistry: { getAvailable(): ModelInfo[] };
  sessionManager: { getBranch(): { type: string; customType?: string; data?: unknown }[] };
}
interface Pi {
  registerTool(tool: object): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: Context) => Promise<void> }): void;
  on(event: string, handler: (event: any, ctx: Context) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  getAllTools(): { name: string }[];
  events: { emit(channel: string, data: unknown): void };
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modeSkill = join(packageDir, "skills", "poteto-mode", "SKILL.md");
const agentRecipe = join(packageDir, "agents", "poteto-agent.md");
const MODE = "pistack-mode";
const TURN = "pistack-mode-turn";
/** Opens the short recipe for Children that only investigate. */
const READER = "You are a read-only delegate in a poteto-mode run.";
const OTHER = "Other (type an answer)";
// The subagents package replies synchronously on this channel; see its README.
const CATALOG_CHANNEL = "subagents:catalog";
const text = (body: string, structuredContent?: unknown) => ({ content: [{ type: "text", text: body }], details: structuredContent ?? {}, ...(structuredContent ? { structuredContent } : {}) });
const format = (value: string | string[]) => Array.isArray(value) ? value.join(", ") : value;
const POTATO = "🥔 ";

/** Marks the mode on Pi's own footer; undefined where Pi's modules don't load. */
async function potatoFooter(on: () => boolean): Promise<(() => void) | undefined> {
  try {
    // Pi provides both modules to extensions at runtime. Non-literal specifiers keep
    // this package type-checking without a Pi SDK of its own.
    const names = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
    const [agent, tui] = await Promise.all(names.map(name => import(name)));
    return installFooterPrefix(agent.FooterComponent.prototype, () => on() ? POTATO : "", tui as Measure);
  } catch { return undefined; }
}

/** The role defaults as the model should use them: one line per role, and where they came from. */
function roleTable(ctx: Context) {
  const resolved = resolveRoles(ctx.cwd, ctx.isProjectTrusted());
  const lines = Object.entries(resolved.roles).map(([role, { value }]) => `- ${role}: ${format(value)}`);
  const from = resolved.source === "default hints" ? "no role defaults file, so these are the skills' default hints" : resolved.source;
  return [`Role models (${from}). Resolve each per **Models and role defaults** in the host capabilities reference; pistack_roles returns the same table.`, ...resolved.problems.map(problem => `Problem: ${problem}`), ...lines].join("\n");
}

export default function pistack(pi: Pi) {
  let modeOn = false;
  let restoreFooter: (() => void) | undefined;

  // In the terminal a potato before the working directory shows the mode. The status
  // row is the fallback if the footer can't be decorated; T3 shows neither.
  const showMode = (ctx: Context) => {
    if (ctx.mode !== "tui") return;
    // Clearing a status is also how an extension gets Pi to redraw the footer.
    ctx.ui.setStatus("pistack", modeOn && !restoreFooter ? "poteto-mode" : undefined);
  };
  const rebuild = async (_event: unknown, ctx: Context) => {
    modeOn = false;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === MODE) modeOn = (entry.data as { on?: boolean } | undefined)?.on === true;
    if (ctx.mode === "tui") restoreFooter ??= await potatoFooter(() => modeOn);
    showMode(ctx);
  };
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);
  pi.on("session_shutdown", () => { restoreFooter?.(); restoreFooter = undefined; });

  // A named prompt section, so Pi records a delta rather than a new system prompt. It
  // carries the resolved role table, because skills say "use the role defaults" and a
  // model told to look them up does not. On its own the section is read as background:
  // in stress tests the model skipped it every time under T3 and in print mode. A
  // reminder beside each request, as in Pi's plan-mode example, made it route every time.
  pi.on("before_agent_start", (event, ctx) => {
    const sections = event?.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (sections) {
      if (modeOn) sections[MODE] = `poteto-mode is on for this session. Route every request through the poteto-mode skill at ${modeSkill}: read it if you have not read it in this session, pick the playbook that matches, and follow it. A question about the mode itself is outside it.\n\n${roleTable(ctx)}`;
      else delete sections[MODE];
    }
    if (!modeOn || event?.messageType !== "user") return;
    return { message: { customType: TURN, display: false, content: `[poteto-mode is on] Before anything else, route this request: read ${modeSkill} if you have not read it in this session, pick the matching playbook, read that playbook, put its steps in the todo list verbatim, and follow them. Delegate on the role models above. Only a question about the mode itself skips this.` } };
  });

  pi.registerCommand("pistack-mode", {
    description: "Turn poteto-mode on or off for this session: /pistack-mode on | off | status",
    handler: async (args, ctx) => {
      const want = args.trim();
      if (want === "on" || want === "off") {
        modeOn = want === "on";
        pi.appendEntry(MODE, { on: modeOn });
        showMode(ctx);
      }
      if (ctx.hasUI) ctx.ui.notify(want === "on" || want === "off" || want === "status" || !want ? `poteto-mode is ${modeOn ? "on" : "off"}.` : "Usage: /pistack-mode on | off | status", "info");
    },
  });

  // Every delegated brief starts with a recipe. A Child that can change files reads the
  // full mode skill, as upstream's poteto-agent does. A Child given neither edit, write
  // nor subagent_spawn only investigates: in stress tests such workers spent their first turns
  // reading the 20 KB skill and starting playbooks of their own, so they get a short
  // recipe instead. Only subagent_spawn says which tools a Child has; under T3 every
  // brief keeps the full recipe.
  pi.on("tool_call", event => {
    if (!modeOn || !["subagent_spawn", "mcp__t3-code__delegate_task"].includes(event?.toolName)) return;
    const input = event.input as { task?: unknown; tools?: unknown };
    if (typeof input?.task !== "string" || input.task.includes(agentRecipe) || input.task.startsWith(READER)) return;
    const readOnly = event.toolName === "subagent_spawn" && Array.isArray(input.tools) && !["edit", "write", "subagent_spawn"].some(tool => (input.tools as unknown[]).includes(tool));
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
    name: "pistack_roles", label: "pistack Roles",
    description: "The model each pistack role uses (role defaults file, else the skill's default hint). Resolve hints per the host capabilities reference.",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ source: Type.String(), budget: Type.Optional(Type.String()), roles: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])), problems: Type.Array(Type.String()) }),
    async execute(_call: string, _args: unknown, _signal: unknown, _update: unknown, ctx: Context) {
      const resolved = resolveRoles(ctx.cwd, ctx.isProjectTrusted());
      const lines = Object.entries(resolved.roles).map(([role, { value, fromFile }]) => `${role}: ${format(value)}${fromFile ? "" : " (default hint)"}`);
      const head = `Role defaults from ${resolved.source}${resolved.budget ? ` (budget ${resolved.budget})` : ""}.`;
      const roles = Object.fromEntries(Object.entries(resolved.roles).map(([role, { value }]) => [role, value]));
      return text([head, ...resolved.problems, ...lines].join("\n"), { source: resolved.source, ...(resolved.budget ? { budget: resolved.budget } : {}), roles, problems: resolved.problems });
    },
  }, { duplicatesT3: false });

  const readCatalog = () => {
    let catalog: { spawnEnabled: boolean; models: string[] } | undefined;
    pi.events.emit(CATALOG_CHANNEL, { reply: (value: typeof catalog) => { catalog = value; } });
    return catalog as typeof catalog;
  };

  pi.registerCommand("pistack-setup", {
    description: "Choose a thinking budget, a code model and a judgment model, and write ~/.pi/agent/pistack.json for every pistack role",
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
        if (!catalog.spawnEnabled) { ctx.ui.notify("Your subagents policy permits no usable model, so no role can run. Check subagent_catalog or /subagents diagnostics.", "warning"); return; }
      }
      const models = ctx.modelRegistry.getAvailable();
      if (!catalog && !models.length) { ctx.ui.notify("No models are available to Pi; configure one first.", "warning"); return; }
      const budgetLabel = await ctx.ui.select("Thinking budget for pistack roles", BUDGETS.map(budget => budget.label));
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
      const path = join(agentDir(), "pistack.json");
      if (existsSync(path) && !await ctx.ui.confirm("Replace the role defaults?", `${path} exists; setup rewrites it whole.`)) { ctx.ui.notify("Kept the existing file.", "info"); return; }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ budget: `${budget.name} (${budget.level})`, roles }, null, 2) + "\n");
      ctx.ui.notify(`Wrote ${path}: code roles on ${code}, judgment roles on ${judgment}.${catalog ? " Both are permitted by your subagents policy." : ""}`, "info");
    },
  });
}
