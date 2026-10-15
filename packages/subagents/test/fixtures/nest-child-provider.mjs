// Coordinator and worker for the nesting smoke test. No inference/network.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);
export default function (pi) {
  pi.registerProvider("nest-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Nest Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const start = context.messages.findLastIndex(m => m.role === "user" && ["COORDINATE", "WORK"].includes(text(m)));
      const role = start >= 0 ? text(context.messages[start]) : undefined;
      const results = context.messages.slice(start + 1).filter(m => m.role === "toolResult");
      const data = i => { try { return JSON.parse(text(results[i])); } catch { return { error: text(results[i]) }; } };
      const worker = results[0] && !results[0].isError ? data(0).id : undefined;
      const steps = [
        ["subagent_spawn", { name: "nest-worker", task: "WORK", cwd: process.cwd(), model: "nest-test/stub:off", tools: [], extensions: [self] }],
        ["subagent_wait", { timeoutSeconds: 20 }],
        ["subagent_read", { id: worker }],
        ["subagent_read", { id: "subagent-00000000" }],
        ["subagent_spawn", { name: "too-deep", task: "WORK", cwd: process.cwd(), model: "nest-test/stub:off", tools: ["subagent_spawn"], extensions: [self] }],
      ];
      let content, stopReason = "stop";
      if (role === "WORK") content = [{ type: "text", text: "WORK DONE" }];
      else if (role === "COORDINATE" && results.length < steps.length && !results[0]?.isError) {
        const [name, args] = steps[results.length];
        content = [{ type: "toolCall", id: `coord-${results.length}`, name, arguments: args }]; stopReason = "toolUse";
      } else if (role === "COORDINATE") {
        const reply = (data(2).updates ?? []).findLast(update => update.kind === "assistant")?.text;
        content = [{ type: "text", text: JSON.stringify({ worker, reply, foreign: results[3]?.isError ? text(results[3]) : "ALLOWED", deep: results[4]?.isError ? text(results[4]) : "ALLOWED", spawnError: results[0]?.isError ? text(results[0]) : undefined }) }];
      } else content = [{ type: "text", text: "Ready." }];
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
