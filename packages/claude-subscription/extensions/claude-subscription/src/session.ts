import { randomUUID } from "node:crypto";
import type { AccountInfo, EffortLevel, Options, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import type { Thinking } from "./models.js";
import { Response } from "./response.js";
import { Inbox, type AgentQuery, type QueryFunction } from "./sdk.js";
import { SERVER_NAME, ToolBridge } from "./tools.js";
import { assistantKey, inputBlocks, seedBlocks, toolResult, type Entry, type Transcript, type UserBlock } from "./transcript.js";

/** What a session needs from its surroundings; the provider supplies it, tests script it. */
export interface SessionHost {
  query: QueryFunction;
  env: Record<string, string | undefined>;
  cwd: string;
  onAccount?(account: AccountInfo): void;
  onRateLimit?(info: SDKRateLimitInfo): void;
}

/** How long an interrupted turn may take to wind down before the session is discarded. */
const INTERRUPT_GRACE_MS = 5_000;

const SIGN_IN = "Run `claude auth login`, sign in with your Claude account, then try again.";

function describe(account: AccountInfo): string {
  if (account.apiProvider && account.apiProvider !== "firstParty") return ` (it is using ${account.apiProvider})`;
  if (account.apiKeySource && account.apiKeySource !== "none") return ` (it is using an API key from ${account.apiKeySource})`;
  return "";
}

function isBlocks(value: unknown): value is UserBlock[] {
  return Array.isArray(value) && value.every((block: unknown) =>
    typeof block === "object" && block !== null && "type" in block && (block.type === "text" || block.type === "image"));
}

type State = "idle" | "streaming" | "awaiting-tools" | "closed";

/**
 * One Claude Code session held open for one Pi conversation.
 *
 * Pi stays the harness: it owns the transcript, the tools and the loop. This class keeps
 * a streaming Agent SDK query alive between Pi's requests so a turn that calls tools can
 * pause on them, take Pi's results and carry on with its native history and prompt cache.
 * `keys` records which transcript entries the session has absorbed; a request continues
 * the session only when its transcript extends that record.
 */
export class AgentSession {
  readonly hasTools: boolean;
  lastUsed = Date.now();
  private state: State = "idle";
  private readonly keys: string[] = [];
  /** Tool calls the model made that Pi has not answered yet. */
  private readonly owed = new Set<string>();
  /** User turns handed to Claude Code that no model turn has taken up yet. */
  private readonly unconsumed = new Set<string>();
  private readonly inbox = new Inbox();
  private readonly bridge: ToolBridge;
  private readonly query: AgentQuery;
  private readonly messages: AsyncIterator<SDKMessage>;
  private readonly ready: Promise<void>;
  private readonly modelId: string;
  private readonly leadingKey: string;
  private readonly toolsKey: string;
  private readonly thinkingKey: string;
  private effort: EffortLevel | undefined;
  private stderr = "";

  constructor(private readonly host: SessionHost, model: Model<Api>, transcript: Transcript, thinking: Thinking) {
    this.modelId = model.id;
    this.leadingKey = transcript.leadingKey;
    this.toolsKey = transcript.toolsKey;
    this.thinkingKey = JSON.stringify(thinking.thinking);
    this.effort = thinking.effort;
    this.hasTools = transcript.tools.length > 0;
    this.bridge = new ToolBridge(transcript.tools);
    const options: Options = {
      model: model.id,
      cwd: host.cwd,
      env: host.env,
      // The transcript's system prompt replaces Claude Code's; Pi's tools are the only tools.
      systemPrompt: transcript.systemPrompt,
      tools: [],
      mcpServers: this.hasTools ? { [SERVER_NAME]: this.bridge.config } : {},
      strictMcpConfig: true,
      // Pi gates its own tools. Nothing else is offered, and anything else would be denied.
      allowedTools: this.bridge.allowedTools,
      toolAliases: this.bridge.aliases,
      permissionMode: "default",
      permissionPrompts: "none",
      // No user or project Claude Code configuration: hooks, memory files and MCP servers stay out.
      settingSources: [],
      // Pi compacts its own transcript; a second compaction here would hide history from it.
      settings: { autoCompactEnabled: false },
      persistSession: false,
      // A given title spares the model call that would otherwise name the session.
      title: "Pi",
      // Deliver Pi's text as written, without slash-command or @file handling.
      verbatimPrompts: true,
      includePartialMessages: true,
      thinking: thinking.thinking,
      effort: thinking.effort,
      stderr: data => {
        this.stderr = (this.stderr + data).slice(-2_000);
      },
    };
    this.query = host.query({ prompt: this.inbox, options });
    this.messages = this.query[Symbol.asyncIterator]();
    this.ready = this.verify();
    this.ready.catch(() => {});
  }

  /** The login is Claude Code's own; refuse anything that is not a subscription. */
  private async verify(): Promise<void> {
    const { account } = await this.query.initializationResult();
    this.host.onAccount?.(account);
    if (!account.subscriptionType) {
      throw new Error(`Claude Code is not signed in with a Claude subscription${describe(account)}. ${SIGN_IN}`);
    }
  }

  get closed(): boolean {
    return this.state === "closed";
  }

  get busy(): boolean {
    return this.state === "streaming";
  }

  /**
   * The entries this session has not seen, when the transcript continues the conversation
   * it holds: same model, prompt and tools, its record as a prefix, and new input it can take.
   */
  continues(model: Model<Api>, transcript: Transcript, thinking: Thinking): Entry[] | undefined {
    if (this.state !== "idle" && this.state !== "awaiting-tools") return undefined;
    if (model.id !== this.modelId || transcript.leadingKey !== this.leadingKey || transcript.toolsKey !== this.toolsKey) return undefined;
    if (JSON.stringify(thinking.thinking) !== this.thinkingKey) return undefined;
    const { entries } = transcript;
    if (entries.length <= this.keys.length || this.keys.some((key, index) => entries[index].key !== key)) return undefined;
    const fresh = entries.slice(this.keys.length);
    let answered = false;
    let asked = false;
    for (const entry of fresh) {
      if (entry.kind === "assistant") return undefined;
      if (entry.kind === "toolResult") {
        if (!this.owed.has(entry.message.toolCallId)) return undefined;
        answered = true;
      } else if (entry.kind === "user") asked = true;
    }
    return answered || asked ? fresh : undefined;
  }

  /** Stream the next assistant message for `fresh`; `seed` marks a session with no history yet. */
  respond(model: Model<Api>, fresh: readonly Entry[], seed: boolean, thinking: Thinking, options?: StreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    this.lastUsed = Date.now();
    void this.run(model, fresh, seed, thinking, options, stream);
    return stream;
  }

  private async run(
    model: Model<Api>, fresh: readonly Entry[], seed: boolean, thinking: Thinking,
    options: StreamOptions | undefined, stream: AssistantMessageEventStream,
  ): Promise<void> {
    const response = new Response(model, stream, wire => this.bridge.piName(wire));
    const { output } = response;
    const signal = options?.signal;
    const before = this.state;
    this.state = "streaming";
    let delivered = false;
    let interrupted = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const interrupt = (): void => {
      interrupted = true;
      this.query.interrupt().catch(() => {});
      grace = setTimeout(() => this.close(), INTERRUPT_GRACE_MS);
    };
    try {
      if (signal?.aborted) throw new Error("Request was aborted");
      const results = new Map<string, CallToolResult>();
      for (const entry of seed ? [] : fresh) {
        if (entry.kind === "toolResult") results.set(entry.message.toolCallId, toolResult(entry.message));
      }
      let input = seed ? seedBlocks(fresh) : inputBlocks(fresh);
      // There is no HTTP payload to show; this is what the session is about to be given.
      // A replacement may change the user input, the one part still open at this point.
      const replaced = await options?.onPayload?.({
        model: model.id,
        session: seed ? "new" : "continued",
        thinking: thinking.thinking,
        effort: thinking.effort,
        toolResults: Object.fromEntries(results),
        input,
      }, model);
      if (typeof replaced === "object" && replaced !== null && "input" in replaced && isBlocks(replaced.input)) {
        input = replaced.input;
      }
      await this.ready;
      if (thinking.effort !== this.effort) {
        await this.query.applyFlagSettings({ effortLevel: thinking.effort ?? null });
        this.effort = thinking.effort;
      }
      if (signal?.aborted) throw new Error("Request was aborted");
      signal?.addEventListener("abort", interrupt, { once: true });

      delivered = true;
      for (const entry of fresh) this.keys.push(entry.key);
      // Input goes in before the tool results that unblock the turn, so Claude Code
      // folds it into the same turn instead of running it as a second one.
      if (input.length) {
        const uuid = randomUUID();
        this.unconsumed.add(uuid);
        this.inbox.push({ type: "user", message: { role: "user", content: input }, parent_tool_use_id: null, uuid });
      }
      for (const id of this.owed) {
        this.bridge.resolve(id, results.get(id) ?? { content: [{ type: "text", text: "No result provided" }], isError: true });
      }
      this.owed.clear();

      let failure: string | undefined;
      for (;;) {
        const next = await this.messages.next();
        if (next.done) throw new Error(`Claude Code exited before the turn finished.${this.stderr ? ` ${this.stderr.trim()}` : ""}`);
        const message = next.value;
        await options?.onProviderStreamEvent?.(message, model);
        if ("user_message_uuids" in message) for (const uuid of message.user_message_uuids ?? []) this.unconsumed.delete(uuid);
        if (message.type === "rate_limit_event") {
          this.host.onRateLimit?.(message.rate_limit_info);
        } else if (message.type === "stream_event") {
          if (message.parent_tool_use_id !== null) continue;
          if (response.apply(message.event) && response.rawStopReason === "tool_use" && response.calledTools.length && !interrupted) {
            for (const id of response.calledTools) this.owed.add(id);
            output.stopReason = "toolUse";
            this.keys.push(assistantKey(output));
            this.state = "awaiting-tools";
            stream.push({ type: "done", reason: "toolUse", message: output });
            return;
          }
        } else if (message.type === "assistant") {
          // Claude Code reports a failed request as a synthetic message; its text is the error.
          if (message.error && message.parent_tool_use_id === null) {
            failure = message.message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
              || `Claude request failed: ${message.error}`;
            if (message.error === "authentication_failed") failure += ` ${SIGN_IN}`;
          }
        } else if (message.type === "result") {
          if (interrupted) {
            settled = true;
            throw new Error("Request was aborted");
          }
          if (message.is_error || message.subtype !== "success") {
            throw new Error(failure || (message.subtype === "success" ? message.result : message.errors.join("; "))
              || "Claude Code reported an error");
          }
          // A turn queued behind this one still has output to deliver.
          if (this.unconsumed.size > 0 || (message.queued_turn_count ?? 0) > 0) continue;
          if (response.rawStopReason === "refusal") throw new Error("The model refused to complete the request");
          response.start();
          output.stopReason = response.rawStopReason === "max_tokens" ? "length" : "stop";
          this.keys.push(assistantKey(output));
          this.bridge.release("The turn ended before this tool ran.");
          this.state = "idle";
          stream.push({ type: "done", reason: output.stopReason, message: output });
          return;
        }
      }
    } catch (error) {
      const aborted = interrupted || signal?.aborted === true;
      output.stopReason = aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      if (aborted && !delivered && !seed && !this.closed) {
        // Nothing reached Claude Code: the session is exactly where it was.
        this.state = before;
      } else if (settled && this.unconsumed.size === 0 && !this.closed) {
        // An interrupted turn that wound down leaves a usable session behind.
        this.owed.clear();
        this.bridge.release("Interrupted before a result was available.");
        this.state = "idle";
      } else {
        this.close();
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      clearTimeout(grace);
      signal?.removeEventListener("abort", interrupt);
      this.lastUsed = Date.now();
      stream.end();
    }
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.inbox.end();
    this.bridge.release("The session was closed.");
    this.query.close();
  }
}
