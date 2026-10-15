import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";

// Render/schema tests need registration, not a running manager or scheduler.
export function nativeTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  let start: Function | undefined;
  asHost("cli", () => {
    subagents({
      registerFlag() {}, getFlag() { return false; },
      on(name: string, handler: Function) { if (name === "session_start" && !start) start = handler; },
      registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); },
      events: { on: () => () => {} },
    } as unknown as ExtensionAPI);
    start!({}, { mode: "print" } as ExtensionContext);
  });
  return tools;
}
