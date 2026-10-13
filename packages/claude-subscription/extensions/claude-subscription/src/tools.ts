import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toToolDeclaration, type Tool } from "@earendil-works/pi-ai";
import { deferred, type Deferred } from "./sdk.js";

/** MCP server name; Claude Code exposes its tools to the model as `mcp__pi__<name>`. */
export const SERVER_NAME = "pi";
const PREFIX = `mcp__${SERVER_NAME}__`;
/** Request metadata Claude Code attaches so a call can be matched to its `tool_use` block. */
const TOOL_USE_ID = "claudecode/toolUseId";

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Presents Pi's tools to Claude Code as an in-process MCP server without running them.
 * Each call is held open until Pi, which owns tool execution, hands back the result
 * for that `tool_use` id. The two sides may arrive in either order.
 */
export class ToolBridge {
  readonly config: McpSdkServerConfigWithInstance;
  /** Permission rule and model-facing aliases for the options of the owning session. */
  readonly allowedTools = [`mcp__${SERVER_NAME}`];
  readonly aliases: Record<string, string> = {};
  private readonly names = new Map<string, string>();
  private readonly held = new Map<string, Deferred<CallToolResult>>();

  constructor(tools: readonly Tool[]) {
    const listed = tools.map(tool => {
      const declaration = toToolDeclaration(tool);
      // Claude Code rewrites other characters, which would break the way back to Pi's name.
      const wire = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      this.names.set(wire, tool.name);
      this.aliases[tool.name] = `${PREFIX}${wire}`;
      return {
        name: wire,
        description: declaration.description,
        inputSchema: { ...declaration.parameters, type: "object" as const },
        // Pi already chose this tool set; never hide part of it behind Claude Code's tool search.
        _meta: { "anthropic/alwaysLoad": true },
      };
    });
    const instance = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
    instance.server.registerCapabilities({ tools: {} });
    instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
    instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const id = extra._meta?.[TOOL_USE_ID];
      if (typeof id !== "string") {
        return failure("claude-subscription could not match this call to a tool_use block; the installed Claude Agent SDK is not the supported version.");
      }
      const call = this.hold(id);
      const interrupted = (): void => call.resolve(failure("Interrupted before a result was available."));
      extra.signal.addEventListener("abort", interrupted, { once: true });
      try {
        return await call.promise;
      } finally {
        extra.signal.removeEventListener("abort", interrupted);
        this.held.delete(id);
      }
    });
    this.config = { type: "sdk", name: SERVER_NAME, instance };
  }

  private hold(id: string): Deferred<CallToolResult> {
    let call = this.held.get(id);
    if (!call) {
      call = deferred<CallToolResult>();
      this.held.set(id, call);
    }
    return call;
  }

  /** Pi's name for a tool the model called, whether it used the MCP name or Pi's own. */
  piName(wire: string): string {
    const bare = wire.startsWith(PREFIX) ? wire.slice(PREFIX.length) : wire;
    return this.names.get(bare) ?? bare;
  }

  resolve(toolUseId: string, result: CallToolResult): void {
    this.hold(toolUseId).resolve(result);
  }

  /** Release every waiting call and forget results nobody asked for. */
  release(reason: string): void {
    for (const call of this.held.values()) call.resolve(failure(reason));
    this.held.clear();
  }
}
