import { dirname, join } from "node:path";
import { detectHost, type Host } from "./host.ts";
import { grantToken, type Grant, type Pi } from "./mode.ts";

const OPEN = "<p3stack-brief>", CLOSE = "</p3stack-brief>";
// subagent_spawn's task schema and T3's OrchestratorMcpPrompt, respectively.
const LIMIT = { cli: 30_000, t3: 120_000 };

const REVIEW_STANCE = "Judge the work against its contract (the spec, ticket, or brief), not against the author's summary: the author's conclusions are not evidence. Name the evidence for every finding (a command and its output, or file:line) and label each claim measured, inferred, or guess. A spec's silence is not permission for ordinary inputs to break the program.";
const BRIEF_CONTRACT = "Your brief should give the goal, the interfaces you use and produce, global constraints quoted verbatim, the review focus, a done predicate (command, expected output, and the surface to check), and where to write your report. If any is missing, state the assumption you made in your report. Do not spawn your own reviewer: your parent reviews your work.";

function withBriefHeader(input: { task: string; tools?: unknown; role?: unknown }, host: Host, grant: Grant, modeSkill: string, agentRecipe: string) {
  const leading = input.task.trimStart();
  const end = leading.startsWith(OPEN) ? leading.indexOf(CLOSE, OPEN.length) : -1;
  const body = end < 0 ? input.task : leading.slice(end + CLOSE.length).replace(/^(?:\r?\n){1,2}/, "");
  let stance: string;
  if (host === "t3") {
    stance = input.role === "review" || input.role === "research"
      ? "Act as a report-only delegate; answer only this brief without starting a playbook or delegating. Judge the work against its contract, not the author's summary; cite a command and its output or file:line for each claim and label it measured, inferred, or guess."
      : "Do the assigned unit and the procedures this brief assigns. Start no other playbook and no reviewer of your own. State the assumptions you made where the brief is silent and report evidence for each claim.";
  } else {
    const references = join(dirname(modeSkill), "..", "p3stack-mode", "references");
    const tools = input.tools;
    const reportOnly = Array.isArray(tools) && !["edit", "write", "subagent_spawn"].some(tool => tools.includes(tool));
    stance = reportOnly
      ? `You are a report-only delegate in a poteto-mode run. Answer only this brief. Do not read the poteto-mode skill, start a playbook, or delegate. Prove each claim with non-mutating commands where they settle it and cite file:line evidence. ${REVIEW_STANCE} The full review stance is at ${join(references, "review-stance.md")}. Report in the shape the brief asks, plainly and briefly.`
      : `Before any work, read ${agentRecipe} and follow it. The poteto-mode skill is at ${modeSkill}. ${BRIEF_CONTRACT} The full brief contract is at ${join(references, "brief-contract.md")}.`;
  }
  const taskGrant = host === "t3" ? ' A "Task grant:" line in the brief sets the grant for this task.' : "";
  const header = `${OPEN}Grant: ${grantToken(grant)}.${taskGrant}\n${stance}\n${CLOSE}\n\n`;
  const excess = header.length + body.length - LIMIT[host];
  if (excess > 0) return { block: true, reason: `Shorten the task by ${excess} character${excess === 1 ? "" : "s"} to fit the full p3stack brief header.` };
  return header + body;
}

export function registerBrief(pi: Pi, isOn: (() => boolean) & { grant(): Grant }, modeSkill: string, agentRecipe: string) {
  const host = detectHost();
  const tool = host === "cli" ? "subagent_spawn" : "mcp__t3-code__delegate_task";
  pi.on("tool_call", event => {
    if (!isOn() || event?.toolName !== tool || typeof event.input?.task !== "string") return;
    const brief = withBriefHeader(event.input, host, isOn.grant(), modeSkill, agentRecipe);
    if (typeof brief !== "string") return brief;
    event.input.task = brief;
  });
}
