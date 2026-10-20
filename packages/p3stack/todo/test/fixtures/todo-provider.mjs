// Deterministic provider for real-Pi tests: "CALL <json>" becomes one todo call. No network.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
  pi.registerProvider("todo-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Todo Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = typeof last.content === "string" ? last.content : last.content?.find(c => c.type === "text")?.text ?? "";
      let content = [{ type: "text", text: "ok" }], stopReason = "stop";
      if (last.role === "user" && text.startsWith("CALL ")) {
        content = [{ type: "toolCall", id: `todo-${context.messages.length}`, name: "todo", arguments: JSON.parse(text.slice(5)) }];
        stopReason = "toolUse";
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
