import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toToolDeclaration, type Tool } from "@earendil-works/pi-ai";
import { deferred, type Deferred } from "./sdk.js";

/** MCP server name; Claude Code exposes its tools to the model as `mcp__pi__<name>`. */
export const SERVER_NAME = "pi";
const PREFIX = `mcp__${SERVER_NAME}__`;
/** The API allows 64 characters in a tool name, and the model sees these with the prefix. */
const WIRE_LIMIT = 64 - PREFIX.length;
/** Request metadata Claude Code attaches so a call can be matched to its `tool_use` block. */
const TOOL_USE_ID = "claudecode/toolUseId";

/** How long a running session may take to read a changed tool list before the turn goes ahead. */
const RELIST_MS = 5_000;

interface Listed {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  _meta: Record<string, unknown>;
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * One MCP name per Pi tool. Claude Code rewrites characters outside this set, which would
 * break the way back to Pi's name, so they are replaced here. A name that is already valid
 * is kept; one that had to change, or that collides after changing, is told apart by a
 * digest of the original, so two Pi tools never share an MCP name.
 *
 * `assigned` carries the names a running session already uses: a tool keeps the name the
 * model has been calling it by, whatever joins the set later.
 */
export function wireNames(names: readonly string[], assigned: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const valid = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= WIRE_LIMIT;
  const wires = new Map<string, string>();
  for (const name of names) {
    const kept = assigned.get(name);
    if (kept) wires.set(name, kept);
  }
  const taken = new Set([...assigned.values(), ...names.filter(name => valid(name) && !assigned.has(name))]);
  for (const name of names) {
    if (wires.has(name)) continue;
    // Taken by this very name, unless an earlier tool was already given it.
    if (valid(name) && ![...assigned.values()].includes(name)) {
      wires.set(name, name);
      continue;
    }
    const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    let wire = clean.slice(0, WIRE_LIMIT);
    for (let salt = 0; taken.has(wire); salt++) {
      const mark = createHash("sha256").update(`${salt}:${name}`).digest("hex").slice(0, 8);
      wire = `${clean.slice(0, WIRE_LIMIT - mark.length - 1)}_${mark}`;
    }
    taken.add(wire);
    wires.set(name, wire);
  }
  return wires;
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
  private readonly instance: McpServer;
  private listed: Listed[] = [];
  /** Wire name -> Pi name for the current tools, and every Pi name -> wire name this session has used. */
  private names = new Map<string, string>();
  private readonly wires = new Map<string, string>();
  private readonly held = new Map<string, Deferred<CallToolResult>>();
  /** Settled when Claude Code next asks for the tool list. */
  private asked: Deferred<void> | undefined;

  /**
   * `known` names every tool Pi has registered, active or not. Claude Code takes the alias
   * map once, at start, so a tool activated later needs its alias from the beginning.
   */
  constructor(tools: readonly Tool[], known: readonly string[] = []) {
    this.list(tools);
    for (const [name, wire] of wireNames(known, this.wires)) this.wires.set(name, wire);
    for (const [name, wire] of this.wires) this.aliases[name] = `${PREFIX}${wire}`;
    const instance = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
    instance.server.registerCapabilities({ tools: { listChanged: true } });
    instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.asked?.resolve();
      return { tools: this.listed };
    });
    instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const id = extra._meta?.[TOOL_USE_ID];
      if (typeof id !== "string") {
        return failure("claude-subscription could not match this call to a tool_use block; the installed Claude Agent SDK is not the supported version.");
      }
      // A call for a tool no longer offered was never passed to Pi, so no result is coming.
      if (!this.names.has(request.params.name)) return failure(`The tool ${request.params.name} is not available now.`);
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
    this.instance = instance;
    this.config = { type: "sdk", name: SERVER_NAME, instance };
  }

  private list(tools: readonly Tool[]): void {
    for (const [name, wire] of wireNames(tools.map(tool => tool.name), this.wires)) this.wires.set(name, wire);
    this.names = new Map();
    this.listed = tools.map(tool => {
      const declaration = toToolDeclaration(tool);
      const wire = this.wires.get(tool.name) ?? tool.name;
      this.names.set(wire, tool.name);
      return {
        name: wire,
        description: declaration.description,
        inputSchema: { ...declaration.parameters, type: "object" as const },
        // Pi already chose this tool set; never hide part of it behind Claude Code's tool search.
        _meta: { "anthropic/alwaysLoad": true },
      };
    });
  }

  /**
   * Replace the tool set of a running session. Claude Code is told the list changed and
   * reads it again; this waits for that read, so the next turn is built with the new tools.
   * If it never reads it, the session still has the old tools and must not go on as if not.
   */
  async replace(tools: readonly Tool[]): Promise<void> {
    this.list(tools);
    const asked = this.asked = deferred<void>();
    let timer: NodeJS.Timeout | undefined;
    try {
      try {
        await this.instance.server.sendToolListChanged();
      } catch {
        // Not connected yet: Claude Code reads the list when it connects.
        return;
      }
      const read = await Promise.race([
        asked.promise.then(() => true),
        new Promise<boolean>(settle => { timer = setTimeout(() => settle(false), RELIST_MS); }),
      ]);
      if (!read) throw new Error("Claude Code did not take up the changed tool list.");
    } finally {
      clearTimeout(timer);
      if (this.asked === asked) this.asked = undefined;
    }
  }

  private hold(id: string): Deferred<CallToolResult> {
    let call = this.held.get(id);
    if (!call) {
      call = deferred<CallToolResult>();
      this.held.set(id, call);
    }
    return call;
  }

  /**
   * Pi's name for a tool the model called, or nothing when the call names no tool this
   * session offers now. With the prefix it is a wire name. Without it, it is Pi's own name,
   * which Claude Code resolves through the alias it was given at the start. Anything else
   * (a tool since removed, a name made up) Claude Code refuses itself, so Pi is not asked
   * to run it.
   */
  piName(called: string): string | undefined {
    if (called.startsWith(PREFIX)) return this.names.get(called.slice(PREFIX.length));
    return called in this.aliases && this.names.get(this.wires.get(called) ?? "") === called ? called : undefined;
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
