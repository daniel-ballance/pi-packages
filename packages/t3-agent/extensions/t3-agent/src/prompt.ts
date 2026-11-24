// The `t3_agent` system prompt section. It states what the bridge's own guidance
// (`t3_code_orchestration`) leaves out: what the user sees, the permission mode in
// force, the checkout this thread owns, and the T3 objects this session holds open.
// Keep it short and stable: Pi re-sends only changed sections, but every change still
// costs a prompt patch.

import type { Workspace } from "./workspace.ts";
import { asksForBash, asksForEdits, type RuntimeMode } from "./runtime.ts";

export const SECTION = "t3_agent";

export interface PromptState {
  mode: RuntimeMode;
  workspace?: Workspace;
  /** Public T3 tool names in Pi’s active loadout, including bridge declarations. */
  declared: number;
  ledger?: string;
}

function permissionLine(mode: RuntimeMode): string {
  if (!asksForBash(mode)) return "- Permission mode: full access. No tool call asks the user.";
  const free = "`read`, `grep`, `find`, `ls`, `tool_search` and read-only T3 tools";
  return asksForEdits(mode)
    ? `- Permission mode: supervised. T3 asks the user before every bash call, file change, extension tool and non-read-only T3 tool. ${free} never ask: search and read with them, not bash, and combine the shell commands you need into as few bash calls as possible.`
    : `- Permission mode: auto-accept edits. Edit and write run without asking; T3 asks the user before every bash call, extension tool and non-read-only T3 tool. ${free} never ask: search and read with them, not bash, and combine the shell commands you need into as few bash calls as possible.`;
}

function workspaceLine(workspace: Workspace | undefined): string | undefined {
  if (!workspace) return undefined;
  const branch = workspace.branch ? `branch \`${workspace.branch}\`${workspace.upstream ? ` (upstream \`${workspace.upstream}\`)` : " (not pushed)"}` : "a detached HEAD";
  const base = workspace.defaultBranch ? `; default branch \`${workspace.defaultBranch}\`` : "";
  if (workspace.t3Managed) {
    return `- Workspace: \`${workspace.root}\`, ${branch}, a worktree T3 created for this thread from \`${workspace.mainCheckout ?? "the main checkout"}\`${base}. It is already an isolated checkout: it satisfies any instruction to work in a worktree. Commit here, not in the main checkout.`;
  }
  if (workspace.linked) {
    return `- Workspace: \`${workspace.root}\`, ${branch}, a linked git worktree of \`${workspace.mainCheckout ?? "the main checkout"}\`${base}.`;
  }
  return `- Workspace: \`${workspace.root}\`, ${branch}, the repository's main checkout${base}. Other T3 threads may share it: for isolated work, use \`delegate_task\` with \`isolation:"worktree"\`, or \`t3_worktree_handoff\` when the user asks to move this thread.`;
}

export function buildSection(state: PromptState): string {
  const lines = [
    "## Pi under T3 Code",
    "",
    "The user reads this thread in T3 Code, not a terminal.",
    "- T3 shows each bash call as a command card and each edit or write as a diff. Your last message is the reply: say what changed and why, cite paths, and do not repeat diffs or long command output.",
    "- T3 owns every turn. Finish what a turn starts before you reply: leave no background process, `sleep` loop or poll running. To act later, end the turn on a T3 wake: a delegate's completion, `watch_pull_request`, or `schedule_task`.",
    permissionLine(state.mode),
    workspaceLine(state.workspace),
    "- After you open a pull request, call `link_pull_request` so T3 tracks it with this thread, or `watch_pull_request` when you will handle its checks and reviews.",
    `- Declared T3 tools: ${state.declared} in Pi's active loadout. Use \`tool_search\` to discover available tools; the \`t3-code\` skill maps jobs to T3 tools.`,
    "- Pi has no native subagent tool here. Wherever T3's guidance says to use your native tool, use `delegate_task`: it is your subagent tool for every child, your own provider included. Pass `mode:\"wait\"` only when this turn needs the result; otherwise use `mode:\"async\"`, end the turn, and let completion wake you.",
  ].filter((line): line is string => line !== undefined);
  if (state.ledger) {
    lines.push("", "### Open T3 handles", "", "Last observed in this session’s T3 tool results. A listed tab is not proof of ownership.", "", state.ledger);
  }
  return lines.join("\n");
}
