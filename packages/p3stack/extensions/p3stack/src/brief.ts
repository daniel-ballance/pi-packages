import type { Pi } from "./mode.ts";

const READER = "You are a read-only delegate in a poteto-mode run.";

export function registerBrief(pi: Pi, isOn: () => boolean, modeSkill: string, agentRecipe: string) {
  pi.on("tool_call", event => {
    if (!isOn() || !["subagent_spawn", "mcp__t3-code__delegate_task"].includes(event?.toolName)) return;
    const input = event.input as { task?: unknown; tools?: unknown; role?: unknown };
    if (typeof input?.task !== "string" || input.task.includes(agentRecipe) || input.task.startsWith(READER)) return;
    const tools = input.tools;
    const readOnly = event.toolName === "subagent_spawn"
      ? Array.isArray(tools) && !["edit", "write", "subagent_spawn"].some(tool => tools.includes(tool))
      : input.role === "research" || input.role === "review";
    input.task = readOnly
      ? `${READER} Answer only this brief. Do not read the poteto-mode skill, start a playbook, or delegate. Prove each claim with read-only commands where they settle it and cite file:line evidence. Report in the shape the brief asks, plainly and briefly. Your report is input to your parent's decision.\n\n${input.task}`
      : `Before any work, read ${agentRecipe} and follow it. The poteto-mode skill is at ${modeSkill}.\n\n${input.task}`;
  });
}
