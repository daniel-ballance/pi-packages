import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { doctor } from "./doctor.ts";
import { modeFooter } from "./footer.ts";
import { detectHost } from "./host.ts";

interface Ui {
  select: ExtensionUIContext["select"];
  input: ExtensionUIContext["input"];
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setFooter: ExtensionUIContext["setFooter"];
  setStatus: ExtensionUIContext["setStatus"];
}
export interface Context {
  cwd: string;
  hasUI: boolean;
  mode?: string;
  ui: Ui;
  isProjectTrusted(): boolean;
  model?: ExtensionContext["model"];
  thinkingLevel?: ExtensionContext["thinkingLevel"];
  getContextUsage: ExtensionContext["getContextUsage"];
  executeTool(name: string, args: unknown): Promise<{
    toolCall: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
    result: { content: unknown; details: unknown; structuredContent?: unknown; isError?: boolean };
    isError: boolean;
  }>;
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable" | "isUsingOAuth" | "getProvider" | "find">;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getEntries" | "getSessionName">;
}
export interface Pi {
  getThinkingLevel(): string;
  registerTool(tool: object): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: Context) => Promise<void> }): void;
  on(event: string, handler: (event: any, ctx: Context) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  getAllTools(): { name: string; exposure?: string }[];
  getCommands(): { source: string; sourceInfo: { path: string } }[];
  events: { emit(channel: string, data: unknown): void };
}

const MODE = "p3stack";
export type Grant = "default" | "autonomous";
const GRANTS: readonly Grant[] = ["default", "autonomous"];
/** The router's grant column names full autonomy `full-autonomy`. */
export const grantToken = (grant: Grant) => grant === "autonomous" ? "full-autonomy" : "default";
export function registerMode(pi: Pi, potetoSkill: string) {
  const host = detectHost();
  const usage = `/p3stack on [default|autonomous] | grant <default|autonomous> | off | status${host === "t3" ? " | doctor" : ""}`;
  const modeSkill = resolve(dirname(potetoSkill), "../p3stack-mode/SKILL.md");
  let modeOn = false, grant: Grant = "default";
  let footer: ReturnType<typeof modeFooter> | undefined;
  const showMode = (ctx: Context) => {
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
  const rebuild = (_event: unknown, ctx: Context) => {
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
    for (const event of ["turn_end", "session_compact", "session_info_changed", "model_select", "thinking_level_select"]) {
      pi.on(event, () => footer?.refresh());
    }
  }
  pi.on("before_agent_start", event => {
    footer?.refresh(true); // No settings-change event: refresh compaction settings at the next request.
    const sections = event?.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (sections) {
      if (modeOn) sections[MODE] = `Read ${modeSkill} and follow it. Grant: ${grantToken(grant)}. Host: ${host === "cli" ? "terminal" : "t3"}.`;
      else delete sections[MODE];
    }
    if (!modeOn || event?.messageType !== "user") return;
    return { message: { customType: "p3stack-turn", display: false, content: `Automated note from the p3stack extension, not the user. For this request only: read ${modeSkill}, then read and follow its matching target. Skip routing for mode questions. Use p3stack_roles before delegating.` } };
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
