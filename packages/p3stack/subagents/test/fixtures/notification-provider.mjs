import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const providerFile = fileURLToPath(import.meta.url);
const PAIR = new Set(["pair", "all", "steer", "followUp"]);

function childGate(context) {
  if (process.env.PI_SUBAGENT !== "1") return undefined;
  const blob = JSON.stringify(context ?? {});
  if (blob.includes("WAIT_GATE first")) return "first";
  if (blob.includes("WAIT_GATE second")) return "second";
  if (process.env.WAIT_RELEASE_FIRST || process.env.WAIT_RELEASE_SECOND) console.error("WAIT_GATE token missing from child context");
  return undefined;
}

export default function (pi) {
  pi.registerProvider("notification-test", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "stub", name: "Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const gate = childGate(context);
      const mode = process.env.NOTICE_TEST_MODE;
      let content = [{ type: "text", text: gate ? `${gate} result` : "worker result" }];
      let stopReason = "stop";
      if (process.env.PI_SUBAGENT !== "1") {
        const toolResults = context.messages.filter(m => m.role === "toolResult");
        const spawns = toolResults.filter(m => m.toolName === "subagent_spawn");
        const spawned = spawns[0];
        const waited = toolResults.some(m => m.toolName === "subagent_wait");
        const read = toolResults.some(m => m.toolName === "subagent_read");
        const reported = context.messages.some(m => m.role === "user" && /SUBAGENT REPORTS|HUMAN SUPERVISION/.test(JSON.stringify(m.content)));
        const idOf = message => JSON.parse(message.content.find(c => c.type === "text").text).id;
        let tool;
        if (reported) content = [{ type: "text", text: "REPORT RECEIVED" }];
        else if (PAIR.has(mode) && spawns.length < 2) {
          const which = spawns.length === 0 ? "first" : "second";
          tool = { name: "subagent_spawn", arguments: {
            name: which, task: `WAIT_GATE ${which} Return ${which} result.`, cwd: process.cwd(),
            model: "notification-test/stub:off", tools: [], extensions: [providerFile],
          } };
        } else if (!spawned) tool = { name: "subagent_spawn", arguments: {
          name: "worker", task: "Return worker result.", cwd: process.cwd(),
          model: "notification-test/stub:off", tools: [], extensions: [providerFile],
          coordination: { owns: ["src"], outputs: ["report.md"] },
        } };
        else if (!waited) {
          const ids = spawns.map(idOf);
          tool = { name: "subagent_wait", arguments: PAIR.has(mode)
            ? { ids, ...(mode === "all" ? { mode: "all" } : {}) }
            : ["message", "abort"].includes(mode) ? { ids }
            : { ids, timeoutSeconds: 5, ...(mode === "default" ? {} : { collect: mode === "collect" }) } };
        } else if (!read && !["unread", "collect", "default", "message", "abort", ...PAIR].includes(mode)) {
          tool = { name: "subagent_read", arguments: { id: idOf(spawned) } };
        } else content = [{ type: "text", text: "PARENT FINISHED" }];
        if (tool) { stopReason = "toolUse"; content = [{ type: "toolCall", id: `call-${toolResults.length}`, ...tool }]; }
      }
      const output = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content, stopReason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      const release = gate === "first" ? process.env.WAIT_RELEASE_FIRST
        : gate === "second" ? process.env.WAIT_RELEASE_SECOND
        : process.env.PI_SUBAGENT === "1" ? process.env.NOTICE_TEST_RELEASE : undefined;
      const poll = setInterval(() => {
        if (release && !existsSync(release)) return;
        clearInterval(poll);
        stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: stopReason, message: output }); stream.end();
      }, 20);
      return stream;
    },
  });
}
