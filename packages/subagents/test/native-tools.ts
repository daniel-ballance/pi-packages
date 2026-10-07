import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";

// Render/schema tests need registration, not a running manager or scheduler.
export function nativeTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  let start: Function | undefined;
  subagents({
    registerFlag() {}, getFlag() { return false; },
    on(name: string, handler: Function) { if (name === "session_start" && !start) start = handler; },
    registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); },
  } as unknown as ExtensionAPI);
  start!({}, { mode: "print" } as ExtensionContext);
  return tools;
}
