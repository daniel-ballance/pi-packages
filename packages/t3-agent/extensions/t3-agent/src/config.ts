import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOADOUTS = ["lean", "standard", "full"] as const;
export type Loadout = (typeof LOADOUTS)[number];

export interface Config {
  /** Which deferred T3 tools to declare to the model up front. */
  loadout: Loadout;
  /** Extra bare T3 tool names (`t3_worktree_status`) to declare beside the loadout. */
  tools: string[];
}

export const DEFAULT_CONFIG: Config = { loadout: "standard", tools: [] };
export const CONFIG_FILE = "t3-agent.json";

export const agentDir = (env: NodeJS.ProcessEnv = process.env) => env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** Apply one parsed file over `base`. Unknown keys and bad values are reported, not applied. */
export function mergeConfig(base: Config, value: unknown, source: string, problems: string[]): Config {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${source}: expected a JSON object`);
    return base;
  }
  const next = { ...base, tools: [...base.tools] };
  for (const [key, field] of Object.entries(value)) {
    if (key === "loadout" && LOADOUTS.includes(field as Loadout)) next.loadout = field as Loadout;
    else if (key === "tools" && Array.isArray(field)) {
      const names = field.filter((name): name is string => typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name));
      if (names.length !== field.length) problems.push(`${source}: ignored invalid tool name(s); use bare T3 tool names`);
      next.tools = [...new Set([...next.tools, ...names])];
    }
    else problems.push(`${source}: ignored ${JSON.stringify(key)}; see the t3-agent README for valid values`);
  }
  return next;
}

/** User file, then the project file when the project is trusted. */
export function readConfig(cwd: string, projectTrusted: boolean, env: NodeJS.ProcessEnv = process.env): { config: Config; problems: string[] } {
  const problems: string[] = [];
  let config = DEFAULT_CONFIG;
  const files = [join(agentDir(env), CONFIG_FILE), ...(projectTrusted ? [join(cwd, ".pi", CONFIG_FILE)] : [])];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      config = mergeConfig(config, JSON.parse(readFileSync(file, "utf8")), file, problems);
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { config, problems };
}
