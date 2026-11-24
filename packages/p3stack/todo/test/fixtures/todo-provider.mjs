// Deterministic provider for real-Pi tests. No network.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";

export default function (pi) {
  let steps = [];
  pi.registerProvider("todo-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Todo Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      if (process.env.PI_TEST_REQUESTS) appendFileSync(process.env.PI_TEST_REQUESTS, JSON.stringify({
        system: getCurrentSystemPrompt(context.messages), messages: context.messages,
      }) + "\n");
      const last = context.messages.at(-1);
      // A start can include extension-authored user-role notes after the assignment.
      const userBlock = context.messages.slice(context.messages.findLastIndex(m => m.role !== "user") + 1);
      const text = userBlock.flatMap(m => typeof m.content === "string" ? [m.content] : m.content.filter(c => c.type === "text").map(c => c.text))
        .flatMap(s => s.split("\n")).findLast(line => /^(CALL|RUN) /.test(line)) ?? "";
      let content = [{ type: "text", text: "ok" }], stopReason = "stop";
      if (last.role === "user" && text.startsWith("RUN ")) steps = JSON.parse(text.slice(4));
      const args = last.role === "user" && text.startsWith("CALL ") ? JSON.parse(text.slice(5)) : steps.shift();
      if (args) {
        content = [{ type: "toolCall", id: `call-${context.messages.length}`, name: args.name ?? "todo", arguments: args.arguments ?? args }];
        stopReason = "toolUse";
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
