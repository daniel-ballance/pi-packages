import { randomUUID } from "node:crypto";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type ToolCall, type Usage } from "@earendil-works/pi-ai";

export type AgyPromptResponse = PromptResponse & { usage?: {
  inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number; totalTokens?: number;
} };

export function mapUsage(reported: AgyPromptResponse["usage"]): Omit<Usage, "cost"> {
  const input = reported?.inputTokens ?? 0;
  const output = reported?.outputTokens ?? 0;
  const cacheRead = reported?.cachedReadTokens ?? 0;
  const cacheWrite = reported?.cachedWriteTokens ?? 0;
  return { input, output, cacheRead, cacheWrite, reasoning: reported?.thoughtTokens,
    totalTokens: reported?.totalTokens ?? input + output + cacheRead + cacheWrite };
}

const STOP = { end_turn: "stop", max_tokens: "length", max_turn_requests: "length", refusal: "stop", cancelled: "aborted" } as const;

export class Response {
  readonly stream = createAssistantMessageEventStream();
  readonly output: AssistantMessage;
  private started = false;
  private ended = false;
  private open: number | undefined;

  constructor(model: Model<Api>) {
    this.output = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
      responseId: randomUUID(), timestamp: Date.now(), stopReason: "pending",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  private flush(): void {
    const { open: contentIndex, output: partial } = this;
    if (contentIndex === undefined) return;
    this.open = undefined;
    const block = partial.content[contentIndex];
    if (block.type === "text") this.stream.push({ type: "text_end", contentIndex, content: block.text, partial });
    if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
  }

  chunk(kind: "text" | "thinking", delta: string): void {
    if (this.ended || !delta) return;
    this.start();
    const partial = this.output;
    if (this.open === undefined || partial.content[this.open].type !== kind) {
      this.flush();
      this.open = partial.content.length;
      partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      this.stream.push({ type: `${kind}_start`, contentIndex: this.open, partial });
    }
    const block = partial.content[this.open];
    if (block.type === "text") block.text += delta;
    if (block.type === "thinking") block.thinking += delta;
    this.stream.push({ type: `${kind}_delta`, contentIndex: this.open, delta, partial });
  }

  tool(call: ToolCall): void {
    if (this.ended) return;
    this.start();
    this.flush();
    const partial = this.output;
    const contentIndex = partial.content.push(call) - 1;
    this.stream.push({ type: "toolcall_start", contentIndex, partial });
    this.stream.push({ type: "toolcall_delta", contentIndex, partial, delta: JSON.stringify(call.arguments) });
    this.stream.push({ type: "toolcall_end", contentIndex, partial, toolCall: call });
  }

  addUsage(result: AgyPromptResponse): void {
    const { usage } = this.output;
    const reported = mapUsage(result.usage);
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[field] += reported[field];
    if (reported.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + reported.reasoning;
  }

  complete(result: AgyPromptResponse): void {
    this.addUsage(result);
    this.output.rawStopReason = result.stopReason;
    this.finish(STOP[result.stopReason] ?? "error", result.stopReason === "cancelled" ? "Antigravity cancelled the request" : undefined);
  }

  finish(reason: "stop" | "length" | "toolUse" | "error" | "aborted", message?: string): void {
    if (this.ended) return;
    this.ended = true;
    const output = this.output;
    output.stopReason = reason;
    output.errorMessage = message;
    if (reason === "error" || reason === "aborted") {
      this.flush();
      this.stream.push({ type: "error", reason, error: output });
    } else {
      this.start();
      this.flush();
      this.stream.push({ type: "done", reason, message: output });
    }
    this.stream.end(output);
  }
}
