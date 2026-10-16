// Real parent tool-call driver for RPC and tmux smoke tests. No inference/network.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import peerProvider from "./peer-provider.mjs";
export default function (pi) {
  peerProvider(pi);
  pi.registerProvider("peer-parent", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Peer Parent Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const start = context.messages.findLastIndex(m => m.role === "user" && text(m) === "PEER SMOKE");
      const results = context.messages.slice(start + 1).filter(m => m.role === "toolResult");
      const data = i => JSON.parse(text(results[i]));
      const spawned = i => results[i] && data(i).id;
      const A = spawned(1), B = spawned(2), C = spawned(3);
      const spawn = name => ["subagent_spawn", { name, task: "Ready", cwd: process.cwd(), model: "peer-test/stub:off", tools: ["peer_send"], extensions: [fileURLToPath(new URL("./peer-provider.mjs", import.meta.url))] }];
      const steps = [
        ["subagent_catalog", {}], spawn("smoke-A"), spawn("smoke-B"), spawn("smoke-C"),
        ["subagent_wait", { ids: [A, B, C], timeoutSeconds: 10 }],
        ["subagent_connect", { a: B, b: C, limit: 2 }],
        ["subagent_send", { id: A, message: `SEND ${JSON.stringify({ recipient: B, message: "forbidden" })}` }],
        ["subagent_wait", { ids: [A], timeoutSeconds: 10, collect: false }],
        ["subagent_read", { id: A }],
        ["subagent_send", { id: B, message: `SEND ${JSON.stringify({ recipient: C, message: "ping" })}` }],
        ["subagent_wait", { ids: [B, C], timeoutSeconds: 10, collect: false }],
        ["subagent_peers", { id: B }],
        ["subagent_read", { id: B }],
        ["subagent_disconnect", { a: B, b: C }],
        ["subagent_close", { id: A }], ["subagent_close", { id: B }], ["subagent_close", { id: C }],
      ];
      let content, stopReason = "stop";
      if (start >= 0 && results.length < steps.length && !results.some(r => r.isError)) {
        const [name, args] = steps[results.length];
        content = [{ type: "toolCall", id: `parent-${Date.now()}-${results.length}`, name, arguments: args }]; stopReason = "toolUse";
      } else if (start >= 0 && results.length >= steps.length) {
        const peers = data(11), denied = JSON.stringify(data(8)), reply = JSON.stringify(data(12));
        const passed = peers.messages.length === 2 && peers.messages.every(m => m.status === "received") && denied.includes("No parent-authorized") && reply.includes("RECEIVED pong") && [14, 15, 16].every(i => data(i).status === "stopped");
        const proof = { passed, peers, A, B, C, closed: [14, 15, 16].map(i => data(i).status) };
        if (process.env.PEER_SMOKE_OUTPUT) writeFileSync(process.env.PEER_SMOKE_OUTPUT, JSON.stringify(proof, null, 2));
        content = [{ type: "text", text: passed ? "PEER SMOKE PASSED: A denied; B ↔ C received ping/pong; all children closed." : "PEER SMOKE FAILED: inspect fixture proof." }];
      } else content = [{ type: "text", text: results.some(r => r.isError) ? `PEER SMOKE FAILED: ${text(results.find(r => r.isError))}` : "Ready. Send PEER SMOKE." }];
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
