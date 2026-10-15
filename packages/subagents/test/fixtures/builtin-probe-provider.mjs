// Phase-0 compatibility fixture only: local providers, synthetic usage, no network.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createCodemodeExtension, createMcpExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async function (pi) {
  const warming = process.env.BUILTIN_PROBE_WARMING === "1";
  if (warming) pi.on("cache_warming_decision", event => { pi.appendEntry("warming-decision", event); return { action: "warm" }; });
  if (process.env.BUILTIN_PROBE_SERVER) {
    pi.registerMcpServer("extension", { command: process.execPath, args: [process.env.BUILTIN_PROBE_SERVER, process.env.BUILTIN_PROBE_EXTENSION_MARKER] });
    pi.registerCommand("late-mcp", { handler: async () => {
      pi.registerMcpServer("late", { command: process.execPath, args: [process.env.BUILTIN_PROBE_SERVER, process.env.BUILTIN_PROBE_LATE_MARKER] });
    } });
  }
  if (process.env.BUILTIN_PROBE_WRAPPED === "1") {
    await createCodemodeExtension({ models: false, mode: "only", inlineBudget: 0 })(pi);
    await createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })(pi);
  }
  pi.registerProvider("builtin-probe", {
    baseUrl: "http://unused.invalid", apiKey: "test-only", api: "openai-completions",
    models: [
      { id: "stub", name: "Stub", reasoning: false, input: ["text"],
        cost: { input: warming ? 10000 : 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(warming ? { promptCache: { short: 10.2 } } : {}), contextWindow: 32000, maxTokens: 1000 },
      { type: "classifier", id: "classifier", name: "Classifier", api: "probe-classifier", input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000 },
    ],
    // Answers every yes/no question; Pi 1.x validates questions and answers.
    classifiers: { "probe-classifier": { classify: async (_model, context) => ({
      api: "probe-classifier", provider: "builtin-probe", model: "classifier", stopReason: "stop", timestamp: Date.now(),
      answers: Object.fromEntries(Object.keys(context?.questions ?? {}).map(id => [id, { type: "bool", probability: 1 }])),
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } },
    }) } },
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream(), last = context.messages.at(-1);
      const text = typeof last.content === "string" ? last.content : last.content?.find(c => c.type === "text")?.text;
      let content = [{ type: "text", text: "ok" }];
      if (last.role === "user" && text?.startsWith("CODE ")) {
        content = [{ type: "toolCall", id: `code-${context.messages.length}`, name: "codemode", arguments: { code: text.slice(5) } }];
      } else if (last.role === "user" && text?.startsWith("CALL ")) {
        content = [{ type: "toolCall", id: `direct-${context.messages.length}`, name: text.slice(5), arguments: {} }];
      } else if (last.role === "user" && text === "SEARCH") {
        content = [{ type: "toolCall", id: `search-${context.messages.length}`, name: "tool_search", arguments: { query: "forbidden", limit: 1 } }];
      }
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: warming ? 1000 : 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: warming ? 1000 : 0,
          cost: { input: warming && options?.maxTokens === 1 ? 0.25 : 0, output: 0, cacheRead: 0, cacheWrite: 0, total: warming && options?.maxTokens === 1 ? 0.25 : 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
      return stream;
    },
  });
  pi.registerVirtualModel({ provider: "builtin-probe", id: "virtual", name: "Virtual", route(_request, ctx) {
    return { model: ctx.modelRegistry.find("builtin-probe", "stub"), thinkingLevel: "off" };
  } });
  for (const name of ["forbidden", "subagent_forbidden", "metered"]) {
    pi.registerTool({ name, label: name, description: name, exposure: "deferred", parameters: Type.Object({}), async execute() {
      return { content: [{ type: "text", text: `EXECUTED ${name}` }], details: {}, ...(name === "metered" ? {
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
      } : {}) };
    } });
  }
  pi.on("tool_call", event => { pi.appendEntry("builtin-probe-call", { name: event.toolName, parent: event.parentToolCallId }); });
  pi.on("input", event => event.text === "CONSUME" ? { action: "handled" } : undefined);
  pi.registerCommand("builtin-probe", { handler: async (_args, ctx) => {
    pi.appendEntry("builtin-probe", {
      tools: pi.getAllTools().map(({ name, sourceInfo, exposure }) => ({ name, sourceInfo, exposure })),
      active: pi.getActiveTools(), settings: pi.getSettings(), virtual: ctx.modelRegistry.find("builtin-probe", "virtual"),
    });
  } });
}
