import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { detectHost } from "./host.ts";
import type { Context, Pi } from "./mode.ts";

export type RoleValue = string | string[];
const CODE = "grok-4.7-xhigh-fast", JUDGMENT = "claude-opus-5-5-xhigh";
export const CODE_ROLES = ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb", "how explorer", "why investigators", "reflect tooling", "swarm workers"];
export const JUDGMENT_ROLES = ["judgment and prose", "hardest tasks", "how explainer", "why synthesizer", "reflect judgment, divergent, synthesizer"];
export const PANEL_ROLES = ["arena runners", "arena cross-judge pool", "architect runners", "interrogate reviewers"];
export const DEFAULT_ROLES: Record<string, RoleValue> = Object.fromEntries([
  ...CODE_ROLES.map(role => [role, CODE]), ...JUDGMENT_ROLES.map(role => [role, JUDGMENT]), ...PANEL_ROLES.map(role => [role, [JUDGMENT, CODE]]),
]);

export const BUDGETS = [
  { label: "unlimited, max thinking", name: "unlimited", level: "max" },
  { label: "large, xhigh thinking", name: "large", level: "xhigh" },
  { label: "medium, high thinking", name: "medium", level: "high" },
  { label: "small, medium thinking", name: "small", level: "medium" },
] as const;
export type Budget = typeof BUDGETS[number]["name"];

export interface ModelInfo { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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

export function thinkingFor(budget: Budget, model: ModelInfo): string | undefined {
  return highestWithin(budget, supportedLevels(model));
}

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

export const agentDir = getAgentDir;

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

export function resolveRoles(cwd: string, projectTrusted: boolean): Resolved {
  const project = join(cwd, ".pi", "p3stack.json");
  const skipped = !projectTrusted && existsSync(project) ? [`skipped ${project} because the project is untrusted`] : [];
  const candidates = [...projectTrusted ? [project] : [], join(agentDir(), "p3stack.json")];
  const roles = Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([role, value]) => [role, { value, fromFile: false }]));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { skipped.push(`ignored ${path}: ${(error as Error).message}`); continue; }
    const problems = problemsIn(data);
    if (problems.length) { skipped.push(...problems.map(problem => `ignored ${path}: ${problem}`)); continue; }
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
type Selection = { provider: string; model: string; level?: string; option?: string };
interface LiveCatalog { choices: Selection[]; instances?: Set<string>; inherited?: Selection }
const nameOf = (s: Selection) => `${s.provider}/${s.model}`;
const identity = (s: Selection) => nameOf(s) + (s.level ? `:${s.level}` : "");
const rank = (level?: string) => LEVELS.indexOf(level ?? "");

function asTarget(s: Selection): Target {
  return { providerInstanceId: s.provider, model: s.model, ...s.option && s.level && { options: [{ id: s.option, value: s.level }] } };
}
export interface Catalog { spawnEnabled: boolean; models: string[] }
interface CatalogApi {
  getThinkingLevel(): string;
  getAllTools(): { name: string }[];
  events: { emit(channel: string, data: unknown): void };
}
interface RoleContext {
  cwd: string;
  isProjectTrusted(): boolean;
  modelRegistry: { getAvailable(): ModelInfo[] };
  model?: { provider: string; id: string };
  executeTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): ReturnType<Context["executeTool"]>;
}

export function readCatalog(pi: CatalogApi): Catalog | undefined {
  let catalog: Catalog | undefined;
  pi.events.emit("subagents:catalog", { reply: (value: Catalog) => { catalog = value; } });
  return catalog;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function t3Selections(data: unknown): LiveCatalog {
  const catalog = record(data);
  if (!Array.isArray(catalog.providers)) throw new Error("no providers in capabilities response");
  const instances = new Set<string>();
  const choices: Selection[] = [];
  let inherited: Selection | undefined;
  for (const provider of catalog.providers.map(record)) {
    if (typeof provider.providerInstanceId !== "string") continue;
    instances.add(provider.providerInstanceId);
    if (provider.canRunChildTask !== true) continue;
    for (const model of array(provider.models).map(record)) {
      if (typeof model.id !== "string") continue;
      const base = { provider: provider.providerInstanceId, model: model.id };
      if (base.provider === catalog.inheritedProviderInstanceId && base.model === catalog.inheritedModel) inherited = base;
      const thinking = array(model.options).map(record).find(o => typeof o.id === "string" && /thinking|reasoning|effort/i.test(o.id));
      const values = thinking?.values ?? array(thinking?.options).map(choice => record(choice).id);
      const levels = array(values).filter((v): v is string => typeof v === "string" && LEVELS.includes(v));
      if (!levels.length) choices.push(base); // usable without an explicit thinking request only
      for (const level of levels) choices.push({ ...base, level, option: String(thinking!.id) });
    }
  }
  return { choices, instances, inherited };
}

const CAPABILITIES = "mcp__t3-code__orchestrator_capabilities";

async function selections(pi: CatalogApi, ctx: RoleContext, signal?: AbortSignal): Promise<LiveCatalog> {
  if (detectHost() === "t3") {
    const { result, isError } = await ctx.executeTool(CAPABILITIES, {}, { signal });
    const payload = record(result.structuredContent);
    if (isError || result.isError || payload.isError) throw new Error("capabilities call failed");
    const content = array(payload.content ?? result.content).map(record).filter(part => part.type === "text").map(part => part.text).join("\n");
    const data = Array.isArray(payload.providers) ? payload : payload.structuredContent ?? JSON.parse(content);
    return t3Selections(data);
  }
  const catalog = readCatalog(pi);
  if (!catalog && pi.getAllTools().some(tool => tool.name === "subagent_catalog")) throw new Error("subagents catalog did not reply");
  if (catalog && !catalog.spawnEnabled) throw new Error("subagents policy does not permit spawning");
  const identities = catalog?.models ?? ctx.modelRegistry.getAvailable().flatMap(model => supportedLevels(model).map(level => `${model.provider}/${model.id}:${level}`));
  const choices = identities.flatMap(value => {
    const at = value.lastIndexOf(":"), slash = value.indexOf("/");
    return slash > 0 && at > slash + 1 && LEVELS.includes(value.slice(at + 1))
      ? [{ provider: value.slice(0, slash), model: value.slice(slash + 1, at), level: value.slice(at + 1) }] : [];
  });
  return { choices };
}

const hintParts = (hint: string) => {
  const match = /^(.*?)(?::|-)(off|minimal|low|medium|high|xhigh|max)(?:-fast)?$/.exec(hint);
  return { name: match?.[1] ?? hint, level: match?.[2] };
};

const KNOWN_FAMILY = /claude|grok|composer|gpt|gemini|deepseek|llama|mistral|qwen|kimi|glm|minimax/i;
function modelFamily(id: string): string {
  const known = id.match(KNOWN_FAMILY)?.[0].toLowerCase();
  return known === "composer" ? "grok" : known ?? id;
}

export function family(model: string): string {
  const { name } = hintParts(model);
  return modelFamily(name.slice(name.indexOf("/") + 1));
}

const independent = (a: string, b: string) => a !== b && KNOWN_FAMILY.test(a) && KNOWN_FAMILY.test(b);
const prefer = (choices: Selection[], test: (s: Selection) => boolean) => {
  const matches = choices.filter(test);
  return matches.length ? matches : choices;
};

function scopedChoices(name: string, catalog: LiveCatalog): Selection[] {
  const slash = name.indexOf("/");
  if (!catalog.instances || slash < 0) return catalog.choices;
  const prefix = name.slice(0, slash);
  if (catalog.instances.has(prefix)) return catalog.choices.filter(s => s.provider === prefix);
  // A foreign Pi identity must match the model namespace on a single instance.
  // Never strip an unknown instance and redirect its pin to a bare model id.
  const foreign = catalog.choices.filter(s => s.model.startsWith(prefix + "/") && modelFamily(s.model) === family(name));
  const matches = prefer(foreign, s => s.model === name);
  return new Set(matches.map(s => s.provider)).size === 1 ? matches : [];
}

function choose(hint: string, fromFile: boolean, catalog: LiveCatalog, author?: string, panelFamilies?: string[], fallbackAuthor?: string) {
  const { name, level } = hintParts(hint), wantedFamily = family(hint);
  function match(s: Selection): number {
    if (nameOf(s) === name) return 3; // exact (instance, whole model id) wins
    if (s.model === name || (!name.includes("/") && s.model.split("/").at(-1) === name)) return 2;
    return modelFamily(s.model) === wantedFamily ? 1 : 0;
  }
  let choices = scopedChoices(name, catalog).filter(s => !level || (s.level && rank(s.level) <= rank(level)));
  const avoid = author ?? (!fromFile && !choices.some(match) ? fallbackAuthor : undefined);
  if (fromFile) choices = choices.filter(match);
  else {
    if (avoid) choices = prefer(choices, s => independent(modelFamily(s.model), avoid));
    if (panelFamilies) choices = prefer(choices, s => KNOWN_FAMILY.test(s.model) && panelFamilies.every(f => independent(modelFamily(s.model), f)));
  }
  const found = choices.sort((a, b) => match(b) - match(a) || rank(b.level) - rank(a.level))[0];
  const substituted = found && (match(found) < (fromFile ? 3 : 2) || (level && level !== found.level));
  return { found, substituted, avoid };
}

export async function liveRoles(pi: CatalogApi, ctx: RoleContext, distinctFrom?: string, signal?: AbortSignal) {
  const defaults = resolveRoles(ctx.cwd, ctx.isProjectTrusted());
  const roles: Record<string, string | Target | null | (string | Target | null)[]> = {};
  const problems = [...defaults.problems];
  let catalog: LiveCatalog;
  try { catalog = await selections(pi, ctx, signal); }
  catch (error) {
    const source = detectHost() === "t3" ? "T3 catalog" : "catalog";
    problems.push(`${source} unavailable (${(error as Error).message}). Blocked roles: ${Object.keys(defaults.roles).join("; ")}.`);
    return { source: defaults.source, budget: defaults.budget, roles, problems };
  }
  const parent = catalog.instances ? catalog.inherited : catalog.choices.find(s =>
    s.provider === ctx.model?.provider && s.model === ctx.model.id && s.level === pi.getThinkingLevel());
  const author = distinctFrom ? family(distinctFrom) : undefined;
  const parentId = catalog.inherited?.model ?? ctx.model?.id;
  const notes = new Map<string, Set<string>>();
  const note = (role: string, message: string) => {
    if (!notes.has(message)) notes.set(message, new Set());
    notes.get(message)!.add(role);
  };
  for (const [role, { value, fromFile }] of Object.entries(defaults.roles)) {
    const seats: (string | Target | null)[] = [], used: string[] = [];
    const reviewing = JUDGMENT_ROLES.includes(role) || PANEL_ROLES.includes(role);
    const fallbackAuthor = reviewing && parentId ? modelFamily(parentId) : undefined;
    for (const hint of Array.isArray(value) ? value : [value]) {
      const inherit = hint === "auto" || hint === "inherit-parent";
      const { found, substituted, avoid } = inherit ? { found: parent, substituted: false, avoid: author }
        : choose(hint, fromFile, catalog, author, Array.isArray(value) ? used : undefined, fallbackAuthor);
      if (!found) {
        note(role, `no live catalog selection for ${hint} in the returned list at the requested level or below. Check the role default or allowlist.`);
        continue;
      }
      const f = modelFamily(found.model);
      if (substituted) {
        const why = avoid && family(hint) === avoid && independent(f, avoid) ? ` to differ from ${distinctFrom ?? avoid}` : "";
        note(role, `substituted ${identity(found)} for ${hint}${why}`);
      }
      if (avoid && !independent(f, avoid)) {
        if (!KNOWN_FAMILY.test(avoid) || !KNOWN_FAMILY.test(f)) note(role, `unknown family: cannot verify independence of ${identity(found)} from ${distinctFrom ?? avoid}`);
        else note(role, fromFile ? `pin ${hint} stays in the author's ${avoid} family` : `no model outside the ${avoid} family is offered at this level or below`);
      }
      seats.push(catalog.instances ? (inherit ? null : asTarget(found)) : identity(found));
      used.push(f);
    }
    if (Array.isArray(value) && value.length > 1 && (used.length < value.length || used.some((f, i) => !KNOWN_FAMILY.test(f) || used.indexOf(f) !== i))) {
      note(role, "cannot give every panel seat a distinct family within the available selections and role defaults");
    }
    if (seats.length) roles[role] = Array.isArray(value) ? seats : seats[0];
  }
  for (const [message, affected] of notes) problems.push(`${[...affected].join("; ")}: ${message}`);
  return { source: defaults.source, budget: defaults.budget, roles, problems };
}

const targetSchema = Type.Object({ providerInstanceId: Type.String(), model: Type.String(), options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), value: Type.String() }))) });
const selectionSchema = Type.Union([Type.String(), targetSchema, Type.Null()]);

export function registerRoles(pi: Pi) {
  pi.registerTool({
    name: "p3stack_roles", label: "p3stack roles",
    description: "Resolve every p3stack role against the live catalog. Return exact provider/model:thinking identities or ready T3 targets (null means omit target to inherit), and report unavailable roles. Pass distinctFrom with the author's model to get reviewers from another model family.",
    promptSnippet: "p3stack_roles resolves role models against the live delegation catalog.",
    parameters: Type.Object({ distinctFrom: Type.Optional(Type.String({ description: "The author's model or model family. Reviewers, judges, and adversaries pass it so each role resolves to a different family when the catalog offers one." })) }, { additionalProperties: false }),
    reachesTools: () => detectHost() === "t3" ? [CAPABILITIES] : [],
    outputSchema: Type.Object({ source: Type.String(), budget: Type.Optional(Type.String()), roles: Type.Record(Type.String(), Type.Union([selectionSchema, Type.Array(selectionSchema)])), problems: Type.Array(Type.String()) }),
    async execute(_call: string, args: { distinctFrom?: string } | undefined, signal: AbortSignal | undefined, _update: unknown, ctx: Context) {
      const resolved = await liveRoles(pi, ctx, args?.distinctFrom?.trim() || undefined, signal);
      const lines = Object.entries(resolved.roles).map(([role, value]) => `${role}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      const head = `Role defaults from ${resolved.source}${resolved.budget ? ` (budget ${resolved.budget})` : ""}.`;
      return { content: [{ type: "text", text: [head, ...resolved.problems, ...lines].join("\n") }], details: resolved, structuredContent: resolved };
    },
  });
}
