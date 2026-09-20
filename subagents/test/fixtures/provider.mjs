import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("subagent-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(m => m.role === "user");
      const text = users.map(m => typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(" ")).join(" | ");
      const output = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: `History (${users.length}): ${text}` }],
        stopReason: "stop", timestamp: Date.now(),
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      };
      const finish = () => {
        stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      };
      if (text.endsWith("slow")) {
        const timer = setTimeout(finish, 10000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          stream.push({ type: "error", reason: "aborted", error: { ...output, content: [], stopReason: "aborted" } });
          stream.end();
        }, { once: true });
      } else queueMicrotask(finish);
      return stream;
    }
  });
}
