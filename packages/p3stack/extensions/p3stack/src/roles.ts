// Role defaults: which model each p3stack role uses. Skills name roles; this
// resolves them from the role defaults file, or falls back to the default hints.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RoleValue = string | string[];
const CODE = "grok-4.7-xhigh-fast", JUDGMENT = "claude-opus-5-5-xhigh";
export const CODE_ROLES = ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb", "how explorer", "why investigators", "reflect tooling", "swarm workers"];
export const JUDGMENT_ROLES = ["judgment and prose", "hardest tasks", "how explainer", "why synthesizer", "reflect judgment, divergent, synthesizer"];
export const PANEL_ROLES = ["arena runners", "arena cross-judge pool", "architect runners", "interrogate reviewers"];
/** Upstream pstack's defaults, as model hints; see the host capabilities reference. */
export const DEFAULT_ROLES: Record<string, RoleValue> = Object.fromEntries([
  ...CODE_ROLES.map(role => [role, CODE]), ...JUDGMENT_ROLES.map(role => [role, JUDGMENT]), ...PANEL_ROLES.map(role => [role, [JUDGMENT, CODE]]),
]);

export const BUDGETS = [
  { label: "unlimited — max thinking", name: "unlimited", level: "max" },
  { label: "large — xhigh thinking", name: "large", level: "xhigh" },
  { label: "medium — high thinking", name: "medium", level: "high" },
  { label: "small — medium thinking", name: "small", level: "medium" },
] as const;
export type Budget = typeof BUDGETS[number]["name"];

export interface ModelInfo { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Pi's rule (pi-ai getSupportedThinkingLevels), restated so this extension needs no SDK import.
export function supportedLevels(model: ModelInfo): string[] {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

const budgetLevel = (budget: Budget) => LEVELS.indexOf(BUDGETS.find(entry => entry.name === budget)!.level);
const highestWithin = (budget: Budget, levels: string[]) =>
  [...levels].sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a)).find(level => LEVELS.includes(level) && LEVELS.indexOf(level) <= budgetLevel(budget));

/** The budget's level, or the closest level the model offers below it; none if every level exceeds the budget. */
export function thinkingFor(budget: Budget, model: ModelInfo): string | undefined {
  return highestWithin(budget, supportedLevels(model));
}

/**
 * The exact `provider/model:thinking` identities setup may offer within a budget, one per model.
 * With a subagents catalog only its identities count: a role naming anything else fails to spawn.
 */
export function candidates(budget: Budget, models: ModelInfo[], catalog?: string[]): string[] {
  if (!catalog) return models.flatMap(model => {
    const level = thinkingFor(budget, model);
    return level ? [`${model.provider}/${model.id}:${level}`] : [];
  });
  const levels = new Map<string, string[]>();
  for (const id of catalog) {
    const at = id.lastIndexOf(":");
    if (at <= 0) continue;
    levels.set(id.slice(0, at), [...levels.get(id.slice(0, at)) ?? [], id.slice(at + 1)]);
  }
  return [...levels].flatMap(([name, offered]) => {
    const level = highestWithin(budget, offered);
    return level ? [`${name}:${level}`] : [];
  });
}

export const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

export interface Resolved { source: string; budget?: string; roles: Record<string, { value: RoleValue; fromFile: boolean }>; problems: string[] }

function problemsIn(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["must be an object with budget and roles"];
  const { budget, roles, ...rest } = data as Record<string, unknown>;
  const problems = Object.keys(rest).map(key => `unknown field "${key}"`);
  if (budget !== undefined && typeof budget !== "string") problems.push("budget must be text");
  if (roles !== undefined && (!roles || typeof roles !== "object" || Array.isArray(roles))) return [...problems, "roles must be an object"];
  for (const [role, value] of Object.entries((roles ?? {}) as Record<string, unknown>)) {
    const valid = typeof value === "string" ? value.trim() !== "" : Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === "string" && entry.trim() !== "");
    if (!valid) problems.push(`role "${role}" must be a model or a list of models`);
  }
  return problems;
}

/** A trusted project's .pi/p3stack.json wins over the personal file; neither means the hints. */
export function resolveRoles(cwd: string, projectTrusted: boolean): Resolved {
  const project = join(cwd, ".pi", "p3stack.json");
  const skipped = !projectTrusted && existsSync(project) ? [`skipped ${project} because the project is untrusted`] : [];
  const candidates = [...projectTrusted ? [project] : [], join(agentDir(), "p3stack.json")];
  const roles = Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([role, value]) => [role, { value, fromFile: false }]));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch (error) { return { source: "default hints", roles, problems: [...skipped, `ignored ${path}: ${(error as Error).message}`] }; }
    const problems = problemsIn(data);
    if (problems.length) return { source: "default hints", roles, problems: [...skipped, ...problems.map(problem => `ignored ${path}: ${problem}`)] };
    const file = data as { budget?: string; roles?: Record<string, RoleValue> };
    for (const [role, value] of Object.entries(file.roles ?? {})) roles[role] = { value, fromFile: true };
    return { source: path, budget: file.budget, roles, problems: skipped };
  }
  return { source: "default hints", roles, problems: skipped };
}

export interface Target {
  providerInstanceId: string;
  model: string;
  options?: { id: string; value: string }[];
}
type Selection = { model: string; level?: string; value: string | Target };
export interface Catalog { spawnEnabled: boolean; models: string[] }
interface CatalogApi {
  getAllTools(): { name: string }[];
  events: { emit(channel: string, data: unknown): void };
}
interface RoleContext {
  cwd: string;
  isProjectTrusted(): boolean;
  modelRegistry: { getAvailable(): ModelInfo[] };
  model?: { provider: string; id: string };
  getThinkingLevel(): string;
  executeTool(name: string, args: object): Promise<{ content: unknown; structuredContent?: unknown; isError?: boolean }>;
}

export function readCatalog(pi: CatalogApi): Catalog | undefined {
  let catalog: Catalog | undefined;
  pi.events.emit("subagents:catalog", { reply: (value: Catalog) => { catalog = value; } });
  return catalog;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function t3Selections(data: unknown): Selection[] {
  return array(record(data).providers).flatMap(raw => {
    const provider = record(raw);
    if (provider.canRunChildTask !== true || typeof provider.providerInstanceId !== "string") return [];
    return array(provider.models).flatMap(raw => {
      const model = record(raw);
      if (typeof model.id !== "string") return [];
      const target: Target = { providerInstanceId: provider.providerInstanceId as string, model: model.id };
      const thinking = array(model.options).map(record).find(option => option.type === "select" && /thinking|reasoning|effort/i.test(String(option.id)));
      if (!thinking) return [{ model: model.id, value: target }];
      return array(thinking.options).flatMap(raw => {
        const choice = record(raw);
        return typeof choice.id === "string" && LEVELS.includes(choice.id)
          ? [{ model: model.id as string, level: choice.id, value: { ...target, options: [{ id: String(thinking.id), value: choice.id }] } }]
          : [];
      });
    });
  });
}

async function selections(pi: CatalogApi, ctx: RoleContext): Promise<Selection[]> {
  if (pi.getAllTools().some(tool => tool.name === "mcp__t3-code__orchestrator_capabilities")) {
    const result = await ctx.executeTool("mcp__t3-code__orchestrator_capabilities", {});
    if (result.isError) throw new Error("T3 catalog call failed");
    const content = array(result.content).map(record).filter(part => part.type === "text").map(part => part.text).join("\n");
    return t3Selections(result.structuredContent ?? JSON.parse(content));
  }
  const catalog = readCatalog(pi);
  if (!catalog && pi.getAllTools().some(tool => tool.name === "subagent_catalog")) throw new Error("subagents catalog did not reply");
  if (catalog && !catalog.spawnEnabled) throw new Error("subagents policy does not permit spawning");
  const identities = catalog?.models ?? ctx.modelRegistry.getAvailable().flatMap(model => supportedLevels(model).map(level => `${model.provider}/${model.id}:${level}`));
  return identities.flatMap(value => {
    const at = value.lastIndexOf(":");
    return at > 0 && LEVELS.includes(value.slice(at + 1)) ? [{ model: value.slice(0, at), level: value.slice(at + 1), value }] : [];
  });
}

function resolveHint(hint: string, catalog: Selection[], parent: string | undefined): Selection | undefined {
  if (hint === "auto" || hint === "inherit-parent") return catalog.find(entry => typeof entry.value === "string" && entry.value === parent);
  const wanted = hint;
  const match = /^(.*?)(?::|-)(off|minimal|low|medium|high|xhigh|max)(?:-fast)?$/.exec(wanted);
  const name = match?.[1] ?? wanted;
  const level = match?.[2];
  const matches = catalog.filter(entry => entry.model === name || ((!name.includes("/") || !entry.model.includes("/")) && entry.model.split("/").at(-1) === name.split("/").at(-1)));
  return matches.filter(entry => !level || entry.level === undefined || LEVELS.indexOf(entry.level) <= LEVELS.indexOf(level))
    .sort((a, b) => LEVELS.indexOf(b.level ?? "off") - LEVELS.indexOf(a.level ?? "off"))[0];
}

export async function liveRoles(pi: CatalogApi, ctx: RoleContext) {
  const defaults = resolveRoles(ctx.cwd, ctx.isProjectTrusted());
  const roles: Record<string, string | Target | (string | Target)[]> = {};
  const problems = [...defaults.problems];
  let catalog: Selection[];
  try { catalog = await selections(pi, ctx); }
  catch (error) { return { source: defaults.source, budget: defaults.budget, roles, problems: [...problems, `catalog unavailable, ${String(error)}`] }; }
  const parent = ctx.model ? `${ctx.model.provider}/${ctx.model.id}:${ctx.getThinkingLevel()}` : undefined;
  for (const [role, { value }] of Object.entries(defaults.roles)) {
    const resolved = (Array.isArray(value) ? value : [value]).map(hint => {
      const selection = resolveHint(hint, catalog, parent);
      if (!selection) problems.push(`${role} has no live catalog selection for ${hint}`);
      return selection?.value;
    });
    if (resolved.every(value => value !== undefined)) roles[role] = Array.isArray(value) ? resolved : resolved[0]!;
  }
  return { source: defaults.source, budget: defaults.budget, roles, problems };
}
