import { doctor } from "./doctor.ts";
import type { ModelInfo } from "./roles.ts";

interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}
export interface Context {
  cwd: string;
  hasUI: boolean;
  mode?: string;
  ui: Ui;
  isProjectTrusted(): boolean;
  model?: { provider: string; id: string };
  getThinkingLevel(): string;
  executeTool(name: string, args: object): Promise<{ content: unknown; structuredContent?: unknown; isError?: boolean }>;
  modelRegistry: { getAvailable(): ModelInfo[] };
  sessionManager: { getBranch(): { type: string; customType?: string; data?: unknown }[] };
}
export interface Pi {
  registerTool(tool: object): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: Context) => Promise<void> }): void;
  on(event: string, handler: (event: any, ctx: Context) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  getAllTools(): { name: string; exposure?: string }[];
  events: { emit(channel: string, data: unknown): void };
}

const MODE = "p3stack";

export function registerMode(pi: Pi, modeSkill: string) {
  let modeOn = false;
  const showMode = (ctx: Context) => {
    if (ctx.mode === "tui") ctx.ui.setStatus(MODE, modeOn ? "p3stack on" : undefined);
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
    return { message: { customType: "p3stack-turn", display: false, content: `[poteto-mode is on] Before anything else, route this request. Read ${modeSkill} if you have not read it in this session, pick the matching playbook, read that playbook, put its steps in the todo list verbatim, and follow them. Before delegating, call \`p3stack_roles\` for the role models. Only a question about the mode itself skips this.` } };
  });
  pi.registerCommand("p3stack", {
    description: "Turn poteto-mode on or off, show status, or write the T3 contract report. /p3stack on | off | status | doctor",
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
      if (ctx.hasUI) ctx.ui.notify(want === "on" || want === "off" || want === "status" || !want ? `poteto-mode is ${modeOn ? "on" : "off"}.` : "Usage: /p3stack on | off | status | doctor", "info");
    },
  });
  return () => modeOn;
}
