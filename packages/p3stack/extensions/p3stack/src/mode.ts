import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { doctor } from "./doctor.ts";
import { modeFooter } from "./footer.ts";
import { detectHost } from "./host.ts";

interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setFooter: ExtensionUIContext["setFooter"];
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
const USAGE = "Usage: /p3stack on [default|autonomous] | grant <default|autonomous> | off | status | doctor";

export function registerMode(pi: Pi, potetoSkill: string) {
  const modeSkill = resolve(dirname(potetoSkill), "../p3stack-mode/SKILL.md");
  let modeOn = false, grant: Grant = "default";
  const showMode = (ctx: Context) => {
    if (ctx.hasUI && ctx.mode === "tui" && detectHost() === "cli") ctx.ui.setFooter(modeOn ? modeFooter(ctx, pi.events, () => grant) : undefined);
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
  pi.on("before_agent_start", event => {
    const sections = event?.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (sections) {
      if (modeOn) sections[MODE] = `Read ${modeSkill} and follow it. Grant: ${grantToken(grant)}.`;
      else delete sections[MODE];
    }
    if (!modeOn || event?.messageType !== "user") return;
    return { message: { customType: "p3stack-turn", display: false, content: `[p3stack-mode is on, grant: ${grantToken(grant)}] Before anything else, route this request. Read ${modeSkill} if you have not read it in this session, select its matching route, read that target, and follow it. Before delegating, call \`p3stack_roles\` for the role models. Only a question about the mode itself skips this.` } };
  });
  pi.registerCommand("p3stack", {
    description: "Turn p3stack-mode on or off, set its grant, show status, or write the T3 contract report. /p3stack on [default|autonomous] | grant <default|autonomous> | off | status | doctor",
    handler: async (args, ctx) => {
      const [want = "", value, ...rest] = args.trim().split(/\s+/);
      if (want === "doctor") {
        const file = doctor(pi);
        if (ctx.hasUI) ctx.ui.notify(`Wrote ${file}`, "info");
        return;
      }
      const requested = value as Grant | undefined;
      const valid = rest.length === 0 && (
        (want === "on" && (requested === undefined || GRANTS.includes(requested))) ||
        (want === "grant" && requested !== undefined && GRANTS.includes(requested)) ||
        ((want === "off" || want === "status" || !want) && requested === undefined));
      if (!valid) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "info");
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
