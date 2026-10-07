import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
  const calls = [];
  let blocked = false;
  const task = { taskId: "fixture-task", childThreadId: "fixture-backing-thread", childRunId: "fixture-run",
    status: "running", workState: "working", hasPendingChildRuns: false, summary: null, waitTimedOut: false };
  for (const name of ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"]) {
    pi.registerTool({
      name: "mcp__t3-code__" + name, label: name, description: "Offline T3 boundary fixture.",
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute(_id, args) {
        calls.push({ name, args });
        const data = name === "orchestrator_capabilities"
          ? { parentThreadId: "fixture-parent", providers: [], features: { appOwnedSubagents: true } }
          : name === "delegate_task" ? task
          : name === "task_status" ? { ...task, taskId: args.taskId, status: "completed", workState: "result_available", summary: "Fixture result." }
          : { taskId: task.taskId, status: "cancel_requested" };
        // Exact bridge flattening shape: MCP text plus structuredContent.
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) + "\n" + JSON.stringify(data) }] };
      },
    });
  }
  pi.on("tool_call", event => {
    if (blocked && event.toolName === "mcp__t3-code__task_status") return { block: true, reason: "Fixture permission declined." };
  });
  pi.registerCommand("fixture", {
    description: "Offline fixture diagnostics.",
    async handler(args, ctx) {
      if (args === "block") blocked = true;
      else if (args === "reload") { await ctx.reload(); return; }
      ctx.ui.notify("FIXTURE SNAPSHOT:" + JSON.stringify({ tools: pi.getAllTools().map(tool => tool.name), calls }), "info");
    },
  });
  pi.registerProvider("t3-test", {
    baseUrl: "http://unused.invalid", apiKey: "fixture-only", api: "openai-completions",
    models: [{ id: "stub", name: "Stub", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const last = context.messages.at(-1);
      let stopReason = "stop", content = [{ type: "text", text: "FIXTURE DONE" }];
      if (last?.role === "user") {
        const command = typeof last.content === "string" ? last.content : last.content.filter(c => c.type === "text").map(c => c.text).join(" ");
        const op = command === "unsupported" ? "delegate" : command === "long-id" ? "read" : command;
        const args = op === "delegate" ? {
          task: "Offline bounded task.", clientRequestId: "fixture-request",
          target: { providerInstanceId: "pi", model: "fixture/stub" },
          ...(command === "unsupported" ? { tools: ["bash"] } : {}),
        } : op === "read" ? { taskId: command === "long-id" ? "node:delegated-task:" + "encoded-request-".repeat(30) : task.taskId }
          : op === "cancel" ? { taskId: task.taskId, reason: "Fixture cancel.", clientRequestId: "fixture-cancel" } : {};
        content = [{ type: "toolCall", id: "fixture-" + context.messages.length, name: "t3_subagent_" + op, arguments: args }];
        stopReason = "toolUse";
      }
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content, stopReason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
