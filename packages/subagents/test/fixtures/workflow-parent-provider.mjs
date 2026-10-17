import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { renameSync, writeFileSync } from "node:fs";
import workflowProvider from "./workflow-provider.mjs";
export default function (pi) {
  workflowProvider(pi);
  pi.registerProvider("workflow-parent", {
    baseUrl: "http://unused.invalid", apiKey: "fixture-only", api: "openai-completions",
    models: [{ id: "stub", name: "Workflow Parent Stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const text = m => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const start = context.messages.findLastIndex(m => m.role === "user" && text(m) === "WORKFLOW SMOKE");
      const messages = context.messages.slice(start + 1);
      const started = messages.find(m => m.role === "toolResult" && m.toolName === "subagent_workflow_start");
      const inspected = messages.find(m => m.role === "toolResult" && m.toolName === "subagent_workflow_inspect");
      const reported = messages.some(m => m.role === "user" && text(m).includes("SUBAGENT REPORTS"));
      let content = [{ type: "text", text: "Ready. Send WORKFLOW SMOKE." }], stopReason = "stop";
      const call = (name, args) => { content = [{ type: "toolCall", id: `parent-${Date.now()}-${Math.random()}`, name, arguments: args }]; stopReason = "toolUse"; };
      if (start >= 0 && !started) call("subagent_workflow_start", { path: process.env.WORKFLOW_SMOKE_DEFINITION });
      else if (started?.isError || inspected?.isError) content = [{ type: "text", text: `WORKFLOW SMOKE FAILED: ${text(inspected ?? started)}` }];
      else if (inspected) {
        const proof = JSON.parse(text(inspected));
        if (process.env.WORKFLOW_SMOKE_OUTPUT) {
          const output = process.env.WORKFLOW_SMOKE_OUTPUT;
          writeFileSync(`${output}.tmp`, JSON.stringify(proof, null, 2));
          renameSync(`${output}.tmp`, output);
        }
        content = [{ type: "text", text: proof.status === "succeeded" ? "WORKFLOW SMOKE PASSED: autonomous run finished; inspected after one workflow notification." : "WORKFLOW SMOKE FAILED: inspect status." }];
      } else if (reported && started) call("subagent_workflow_inspect", { id: JSON.parse(text(started)).id });
      else if (started) content = [{ type: "text", text: "Workflow launched. Parent is idle while workers and checks proceed autonomously." }];
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
