// Role defaults: which model each pistack role uses. Skills name roles; this
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

/** The budget's level, or the closest level the model offers below it. */
export function thinkingFor(budget: Budget, model: ModelInfo): string {
  const target = LEVELS.indexOf(BUDGETS.find(entry => entry.name === budget)!.level);
  const offered = supportedLevels(model);
  return [...offered].reverse().find(level => LEVELS.indexOf(level) <= target) ?? offered[0]!;
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

/** A trusted project's .pi/pistack.json wins over the personal file; neither means the hints. */
export function resolveRoles(cwd: string, projectTrusted: boolean): Resolved {
  const candidates = [...projectTrusted ? [join(cwd, ".pi", "pistack.json")] : [], join(agentDir(), "pistack.json")];
  const roles = Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([role, value]) => [role, { value, fromFile: false }]));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch (error) { return { source: "default hints", roles, problems: [`ignored ${path}: ${(error as Error).message}`] }; }
    const problems = problemsIn(data);
    if (problems.length) return { source: "default hints", roles, problems: problems.map(problem => `ignored ${path}: ${problem}`) };
    const file = data as { budget?: string; roles?: Record<string, RoleValue> };
    for (const [role, value] of Object.entries(file.roles ?? {})) roles[role] = { value, fromFile: true };
    return { source: path, budget: file.budget, roles, problems: [] };
  }
  return { source: "default hints", roles, problems: [] };
}
