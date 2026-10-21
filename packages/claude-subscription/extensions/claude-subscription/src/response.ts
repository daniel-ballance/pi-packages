import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  calculateCost,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";

type StreamEvent = SDKPartialAssistantMessage["event"];

/**
 * Builds one Pi assistant message from the Anthropic stream events Claude Code relays.
 * A Pi response usually spans a single API message; when Claude Code continues a turn
 * itself, the following messages append to the same response.
 */
export class Response {
  readonly output: AssistantMessage;
  /** Stop reason of the most recent API message, as Anthropic reported it. */
  rawStopReason: string | undefined;
  private started = false;
  /** API block index -> index in `output.content`, for the API message being streamed. */
  private readonly open = new Map<number, number>();
  private readonly json = new Map<number, string>();
  private toolCalls: string[] = [];
  private earlierOutput = 0;
  private earlierReasoning = 0;
  private latestOutput = 0;

  constructor(
    private readonly model: Model<Api>,
    private readonly stream: AssistantMessageEventStream,
    /** Pi's name for a tool the model called, or nothing for a call Pi is not to be given. */
    private readonly piName: (called: string) => string | undefined,
  ) {
    this.output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  /** Ids of the tool calls in the API message that just ended. */
  get calledTools(): readonly string[] {
    return this.toolCalls;
  }

  /** `start` precedes every other event of a successful stream. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  /** Apply one stream event; true when it completes an API message. */
  apply(event: StreamEvent): boolean {
    const { output, stream } = this;
    if (event.type === "message_start") {
      this.start();
      this.open.clear();
      this.toolCalls = [];
      this.rawStopReason = undefined;
      this.earlierOutput = output.usage.output;
      this.earlierReasoning = output.usage.reasoning ?? 0;
      this.latestOutput = 0;
      output.responseId = event.message.id;
      if (event.message.model !== this.model.id) output.responseModel = event.message.model;
      this.usage(event.message.usage);
    } else if (event.type === "content_block_start") {
      const block = event.content_block;
      const contentIndex = output.content.length;
      if (block.type === "text") {
        output.content.push({ type: "text", text: block.text });
        stream.push({ type: "text_start", contentIndex, partial: output });
      } else if (block.type === "thinking") {
        output.content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
        stream.push({ type: "thinking_start", contentIndex, partial: output });
      } else if (block.type === "redacted_thinking") {
        output.content.push({ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: block.data, redacted: true });
        stream.push({ type: "thinking_start", contentIndex, partial: output });
      } else if (block.type === "tool_use") {
        const name = this.piName(block.name);
        // Claude Code answers a call for a tool it does not have and the turn goes on; Pi sees none of it.
        if (name === undefined) return false;
        output.content.push({ type: "toolCall", id: block.id, name, arguments: {} });
        this.json.set(contentIndex, "");
        this.toolCalls.push(block.id);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
      } else return false;
      this.open.set(event.index, contentIndex);
    } else if (event.type === "content_block_delta") {
      const contentIndex = this.open.get(event.index);
      const block = contentIndex === undefined ? undefined : output.content[contentIndex];
      if (contentIndex === undefined || !block) return false;
      const { delta } = event;
      if (delta.type === "text_delta" && block.type === "text") {
        block.text += delta.text;
        stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
      } else if (delta.type === "thinking_delta" && block.type === "thinking") {
        block.thinking += delta.thinking;
        stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
      } else if (delta.type === "signature_delta" && block.type === "thinking") {
        block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
      } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
        const json = (this.json.get(contentIndex) ?? "") + delta.partial_json;
        this.json.set(contentIndex, json);
        block.arguments = parseStreamingJson(json);
        stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
      }
    } else if (event.type === "content_block_stop") {
      const contentIndex = this.open.get(event.index);
      const block = contentIndex === undefined ? undefined : output.content[contentIndex];
      if (contentIndex === undefined || !block) return false;
      this.open.delete(event.index);
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      } else if (block.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
      } else {
        block.arguments = parseStreamingJson(this.json.get(contentIndex));
        this.json.delete(contentIndex);
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }
    } else if (event.type === "message_delta") {
      if (event.delta.stop_reason) {
        this.rawStopReason = event.delta.stop_reason;
        output.rawStopReason = event.delta.stop_reason;
      }
      this.usage(event.usage);
    } else if (event.type === "message_stop") {
      return true;
    }
    return false;
  }

  private usage(reported: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
  }): void {
    const { usage } = this.output;
    // Input figures describe the latest request, which already contains the earlier ones.
    if (reported.input_tokens != null) usage.input = reported.input_tokens;
    if (reported.cache_read_input_tokens != null) usage.cacheRead = reported.cache_read_input_tokens;
    if (reported.cache_creation_input_tokens != null) usage.cacheWrite = reported.cache_creation_input_tokens;
    const longLived = reported.cache_creation?.ephemeral_1h_input_tokens;
    if (longLived != null) usage.cacheWrite1h = longLived;
    if (reported.output_tokens != null) {
      this.latestOutput = reported.output_tokens;
      usage.output = this.earlierOutput + reported.output_tokens;
    }
    const thinking = reported.output_tokens_details?.thinking_tokens;
    if (thinking != null) usage.reasoning = this.earlierReasoning + thinking;
    // Pi reads the total as the size of the context. Output of earlier API messages is
    // already inside the latest input, so only the latest message's output is added.
    usage.totalTokens = usage.input + usage.cacheRead + usage.cacheWrite + this.latestOutput;
    usage.cost = calculateCost(this.model, usage);
  }
}
