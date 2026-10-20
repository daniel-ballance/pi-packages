// Deterministic workflow worker/reviewer for real Pi tests; no model requests.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("workflow-test", {
    baseUrl: "http://unused.invalid", apiKey: "fixture-only", api: "openai-completions",
    models: [{ id: "stub", name: "Workflow Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const plain = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const last = context.messages.filter(m => m.role !== "system").at(-1);
      const assignment = [...context.messages].reverse().find(m => m.role === "user" && plain(m).includes("Workflow assignment"));
      const prompt = plain(assignment), text = plain(last);
      let content = [{ type: "text", text: "fixture result" }], stopReason = "stop";
      const call = (name, args) => { content = [{ type: "toolCall", id: `call-${Date.now()}-${Math.random()}`, name, arguments: args }]; stopReason = "toolUse"; };
      if (last?.role === "user" && text.startsWith("Peer message ")) {
        const envelope = JSON.parse(text.split("\n")[2]);
        if (envelope.message === "workflow-ping") call("peer_send", { recipient: envelope.sender, message: "workflow-pong" });
        else content = [{ type: "text", text: `Received ${envelope.message}` }];
      } else if (last?.role === "user" && prompt.includes("fixture:peer-b")) {
        const peers = JSON.parse(prompt.match(/Connected peers: (\[.*\])/)[1]);
        call("peer_send", { recipient: peers[0].id, message: "workflow-ping" });
      } else if (last?.role === "user" && /fixture:(seed|repair|improve)/.test(prompt)) {
        const directory = prompt.match(/Write candidate files only under: (.+)/)[1];
        const iteration = Number(prompt.match(/Iteration (\d+)/)?.[1] ?? 1);
        const value = prompt.includes("fixture:seed") ? 100 : prompt.includes("fixture:repair") ? iteration : [90, 95, 80][iteration - 1];
        call("write", { path: `${directory}/value.txt`, content: String(value) });
      } else if (prompt.includes("fixture:review")) {
        content = [{ type: "text", text: JSON.stringify({ verdict: "pass", findings: "Fixture reviewer accepted the supplied artifact." }) }];
      } else if (last?.role === "toolResult" && last.isError) {
        content = [{ type: "text", text: `Fixture tool error: ${text}` }];
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
