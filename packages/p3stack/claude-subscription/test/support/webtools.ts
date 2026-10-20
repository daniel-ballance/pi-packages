import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQuery, QueryFunction } from "../../extensions/claude-subscription/src/sdk.js";

export function frame(value: object): SDKMessage {
  return { uuid: "uuid", session_id: "session", ...value } as unknown as SDKMessage;
}

export type WebScript = (process: WebProcess) => AsyncGenerator<SDKMessage>;

export class WebProcess {
  closed = false;
  reads = 0;
  constructor(readonly options: Options, readonly prompt: AsyncIterable<SDKUserMessage>, private readonly script: WebScript) {}
  close(): void { this.closed = true; }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    const iterator = this.script(this);
    return { next: () => { this.reads++; return iterator.next(); } };
  }
  async permit(name: string, input: object, id = "call") {
    const hook = this.options.hooks!.PreToolUse![0].hooks[0];
    return hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id,
      session_id: "session", transcript_path: "", cwd: this.options.cwd! }, id, { signal: new AbortController().signal });
  }
}

export function scriptedQuery(script: WebScript) {
  const processes: WebProcess[] = [];
  const query: QueryFunction = ({ options, prompt }) => {
    const process = new WebProcess(options, prompt, script);
    processes.push(process);
    return process as unknown as AgentQuery;
  };
  return { query, processes };
}

export function assistant(name: string, input: object, id = "call") {
  return frame({ type: "assistant", message: { id: "request", usage: {
    input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 13,
  }, content: [{ type: "tool_use", id, name, input }] } });
}

export async function* call(process: WebProcess, name: string, args: object) {
  yield assistant(name, args);
  await process.permit(name, args);
  yield frame({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 19 } } });
  yield frame({ type: "stream_event", event: { type: "message_stop" } });
}

export function result(details: unknown, text = "A page-derived answer", extra: object = {}) {
  return frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: text, ...extra }] }, tool_use_result: details });
}

export const searchDetails = { query: "example", results: [
  { tool_use_id: "server-call", content: [{ title: "Example Domain", url: "https://example.com" }] },
  "Reserved for documentation.",
] };
