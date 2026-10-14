import { readFileSync } from "node:fs";
import { join } from "node:path";

/** File name under Pi's agent directory, beside `mcp.json` and `subagents.json`. */
export const CONFIG_FILE = "claude-subscription.json";

/** What the user may switch on or off. Every extra beyond the provider itself is a choice. */
export interface Config {
  /**
   * Plan-limit meter in the footer: `always` while a model of this provider is selected,
   * `attention` only when a limit is close or reached, `off` never.
   */
  status: "always" | "attention" | "off";
  /**
   * Offer `claude_web_search` and `claude_web_fetch`: Anthropic's web search and Claude
   * Code's page reader, run by Claude Code on the plan. They work with any Pi model.
   */
  webTools: boolean;
  /**
   * Offer the `claude_code` tool: a task handed to Claude Code, which works on it with its
   * own tools and loop. It works with any Pi model and uses the Claude plan.
   */
  claudeCode: boolean;
  /**
   * Have Claude Code keep each conversation on disk (under its own `projects` directory),
   * so that a restarted Pi continues it with the model's real history and prompt cache
   * instead of a replay as text. Off, nothing is written outside Pi's own session files.
   */
  resume: boolean;
}

export const DEFAULT_CONFIG: Config = { status: "always", webTools: false, claudeCode: false, resume: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one setting at a time, so a typo in one key costs that key and nothing else. */
export function parseConfig(value: unknown): { config: Config; problems: string[] } {
  const config = { ...DEFAULT_CONFIG };
  const problems: string[] = [];
  if (value === undefined) return { config, problems };
  if (!isRecord(value)) return { config, problems: ["the file must hold a JSON object"] };
  for (const [key, setting] of Object.entries(value)) {
    if (key === "status") {
      if (setting === "always" || setting === "attention" || setting === "off") config.status = setting;
      else problems.push('"status" must be "always", "attention" or "off"');
    } else if (key === "webTools" || key === "claudeCode" || key === "resume") {
      if (typeof setting === "boolean") config[key] = setting;
      else problems.push(`"${key}" must be true or false`);
    } else problems.push(`unknown setting "${key}"`);
  }
  return { config, problems };
}

/**
 * Settings from the user's agent directory. Only that directory is read: a project file
 * could otherwise switch on tools that act outside Pi's own permission gates.
 */
export function loadConfig(agentDir: string): { config: Config; problems: string[]; path: string } {
  const path = join(agentDir, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { config: { ...DEFAULT_CONFIG }, problems: [], path };
  }
  try {
    return { ...parseConfig(JSON.parse(text)), path };
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, problems: [error instanceof Error ? error.message : String(error)], path };
  }
}
