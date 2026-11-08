import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { grantToken, type Grant, type Pi } from "./mode.ts";

const READER = "You are a read-only delegate in a poteto-mode run.";

const REVIEW_STANCE = "Judge the work against its contract (the spec, ticket, or brief), not against the author's summary: the author's conclusions are not evidence. Name the evidence for every finding (a command and its output, or file:line) and label each claim measured, inferred, or guess. A spec's silence is not permission for ordinary inputs to break the program.";

const BRIEF_CONTRACT = "Your brief should give the goal, the interfaces you use and produce, global constraints quoted verbatim, the review focus, a done predicate (command, expected output, and the surface to check), and where to write your report. If any is missing, state the assumption you made in your report. Do not spawn your own reviewer: your parent reviews your work.";

export function registerBrief(pi: Pi, isOn: (() => boolean) & { grant?: () => Grant }, modeSkill: string, agentRecipe: string) {
  const references = join(dirname(modeSkill), "..", "p3stack-mode", "references");
  const pointer = (file: string, what: string) => {
    const path = join(references, file);
    return existsSync(path) ? ` The full ${what} is at ${path}.` : "";
  };
  pi.on("tool_call", event => {
    if (!isOn() || !["subagent_spawn", "mcp__t3-code__delegate_task"].includes(event?.toolName)) return;
    const input = event.input as { task?: unknown; tools?: unknown; role?: unknown };
    if (typeof input?.task !== "string" || input.task.includes(agentRecipe) || input.task.startsWith(READER)) return;
    const tools = input.tools;
    const readOnly = event.toolName === "subagent_spawn"
      ? Array.isArray(tools) && !["edit", "write", "subagent_spawn"].some(tool => tools.includes(tool))
      : input.role === "research" || input.role === "review";
    const grant = `Grant: ${grantToken(isOn.grant?.() ?? "default")}.`;
    input.task = readOnly
      ? `${READER} Answer only this brief. Do not read the poteto-mode skill, start a playbook, or delegate. Prove each claim with read-only commands where they settle it and cite file:line evidence. ${REVIEW_STANCE}${pointer("review-stance.md", "review stance")} Report in the shape the brief asks, plainly and briefly. Your report is input to your parent's decision. ${grant}\n\n${input.task}`
      : `Before any work, read ${agentRecipe} and follow it. The poteto-mode skill is at ${modeSkill}. ${BRIEF_CONTRACT}${pointer("brief-contract.md", "brief contract")} ${grant}\n\n${input.task}`;
  });
}
