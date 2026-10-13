import { randomUUID } from "node:crypto";
import type {
  AccountInfo, EffortLevel, ModelInfo, Options, SDKControlGetContextUsageResponse, SDKControlInitializeResponse,
  SDKMessage, SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentQuery, QueryFunction } from "../../extensions/claude-subscription/src/sdk.js";

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** A queue with awaitable reads, for both directions of the scripted conversation. */
class Channel<T> {
  private readonly items: T[] = [];
  private readonly waiting: ((item: IteratorResult<T, void>) => void)[] = [];
  private ended = false;
  push(item: T): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }
  next(): Promise<IteratorResult<T, void>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiting.push(resolve));
  }
}

export type Script = (claude: FakeClaude) => Promise<void>;

/**
 * A scripted stand-in for the Claude Code process behind an Agent SDK query. It speaks the
 * same message shapes the real one was observed to emit, and calls Pi's tools through the
 * session's actual in-process MCP server, so the bridge under test is the real one.
 */
export class FakeClaude implements AgentQuery {
  readonly received: SDKUserMessage[] = [];
  readonly efforts: (EffortLevel | null | undefined)[] = [];
  readonly failures: unknown[] = [];
  account: AccountInfo = { subscriptionType: "Claude Max", email: "user@example.invalid", apiProvider: "firstParty" };
  models: ModelInfo[] = [];
  contextWindows: Record<string, number> = {};
  interrupts = 0;
  closed = false;
  private model: string | undefined;
  private readonly users = new Channel<SDKUserMessage>();
  private readonly out = new Channel<SDKMessage>();
  private readonly interruptions = new Channel<void>();
  private client: Promise<Client> | undefined;

  constructor(readonly options: Options, prompt: AsyncIterable<SDKUserMessage>, script?: Script) {
    this.model = options.model;
    void (async () => {
      for await (const message of prompt) {
        this.received.push(message);
        this.users.push(message);
      }
    })();
    script?.(this).catch(error => this.failures.push(error));
  }

  // --- AgentQuery ---

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return { commands: [], agents: [], output_style: "default", available_output_styles: [], models: this.models, account: this.account };
  }
  async interrupt(): Promise<unknown> {
    this.interrupts++;
    this.interruptions.push();
    return { still_queued: [] };
  }
  async applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void> {
    this.efforts.push(settings.effortLevel);
  }
  async setModel(model?: string): Promise<void> {
    this.model = model;
  }
  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return { rawMaxTokens: this.contextWindows[this.model ?? ""] ?? 200_000 } as SDKControlGetContextUsageResponse;
  }
  close(): void {
    this.closed = true;
    this.out.end();
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return { next: () => this.out.next() };
  }

  // --- Script side ---

  /** The next user turn Pi pushed. */
  async user(): Promise<SDKUserMessage> {
    const next = await this.users.next();
    if (next.done) throw new Error("input closed");
    return next.value;
  }
  /** Resolves when the host interrupts the running turn. */
  async interrupted(): Promise<void> {
    await this.interruptions.next();
  }
  emit(message: object): void {
    this.out.push({ uuid: randomUUID(), session_id: "session", ...message } as SDKMessage);
  }
  private event(event: object, uuids?: readonly (string | undefined)[]): void {
    this.emit({ type: "stream_event", event, parent_tool_use_id: null, ...(uuids ? { user_message_uuids: uuids } : {}) });
  }
  private open(id: string, usage: Usage, uuids?: readonly (string | undefined)[]): void {
    this.event({ type: "message_start", message: { id, model: this.options.model, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1, ...usage } } }, uuids);
  }
  private shut(stop_reason: string | null, usage: Usage): void {
    this.event({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 5, ...usage } });
    this.event({ type: "message_stop" });
  }
  /** One API message of text, optionally preceded by a thinking block. */
  text(id: string, text: string, options: { uuids?: readonly (string | undefined)[]; thinking?: string; stop?: string; usage?: Usage } = {}): void {
    this.open(id, options.usage ?? {}, options.uuids);
    let index = 0;
    if (options.thinking !== undefined) {
      this.event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      this.event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: options.thinking } });
      this.event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
      this.event({ type: "content_block_stop", index: index++ });
    }
    this.event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const part of text.match(/.{1,8}/gs) ?? []) this.event({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
    this.event({ type: "content_block_stop", index });
    this.shut(options.stop ?? "end_turn", options.usage ?? {});
  }
  /** Stream the opening of a text message and leave it unfinished. */
  partial(id: string, text: string): void {
    this.open(id, {});
    this.event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    this.event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  /** One API message that calls tools; arguments stream as split JSON. */
  toolUse(id: string, calls: readonly { id: string; name: string; input: object }[], uuids?: readonly (string | undefined)[]): void {
    this.open(id, {}, uuids);
    calls.forEach((call, index) => {
      this.event({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
      const json = JSON.stringify(call.input);
      const middle = Math.ceil(json.length / 2);
      for (const partial_json of [json.slice(0, middle), json.slice(middle)]) {
        this.event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
      }
      this.event({ type: "content_block_stop", index });
    });
    this.shut("tool_use", {});
  }
  result(uuids: readonly (string | undefined)[], extra: object = {}): void {
    this.emit({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, queued_turn_count: 0, user_message_uuids: uuids, ...extra });
  }
  /** A failed request, as Claude Code reports it: a synthetic assistant message, then an error result. */
  apiError(text: string, error = "invalid_request", uuids: readonly (string | undefined)[] = []): void {
    this.emit({ type: "assistant", error, parent_tool_use_id: null, message: { id: "synthetic", role: "assistant", content: [{ type: "text", text }] } });
    this.result(uuids, { is_error: true, result: text });
  }
  private mcp(): Promise<Client> {
    this.client ??= (async () => {
      const server = this.options.mcpServers?.pi;
      if (!server || !("instance" in server)) throw new Error("no in-process pi server");
      const [near, far] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(far);
      const client = new Client({ name: "fake-claude-code", version: "0.0.0" });
      await client.connect(near);
      return client;
    })();
    return this.client;
  }
  /** Tools as the model would be shown them. */
  async tools(): Promise<{ name: string; description?: string; inputSchema: object; _meta?: object }[]> {
    return (await (await this.mcp()).listTools()).tools;
  }
  /** Run a tool the way Claude Code does: an MCP call that names its tool_use block. */
  async call(toolUseId: string | undefined, name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    const result = await (await this.mcp()).callTool({
      name, arguments: input, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
    });
    return result as CallToolResult;
  }
}

/** A `query()` that hands out scripted processes in order and remembers each one. */
export function fakeQuery(...scripts: (Script | undefined)[]): { query: QueryFunction; spawned: FakeClaude[] } {
  const spawned: FakeClaude[] = [];
  const query: QueryFunction = ({ prompt, options }) => {
    const claude = new FakeClaude(options, prompt, scripts[spawned.length]);
    spawned.push(claude);
    return claude;
  };
  return { query, spawned };
}

export function textOf(message: SDKUserMessage): string {
  const { content } = message.message;
  return typeof content === "string" ? content : content.map(block => block.type === "text" ? block.text : `[${block.type}]`).join("\n");
}
