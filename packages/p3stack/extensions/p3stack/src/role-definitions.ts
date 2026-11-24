export type RoleValue = string | string[];
export const CODE_ROLES = ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb", "how explorer", "why investigators", "reflect tooling", "swarm workers"];
export const JUDGMENT_ROLES = ["judgment and prose", "hardest tasks", "how explainer", "why synthesizer", "reflect judgment, divergent, synthesizer"];
export const PANEL_ROLES = ["arena runners", "arena cross-judge pool", "architect runners", "interrogate reviewers"];

export function rolesFor(code: string, judgment: string): Record<string, RoleValue> {
  return Object.fromEntries([
    ...CODE_ROLES.map(role => [role, code]), ...JUDGMENT_ROLES.map(role => [role, judgment]), ...PANEL_ROLES.map(role => [role, [judgment, code]]),
  ]);
}

export const BUDGETS = [
  { label: "unlimited, max thinking", name: "unlimited", level: "max" },
  { label: "large, xhigh thinking", name: "large", level: "xhigh" },
  { label: "medium, high thinking", name: "medium", level: "high" },
  { label: "small, medium thinking", name: "small", level: "medium" },
] as const;
export type Budget = typeof BUDGETS[number]["name"];
