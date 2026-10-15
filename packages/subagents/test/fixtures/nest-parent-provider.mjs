// Root Parent for the nesting smoke test: spawn a coordinator, read it, close it. No inference/network.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nestChild from "./nest-child-provider.mjs";
const childFixture = fileURLToPath(new URL("./nest-child-provider.mjs", import.meta.url));
const delegation = ["subagent_spawn", "subagent_wait", "subagent_read", "subagent_close", "subagent_list"];
export default function (pi) {
  nestChild(pi);
  pi.registerProvider("nest-parent", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Nest Parent Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const start = context.messages.findLastIndex(m => m.role === "user" && text(m) === "NEST SMOKE");
      const results = context.messages.slice(start + 1).filter(m => m.role === "toolResult");
      const data = i => { try { return JSON.parse(text(results[i])); } catch { return { error: text(results[i]) }; } };
      const coordinator = results[0] && !results[0].isError ? data(0).id : undefined;
      const steps = [
        ["subagent_spawn", { name: "nest-coordinator", task: "COORDINATE", cwd: process.cwd(), model: "nest-test/stub:off", tools: delegation, extensions: [childFixture] }],
        ["subagent_wait", { ids: [coordinator], timeoutSeconds: 40 }],
        ["subagent_read", { id: coordinator }],
        ["subagent_list", {}],
        ["subagent_close", { id: coordinator }],
        ["subagent_list", {}],
      ];
      let content, stopReason = "stop";
      if (start >= 0 && results.length < steps.length && !results.some(r => r.isError)) {
        const [name, args] = steps[results.length];
        content = [{ type: "toolCall", id: `parent-${results.length}`, name, arguments: args }]; stopReason = "toolUse";
      } else {
        const proof = results.some(r => r.isError) ? { error: text(results.find(r => r.isError)) } : {
          coordinator, report: (data(2).updates ?? []).findLast(update => update.kind === "assistant")?.text,
          before: data(3).agents.map(({ id, name, parentId, depth, status }) => ({ id, name, parentId, depth, status })),
          after: data(5).agents.map(({ id, name, status }) => ({ id, name, status })),
        };
        if (process.env.NEST_SMOKE_OUTPUT) writeFileSync(process.env.NEST_SMOKE_OUTPUT, JSON.stringify(proof, null, 2));
        content = [{ type: "text", text: "NEST SMOKE DONE" }];
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
