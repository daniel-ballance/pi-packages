import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";
import { tempRoot } from "./support/temp-root.js";

// Return the full native surface (including opt-in peer tools) without launching children.
export async function nativeTools(): Promise<ToolDefinition[]> {
  const dir = tempRoot("native-tools-"), previous = process.env.PI_CODING_AGENT_DIR;
  const tools: ToolDefinition[] = [], hooks = new Map<string, Function[]>();
  const ctx = { mode: "rpc", cwd: dir, isProjectTrusted: () => false, isIdle: () => true,
    modelRegistry: { getAvailable: () => [] }, sessionManager: { getEntries: () => [], getSessionId: () => "s" },
    ui: { setStatus() {}, notify() {} } };
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "subagents.json"), JSON.stringify({ version: 1, models: [], tools: ["peer_send"], peerMessageLimit: 1 }));
    asHost("cli", () => {
      subagents({
        registerFlag() {}, getFlag() { return false; },
        on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); },
        registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); },
        getAllTools: () => [], getCommands: () => [], events: { on: () => () => {} },
      } as unknown as ExtensionAPI);
      hooks.get("session_start")![0]({}, ctx);
    });
    return tools;
  } finally {
    for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
