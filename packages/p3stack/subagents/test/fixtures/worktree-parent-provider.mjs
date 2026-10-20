// Real parent driver: spawn a child in a new worktree, list it, close it. No inference/network.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import peerProvider from "./peer-provider.mjs";
export default function (pi) {
  peerProvider(pi);
  pi.registerProvider("worktree-parent", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Worktree Parent Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const start = context.messages.findLastIndex(m => m.role === "user" && text(m) === "WORKTREE SMOKE");
      const results = context.messages.slice(start + 1).filter(m => m.role === "toolResult");
      const data = i => JSON.parse(text(results[i]));
      const child = results[0] && !results[0].isError ? data(0).id : undefined;
      const steps = [
        ["subagent_spawn", { name: "Worktree Smoke", task: "Ready", cwd: process.cwd(), model: "peer-test/stub:off", tools: [],
          extensions: [fileURLToPath(new URL("./peer-provider.mjs", import.meta.url))], worktree: true }],
        ["subagent_wait", { ids: [child], timeoutSeconds: 10 }],
        ["subagent_list", {}],
        ["subagent_close", { id: child }],
      ];
      let content, stopReason = "stop";
      if (start >= 0 && results.length < steps.length && !results.some(r => r.isError)) {
        const [name, args] = steps[results.length];
        content = [{ type: "toolCall", id: `parent-${results.length}`, name, arguments: args }]; stopReason = "toolUse";
      } else {
        const proof = results.some(r => r.isError)
          ? { error: text(results.find(r => r.isError)) }
          : { spawned: data(0), listed: data(2).agents.find(agent => agent.id === child) };
        if (process.env.WORKTREE_SMOKE_OUTPUT) writeFileSync(process.env.WORKTREE_SMOKE_OUTPUT, JSON.stringify(proof, null, 2));
        content = [{ type: "text", text: "WORKTREE SMOKE DONE" }];
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
