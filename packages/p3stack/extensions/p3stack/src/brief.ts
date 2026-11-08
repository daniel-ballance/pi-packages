import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { grantToken, type Grant, type Pi } from "./mode.ts";

const READER = "You are a read-only delegate in a poteto-mode run.";

/** Parts of the brief contract a parent can name in a brief, and how to recognize them. */
const CONTRACT_PARTS: [string, RegExp][] = [
  ["interfaces", /\b(?:interfaces?|signatures?|consumes|produces)\b/i],
  ["done predicate", /\b(?:done (?:when|predicate|condition)|expected output|acceptance|passes when|success criteria|verify (?:with|by))\b/i],
];
export const missingContractParts = (brief: string) => CONTRACT_PARTS.filter(([, pattern]) => !pattern.test(brief)).map(([name]) => name);

const REVIEW_STANCE = "Judge the work against its contract (the spec, ticket, or brief), not against the author's summary: the author's conclusions are not evidence. Name the evidence for every finding (a command and its output, or file:line) and label each claim measured, inferred, or guess. A spec's silence is not permission for ordinary inputs to break the program.";

const BRIEF_CONTRACT = "Your brief should give the goal, the interfaces you use and produce, global constraints quoted verbatim, the review focus, a done predicate (command, expected output, and the surface to check), and where to write your report. If any is missing, state the assumption you made in your report. Do not spawn your own reviewer: your parent reviews your work.";

export function registerBrief(pi: Pi, isOn: (() => boolean) & { grant?: () => Grant }, modeSkill: string, agentRecipe: string) {
  const references = join(dirname(modeSkill), "..", "p3stack-mode", "references");
  const pointer = (file: string, what: string) => {
    const path = join(references, file);
    return existsSync(path) ? ` The full ${what} is at ${path}.` : "";
  };
  const missing = new Map<string, string[]>();
  pi.on("tool_result", event => {
    const parts = missing.get(event?.toolCallId);
    if (!parts) return;
    missing.delete(event.toolCallId);
    const note = `p3stack: this brief named no ${parts.join(" and no ")}. The child was told to state its assumptions, so check them in its report, and write the next brief per the brief contract.${pointer("brief-contract.md", "brief contract")}`;
    return { content: [...(event.content ?? []), { type: "text", text: note }], structuredContent: event.structuredContent, details: event.details };
  });
  pi.on("tool_call", event => {
    if (!isOn() || !["subagent_spawn", "mcp__t3-code__delegate_task"].includes(event?.toolName)) return;
    const input = event.input as { task?: unknown; tools?: unknown; role?: unknown };
    if (typeof input?.task !== "string" || input.task.includes(agentRecipe) || input.task.startsWith(READER)) return;
    const tools = input.tools;
    const readOnly = event.toolName === "subagent_spawn"
      ? Array.isArray(tools) && !["edit", "write", "subagent_spawn"].some(tool => tools.includes(tool))
      : input.role === "research" || input.role === "review";
    const grant = `Grant: ${grantToken(isOn.grant?.() ?? "default")}.`;
    if (!readOnly && typeof event.toolCallId === "string") {
      const parts = missingContractParts(input.task);
      if (parts.length) missing.set(event.toolCallId, parts);
    }
    input.task = readOnly
      ? `${READER} Answer only this brief. Do not read the poteto-mode skill, start a playbook, or delegate. Prove each claim with read-only commands where they settle it and cite file:line evidence. ${REVIEW_STANCE}${pointer("review-stance.md", "review stance")} Report in the shape the brief asks, plainly and briefly. Your report is input to your parent's decision. ${grant}\n\n${input.task}`
      : `Before any work, read ${agentRecipe} and follow it. The poteto-mode skill is at ${modeSkill}. ${BRIEF_CONTRACT}${pointer("brief-contract.md", "brief contract")} ${grant}\n\n${input.task}`;
  });
}
