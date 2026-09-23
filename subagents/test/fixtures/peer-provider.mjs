// Deterministic test-only provider. No network or credentials.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "peer_test_hold", label: "Hold", description: "Test-only delay", parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error("Aborted")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 600);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
      return { content: [{ type: "text", text: "held" }], details: {} };
    },
  });
  pi.registerTool({ name: "peer_test_ask", label: "Ask", description: "Test-only dialog", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const confirmed = await ctx.ui.confirm("Peer test", "Fixture-only confirmation");
      return { content: [{ type: "text", text: String(confirmed) }], details: {} };
    },
  });
  pi.registerProvider("peer-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Peer Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.filter(m => m.role !== "system").at(-1);
      const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      let content = [{ type: "text", text: `Observed: ${text}` }], stopReason = "stop";
      const call = (name, args) => { content = [{ type: "toolCall", id: `call-${Date.now()}-${Math.random()}`, name, arguments: args }]; stopReason = "toolUse"; };
      if (last?.role === "user" && text.startsWith("SEND ")) call("peer_send", JSON.parse(text.slice(5)));
      else if (last?.role === "user" && text === "HOLD") call("peer_test_hold", {});
      else if (last?.role === "user" && text === "ASK") call("peer_test_ask", {});
      else if (last?.role === "user" && text.startsWith("Peer message ")) {
        const envelope = JSON.parse(text.split("\n")[2]);
        if (envelope.message === "ping") call("peer_send", { recipient: envelope.sender, message: "pong" });
        else content = [{ type: "text", text: `RECEIVED ${envelope.message} FROM ${envelope.sender}` }];
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason, timestamp: Date.now(), usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
