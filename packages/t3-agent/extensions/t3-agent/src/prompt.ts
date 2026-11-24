// The `t3_agent` system prompt section. It states what the bridge's own guidance
// (`t3_code_orchestration`) leaves out: what the user sees, the permission mode in
// force, the observed checkout, and the T3 objects this session holds open.
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
  if (!asksForBash(mode)) return "- Permission mode: full access. The bridge asks for no approval in this mode.";
  const policy = asksForEdits(mode)
    ? "supervised. The bridge asks for approval before bash, edits, writes and other non-exempt tool calls."
    : "auto-accept edits. The bridge accepts edit and write without approval; it asks before bash and other non-exempt calls.";
  return `- Permission mode: ${policy} Exempt from bridge approval: \`read\`, \`grep\`, \`find\`, \`ls\`, the built-in \`tool_search\` and the bridge's read-only T3 tools. Prefer these when available and batch shell commands.`;
}

function workspaceLine(workspace: Workspace | undefined): string | undefined {
  if (!workspace) return undefined;
  const branch = workspace.branch ? `branch \`${workspace.branch}\`${workspace.upstream ? ` (upstream \`${workspace.upstream}\`)` : " (no upstream configured)"}` : "a detached HEAD";
  const base = workspace.defaultBranch ? `; origin/HEAD points to \`${workspace.defaultBranch}\`` : "";
  if (workspace.t3Managed) {
    return `- Workspace: \`${workspace.root}\`, ${branch}, a linked Git worktree under T3's worktree directory${base}. Treat it as this thread's isolated worktree unless the user says otherwise.`;
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
    "- Do not leave an agent polling or sleeping after your reply. To act later, end the turn on a T3 wake: a delegate's completion, `watch_pull_request`, or `schedule_task`.",
    permissionLine(state.mode),
    workspaceLine(state.workspace),
    "- After you open a pull request, call `link_pull_request` so T3 tracks it with this thread, or `watch_pull_request` when you will handle its checks and reviews.",
    `- Declared T3 tools: ${state.declared} in Pi's active loadout. Use \`tool_search\` to discover available tools; the \`t3-code\` skill maps jobs to T3 tools.`,
    "- For T3 delegation, wherever the bridge says to use your native tool, use `delegate_task`: it is your subagent tool for every child, your own provider included. Pass `mode:\"wait\"` only when this turn needs the result; otherwise use `mode:\"async\"`, end the turn, and let completion wake you.",
  ].filter((line): line is string => line !== undefined);
  if (state.ledger) {
    lines.push("", "### Open T3 handles", "", "Last observed in this session’s T3 tool results. A listed tab is not proof of ownership.", "", state.ledger);
  }
  return lines.join("\n");
}
