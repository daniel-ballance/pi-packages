import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("notification-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      let content = [{ type: "text", text: "worker result" }];
      let stopReason = "stop";
      if (process.env.PI_SUBAGENT !== "1") {
        const toolResults = context.messages.filter(m => m.role === "toolResult");
        const spawned = toolResults.find(m => m.toolName === "subagent_spawn");
        const waited = toolResults.some(m => m.toolName === "subagent_wait");
        const read = toolResults.some(m => m.toolName === "subagent_read");
        const reported = context.messages.some(m => m.role === "user" && /SUBAGENT REPORTS|HUMAN SUPERVISION/.test(JSON.stringify(m.content)));
        let tool;
        if (reported) content = [{ type: "text", text: "REPORT RECEIVED" }];
        else if (!spawned) tool = { name: "subagent_spawn", arguments: {
          name: "worker", task: "Return worker result.", cwd: process.cwd(),
          model: "notification-test/stub:off", tools: [], extensions: [fileURLToPath(import.meta.url)],
          coordination: { owns: ["src"], outputs: ["report.md"] },
        } };
        else if (!waited) {
          const ids = [JSON.parse(spawned.content.find(c => c.type === "text").text).id];
          const mode = process.env.NOTICE_TEST_MODE;
          tool = { name: "subagent_wait", arguments: ["message", "abort"].includes(mode) ? { ids }
            : { ids, timeoutSeconds: 5, ...(mode === "default" ? {} : { collect: mode === "collect" }) } };
        }
        else if (!read && !["unread", "collect", "default", "message", "abort"].includes(process.env.NOTICE_TEST_MODE)) tool = { name: "subagent_read", arguments: { id: JSON.parse(spawned.content.find(c => c.type === "text").text).id } };
        else content = [{ type: "text", text: "PARENT FINISHED" }];
        if (tool) { stopReason = "toolUse"; content = [{ type: "toolCall", id: `call-${toolResults.length}`, ...tool }]; }
      }
      const output = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content, stopReason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      const delay = process.env.PI_SUBAGENT === "1" && ["message", "abort"].includes(process.env.NOTICE_TEST_MODE) ? 3000 : 0;
      setTimeout(() => {
        stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: stopReason, message: output }); stream.end();
      }, delay);
      return stream;
    },
  });
}
