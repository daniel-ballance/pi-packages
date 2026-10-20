import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
// Scripted parent: acts only on the latest user message. No network.
const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
export default function (pi) {
  pi.registerProvider("herdr-e2e-parent", {
    baseUrl: "http://unused.invalid", apiKey: "fixture-only", api: "openai-completions",
    models: [{ id: "stub", name: "herdr e2e parent", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const last = context.messages.findLastIndex(m => m.role === "user");
      const prompt = text(context.messages[last]);
      const after = context.messages.slice(last + 1);
      let content = [{ type: "text", text: "ok" }], stopReason = "stop", delay = 0;
      const calls = list => { content = list.map(([name, args], i) => ({ type: "toolCall", id: `p-${Date.now()}-${i}`, name, arguments: args })); stopReason = "toolUse"; };
      const words = prompt.trim().split(/\s+/);
      if (prompt.includes("SUBAGENT REPORTS")) content = [{ type: "text", text: "ack reports" }];
      else if (words[0] === "SPAWN" && !after.length) calls(words.slice(1).map((ms, i) => ["subagent_spawn",
        { name: `child ${i + 1}`, task: /^\d+$/.test(ms) ? `sleep:${ms}` : ms, cwd: process.env.HERDR_E2E_ROOT, model: "herdr-e2e-child/stub:off", tools: [] }]));
      else if (words[0] === "WORKFLOW" && !after.length) calls([["subagent_workflow_start", { path: process.env.HERDR_E2E_WORKFLOW }]]);
      else if (words[0] === "TURN") delay = Number(words[1]);
      else if (after.length) content = [{ type: "text", text: `done: ${after.map(m => text(m)).join(" ").slice(0, 200)}` }];
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      const finish = () => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); };
      const timer = setTimeout(finish, delay);
      options?.signal?.addEventListener("abort", () => { clearTimeout(timer); stream.push({ type: "error", reason: "aborted", error: { ...output, content: [], stopReason: "aborted" } }); stream.end(); }, { once: true });
      return stream;
    },
  });
}
