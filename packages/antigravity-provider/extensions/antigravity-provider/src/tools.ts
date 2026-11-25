import { fileURLToPath } from "node:url";
import { toToolDeclaration, type Tool } from "@earendil-works/pi-ai";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export const STAND_IN = "antigravity";
export const SOCKET_ENV = "PI_ANTIGRAVITY_BRIDGE";
export const SERVER_NAME = "pi";
export const AWAIT = "await_tool_result";
export const MCP_EXCLUSIONS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "web_search", "web_fetch", "codemode", "tool_search", STAND_IN, AWAIT,
]);
const AWAIT_TOOL: McpTool = { name: AWAIT,
  description: "Collect a Pi tool result after receiving a still-running notice. Use the id from that notice; repeat if it is still running.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};

export type ToolInfo = Tool & { exposure?: ToolExposure; annotations?: McpTool["annotations"] };
export function listTools(tools: readonly ToolInfo[], active: ReadonlySet<string>, standIn: boolean): McpTool[] {
  const listed = tools.filter(tool => !MCP_EXCLUSIONS.has(tool.name) && (
    (active.has(tool.name) && (tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "codemode" || tool.exposure === "deferred")) ||
    (standIn && (tool.exposure === "codemode" || tool.exposure === "deferred"))
  )).map(tool => {
    const declaration = toToolDeclaration(tool);
    return { name: declaration.name, description: declaration.description, annotations: tool.annotations,
      inputSchema: { ...declaration.parameters, type: "object" as const } };
  });
  return [...listed, AWAIT_TOOL];
}

export function bridgeServer(node: string, socket: string) {
  return { name: SERVER_NAME, command: node, args: [fileURLToPath(new URL("../shim.mjs", import.meta.url))],
    env: [{ name: SOCKET_ENV, value: socket }] };
}

export function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function stillRunning(id: string): CallToolResult {
  return { content: [{ type: "text", text: `The tool ${id} is still running in Pi. Do not repeat it. Call ${AWAIT} from the pi MCP server with ${JSON.stringify({ id })} to collect the result.` }] };
}
