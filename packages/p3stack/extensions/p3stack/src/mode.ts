import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { doctor } from "./doctor.ts";
import { modeFooter } from "./footer.ts";
import { detectHost } from "./host.ts";

const MODE = "p3stack";
export type Grant = "default" | "autonomous";
const GRANTS: readonly Grant[] = ["default", "autonomous"];
/** The router's grant column names full autonomy `full-autonomy`. */
export const grantToken = (grant: Grant) => grant === "autonomous" ? "full-autonomy" : "default";
export function registerMode(pi: ExtensionAPI, potetoSkill: string) {
  const host = detectHost();
  const usage = `/p3stack on [default|autonomous] | grant <default|autonomous> | off | status${host === "t3" ? " | doctor" : ""}`;
  const modeSkill = resolve(dirname(potetoSkill), "../p3stack-mode/SKILL.md");
  let modeOn = false, grant: Grant = "default";
  let footer: ReturnType<typeof modeFooter> | undefined;
  const showMode = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (ctx.mode !== "tui" || host !== "cli") {
      ctx.ui.setStatus(MODE, modeOn ? `p3stack · ${grantToken(grant)}` : undefined);
    } else if (modeOn) {
      const next = modeFooter(ctx, pi.events, () => grant, () => { footer = undefined; });
      ctx.ui.setFooter(next.factory);
      footer = next;
    } else if (footer) {
      ctx.ui.setFooter(undefined);
      footer = undefined;
    }
  };
  const rebuild = (_event: unknown, ctx: ExtensionContext) => {
    modeOn = false;
    grant = "default";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== MODE) continue;
      const data = entry.data as { on?: boolean; grant?: unknown } | undefined;
      modeOn = data?.on === true;
      grant = GRANTS.includes(data?.grant as Grant) ? data!.grant as Grant : "default";
    }
    showMode(ctx);
  };
  const state = () => modeOn ? `p3stack is on (${grantToken(grant)} grant).` : "p3stack is off.";
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);
  if (host === "cli") {
    const refresh = () => footer?.refresh();
    pi.on("turn_end", refresh);
    pi.on("session_compact", refresh);
    pi.on("session_info_changed", refresh);
    pi.on("model_select", refresh);
    pi.on("thinking_level_select", refresh);
  }
  let userRequest = false;
  pi.on("context", ({ messages }) => {
    // Pi projects hidden custom messages as user messages. Keep our note beside its
    // own user request only, not a later steer, custom wake or resumed conversation.
    const user = modeOn && userRequest ? messages.findLastIndex(m => m.role === "user") : -1;
    const keep = messages.filter((m, i) => m.role !== "custom" || m.customType !== "p3stack-turn" || (user >= 0 && i > user));
    if (keep.length !== messages.length) return { messages: keep };
  });
  pi.on("before_agent_start", event => {
    userRequest = event.messageType === "user";
    footer?.refresh(true); // No settings-change event: refresh compaction settings at the next request.
    const options = event?.systemPromptOptions;
    if (!modeOn) {
      if (options?.sections) delete options.sections[MODE];
      return;
    }
    const line = `Read ${modeSkill} and follow it. Grant: ${grantToken(grant)}. Host: ${host === "cli" ? "terminal" : "t3"}.`;
    if (options?.forceSystemPrompt !== undefined) options.forceSystemPrompt += "\n\n" + line;
    else if (options?.sections) options.sections[MODE] = line;
    if (event?.messageType !== "user") return;
    return { message: { customType: "p3stack-turn", display: false, content: `Automated note from the p3stack extension, not from the user. p3stack-mode is on. Before anything else, route this request: read ${modeSkill} unless its text is already in your context, then follow the matching row within the user's requested scope and stopping point. If the user's message answers, approves or corrects the task already in progress, continue that task instead. A question about the mode itself needs no route. Call p3stack_roles before delegating.` } };
  });
  pi.registerCommand("p3stack", {
    description: `Control p3stack-mode and its grant. ${usage}`,
    handler: async (args, ctx) => {
      const [want = "", value, ...rest] = args.trim().split(/\s+/);
      if (want === "doctor" && value === undefined) {
        if (host !== "t3") {
          if (ctx.hasUI) ctx.ui.notify("This session was not launched by T3 Code.", "info");
          return;
        }
        const file = doctor(pi);
        if (ctx.hasUI) ctx.ui.notify(`Wrote ${file}`, "info");
        return;
      }
      if (want === "grant" && !modeOn) {
        if (ctx.hasUI) ctx.ui.notify("p3stack is off. Use /p3stack on default or /p3stack on autonomous to turn it on with a grant.", "info");
        return;
      }
      const requested = value as Grant | undefined;
      const valid = rest.length === 0 && (
        (want === "on" && (requested === undefined || GRANTS.includes(requested))) ||
        (want === "grant" && requested !== undefined && GRANTS.includes(requested)) ||
        ((want === "off" || want === "status" || !want) && requested === undefined));
      if (!valid) {
        if (ctx.hasUI) ctx.ui.notify(`Usage: ${usage}`, "info");
        return;
      }
      if (want === "on" || want === "off" || want === "grant") {
        if (want !== "grant") modeOn = want === "on";
        if (requested) grant = requested;
        pi.appendEntry(MODE, { on: modeOn, grant });
        showMode(ctx);
      }
      if (ctx.hasUI) ctx.ui.notify(state(), "info");
    },
  });
  return Object.assign(() => modeOn, { grant: () => grant });
}
