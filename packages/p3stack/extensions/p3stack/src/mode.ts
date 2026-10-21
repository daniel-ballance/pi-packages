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

export function registerMode(pi: Pi, potetoSkill: string) {
  const modeSkill = resolve(dirname(potetoSkill), "../p3stack-mode/SKILL.md");
  let modeOn = false;
  const showMode = (ctx: Context) => {
    if (ctx.hasUI && ctx.mode === "tui" && detectHost() === "cli") ctx.ui.setFooter(modeOn ? modeFooter(ctx) : undefined);
  };
  const rebuild = (_event: unknown, ctx: Context) => {
    modeOn = false;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === MODE) modeOn = (entry.data as { on?: boolean } | undefined)?.on === true;
    showMode(ctx);
  };
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);
  pi.on("before_agent_start", event => {
    const sections = event?.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (sections) {
      if (modeOn) sections[MODE] = `Read ${modeSkill} and follow it.`;
      else delete sections[MODE];
    }
    if (!modeOn || event?.messageType !== "user") return;
    return { message: { customType: "p3stack-turn", display: false, content: `[p3stack-mode is on] Before anything else, route this request. Read ${modeSkill} if you have not read it in this session, select its matching route, read that target, and follow it. Before delegating, call \`p3stack_roles\` for the role models. Only a question about the mode itself skips this.` } };
  });
  pi.registerCommand("p3stack", {
    description: "Turn p3stack-mode on or off, show status, or write the T3 contract report. /p3stack on | off | status | doctor",
    handler: async (args, ctx) => {
      const want = args.trim();
      if (want === "doctor") {
        const file = doctor(pi);
        if (ctx.hasUI) ctx.ui.notify(`Wrote ${file}`, "info");
        return;
      }
      if (want === "on" || want === "off") {
        modeOn = want === "on";
        pi.appendEntry(MODE, { on: modeOn });
        showMode(ctx);
      }
      if (ctx.hasUI) ctx.ui.notify(want === "on" || want === "off" || want === "status" || !want ? `p3stack is ${modeOn ? "on" : "off"}.` : "Usage: /p3stack on | off | status | doctor", "info");
    },
  });
  return () => modeOn;
}
