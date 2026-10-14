import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
// Scripted child: "sleep:<ms>" answers after that long. Honors abort.
const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
export default function (pi) {
  pi.registerProvider("herdr-e2e-child", {
    baseUrl: "http://unused.invalid", apiKey: "fixture-only", api: "openai-completions",
    models: [{ id: "stub", name: "herdr e2e child", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const prompt = text(context.messages.findLast(m => m.role === "user"));
      const ms = Number(/sleep:(\d+)/.exec(prompt)?.[1] ?? 0);
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: `slept ${ms}` }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      const fail = /fail:(\d+)/.exec(prompt);
      const timer = fail
        ? setTimeout(() => { stream.push({ type: "error", reason: "error", error: { ...output, content: [], stopReason: "error", errorMessage: "scripted child failure" } }); stream.end(); }, Number(fail[1]))
        : setTimeout(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: "stop", message: output }); stream.end(); }, ms);
      options?.signal?.addEventListener("abort", () => { clearTimeout(timer); stream.push({ type: "error", reason: "aborted", error: { ...output, content: [], stopReason: "aborted" } }); stream.end(); }, { once: true });
      return stream;
    },
  });
}
