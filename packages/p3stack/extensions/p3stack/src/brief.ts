import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { detectHost } from "./host.ts";
import { grantToken, type Grant } from "./mode.ts";

const OPEN = "<p3stack-brief>", CLOSE = "</p3stack-brief>";
const REVIEW_STANCE = "Judge the work against its contract (the spec, ticket, or brief), not against the author's summary: the author's conclusions are not evidence. Name the evidence for every finding (a command and its output, or file:line) and label each claim measured, inferred, or guess. A spec's silence is not permission for ordinary inputs to break the program.";
const BRIEF_CONTRACT = "Your brief should give the goal, the interfaces you use and produce, global constraints quoted verbatim, the review focus, a done predicate (command, expected output, and the surface to check), and where to write your report. If any is missing, state the assumption you made in your report. Do not spawn your own reviewer: your parent reviews your work.";
const T3_STANCE = {
  report: "Act as a report-only delegate; answer only this brief without starting a playbook or delegating. Judge the work against its contract, not the author's summary; cite a command and its output or file:line for each claim and label it measured, inferred, or guess.",
  work: "Do the assigned unit and the procedures this brief assigns. Start no other playbook and no reviewer of your own. State the assumptions you made where the brief is silent and report evidence for each claim.",
};
const header = (authority: string, stance: string) => `${OPEN}${authority}\n${stance}\n${CLOSE}`;
const t3Header = (line: string, stance: string) => header("\n" + line, stance + " Pause at operator gates and before irreversible actions.");
// A grant line in any case, indented, or behind list, quote or emphasis marks, e.g. "  - **task grant:** full-autonomy".
const GRANT_LINE = String.raw`^[ \t>*_-]*(?:task[ \t]+)?grant[*_]*[ \t]*:`;
const anyGrantLine = new RegExp(GRANT_LINE, "im");
const grantLineFor = (value: string) => new RegExp(String.raw`${GRANT_LINE}[*_ \t]*${value}\b`, "im");
const tooLong = (excess: number) => ({ block: true, reason: `Shorten the task by ${excess} character${excess === 1 ? "" : "s"} to fit the full p3stack brief header.` });

function nativeBody(task: string) {
  const leading = task.trimStart();
  const end = leading.startsWith(OPEN) ? leading.indexOf(CLOSE, OPEN.length) : -1;
  return end < 0 ? task : leading.slice(end + CLOSE.length).replace(/^(?:\r?\n){1,2}/, "");
}

function nativeBrief(task: string, tools: unknown, authority: string, modeSkill: string, agentRecipe: string) {
  const references = join(dirname(modeSkill), "..", "p3stack-mode", "references");
  const reportOnly = Array.isArray(tools) && !["edit", "write", "subagent_spawn"].some(tool => tools.includes(tool));
  const stance = reportOnly
    ? `You are a report-only delegate in a poteto-mode run. Answer only this brief. Do not read the poteto-mode skill, start a playbook, or delegate. Prove each claim with non-mutating commands where they settle it and cite file:line evidence. ${REVIEW_STANCE} The full review stance is at ${join(references, "review-stance.md")}. Report in the shape the brief asks, plainly and briefly.`
    : `Before any work, read ${agentRecipe} and follow it. The poteto-mode skill is at ${modeSkill}. ${BRIEF_CONTRACT} The full brief contract is at ${join(references, "brief-contract.md")}.`;
  const brief = `${header(authority, stance)}\n\n${nativeBody(task)}`;
  return brief.length > 30_000 ? tooLong(brief.length - 30_000) : brief;
}

export function registerBrief(pi: ExtensionAPI, isOn: (() => boolean) & { grant(): Grant }, modeSkill: string, agentRecipe: string) {
  const authority = () => `Grant: ${grantToken(isOn.grant())}.`;
  if (detectHost() === "t3") {
    // Approval may run before this handler. Validate the parent's prepared text; never rewrite it.
    pi.on("tool_call", event => {
      if (!isOn() || event.toolName !== "mcp__t3-code__delegate_task") return;
      const { task, role } = event.input;
      if (typeof task !== "string") return;
      if (["approval-required", "auto", "auto-accept-edits"].includes(process.env.T3_PI_RUNTIME_MODE ?? "") &&
          Object.keys(event.input).at(-1) !== "task" && JSON.stringify(event.input, null, 2).length > 4000) {
        return { block: true, reason: "Put task last so the other arguments precede the brief in T3's 4,000-character approval preview." };
      }
      if (task.length > 120_000) return tooLong(task.length - 120_000);
      const kind = role === "research" || role === "review" ? "report" : "work";
      const override = /^<p3stack-brief>\n(Task grant: (?:default|full-autonomy))\n/.exec(task)?.[1];
      const prefix = t3Header(override ?? authority(), T3_STANCE[kind]) + "\n\n";
      if (!task.startsWith(prefix) || !task.slice(prefix.length).trim() || anyGrantLine.test(task.slice(prefix.length))) {
        return { block: true, reason: `Start task with p3stack_roles.briefHeaders.${kind}, a blank line, then the assignment. For a task-specific grant replace the header's Grant line with Task grant: default or Task grant: full-autonomy. Put the grant only in the header.` };
      }
    });
    return () => isOn() ? { work: t3Header(authority(), T3_STANCE.work), report: t3Header(authority(), T3_STANCE.report) } : undefined;
  }
  const prepare = (data: unknown) => {
    const req = data as { task: string; tools: string[]; parentTask?: string; error?: string };
    if (!isOn() || typeof req?.task !== "string") return;
    let line = authority();
    if (req.parentTask !== undefined) {
      // A coordinator passes its own brief's grant, not a broader grant at the root.
      const saved = /^<p3stack-brief>Grant: (default|full-autonomy)\./.exec(req.parentTask)?.[1];
      const body = nativeBody(req.parentTask);
      // Only a leading directive can raise the grant: examples and quoted work are not authority.
      const raised = body.trimStart().split("\n", 1)[0].trimEnd() === "Task grant: full-autonomy";
      // A lowering line counts wherever it sits; a raise line in the child's task is refused under a default grant.
      const inherited = !saved || grantLineFor("default").test(body) ? "default" : raised ? "full-autonomy" : saved;
      if (inherited === "default" && grantLineFor("full-autonomy").test(req.task)) {
        req.error = "A coordinator cannot raise its own grant for a child.";
        return;
      }
      line = `Grant: ${inherited}.`;
    }
    const brief = nativeBrief(req.task, req.tools, line, modeSkill, agentRecipe);
    if (typeof brief === "string") req.task = brief;
    else req.error = brief.reason;
  };
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", () => { unsubscribe ??= pi.events.on("subagents:prepare-brief", prepare); });
  pi.on("session_shutdown", () => { unsubscribe?.(); unsubscribe = undefined; });
  pi.on("tool_call", event => {
    if (!isOn() || event.toolName !== "subagent_spawn" || typeof event.input.task !== "string") return;
    const brief = nativeBrief(event.input.task, event.input.tools, authority(), modeSkill, agentRecipe);
    if (typeof brief !== "string") return brief;
    event.input.task = brief;
  });
}
