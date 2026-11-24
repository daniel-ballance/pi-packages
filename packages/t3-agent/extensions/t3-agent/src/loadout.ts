// A loadout activates optional tools the bridge deferred: the
// tools T3's own guidance tells the model to call, plus tools that the session's
// open handles make relevant (a tab to close, a PR to unwatch).

import type { Loadout } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import { asksForBash, T3_PREFIX, type RuntimeMode } from "./runtime.ts";

/** Bare T3 tool names each loadout declares. `full` declares the whole catalog. */
export const LOADOUT_TOOLS: Record<Exclude<Loadout, "full">, readonly string[]> = {
  lean: [],
  standard: ["task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task"],
};

/** Pi's own read-only search tools. The bridge never confirms them, unlike bash. */
export const READ_ONLY_BUILTINS = ["grep", "find", "ls"] as const;

export interface ToolInfo {
  name: string;
  exposure?: string;
  sourceInfo?: { source?: string; path?: string };
}

/** The bridge owns direct declarations and requires even deferred tools on completion gateways. */
export function manageableTool(tool: ToolInfo, modelApi?: string): boolean {
  if (tool.name.startsWith(T3_PREFIX)) return tool.exposure === "deferred" && modelApi !== "openai-completions";
  return READ_ONLY_BUILTINS.some(name => tool.name === name && tool.sourceInfo?.path === `builtin:${name}`);
}

/** Bare names the open handles make worth declaring. */
export function contextualTools(ledger: Ledger): string[] {
  const tools: string[] = [];
  if (ledger.open("delegate").length > 0) tools.push("task_cancel");
  if (ledger.open("preview").length > 0) tools.push("t3_preview_close");
  if (ledger.open("pr").length > 0) tools.push("unwatch_pull_request");
  if (ledger.open("schedule").length > 0) tools.push("delete_scheduled_task");
  if (ledger.open("device").length > 0) tools.push("device_close", "device_screenshot");
  return tools;
}

export interface LoadoutInput {
  loadout: Loadout;
  extra: readonly string[];
  mode: RuntimeMode;
  ledger: Ledger;
  allTools: readonly ToolInfo[];
}

/** Every tool name this package wants declared, limited to tools that exist. */
export function desiredTools({ loadout, extra, mode, ledger, allTools }: LoadoutInput): string[] {
  const t3 = allTools.filter(tool => tool.name.startsWith(T3_PREFIX) && tool.exposure !== "hidden").map(tool => tool.name);
  const wanted = loadout === "full"
    ? t3
    : [...LOADOUT_TOOLS[loadout], ...extra, ...contextualTools(ledger)].map(name => T3_PREFIX + name).filter(name => t3.includes(name));
  // Under supervision bash asks the user each time; grep, find and ls never do.
  const builtins = asksForBash(mode)
    ? READ_ONLY_BUILTINS.filter(name => allTools.some(tool => tool.name === name && tool.sourceInfo?.path === `builtin:${name}`))
    : [];
  return [...new Set([...wanted, ...builtins])];
}

/**
 * The next active set. Tools this package activated earlier but no longer wants are
 * removed; tools the user or another extension activated are never touched.
 */
export function nextActive(active: readonly string[], desired: readonly string[], managed: ReadonlySet<string>): { active: string[]; managed: Set<string>; changed: boolean } {
  const keep = active.filter(name => !managed.has(name) || desired.includes(name));
  const add = desired.filter(name => !active.includes(name));
  const nextManaged = new Set([...[...managed].filter(name => desired.includes(name) && active.includes(name)), ...add]);
  return { active: [...keep, ...add], managed: nextManaged, changed: add.length > 0 || keep.length !== active.length };
}
