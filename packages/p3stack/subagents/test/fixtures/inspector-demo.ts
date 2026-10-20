import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../extensions/subagents/src/manager.js";
import type { InspectorSource } from "../../extensions/subagents/src/inspector-data.js";
import type { WorkflowRun } from "../../extensions/subagents/src/workflows.js";
import { showInspector } from "../../extensions/subagents/src/inspector.js";

/** Synthetic presentation fixtures only: no processes, model calls, files, or acknowledgements. */
export function demoSource(now = Date.now()): InspectorSource {
  const created = new Date(now - 93000).toISOString();
  const worker = { model: "demo/local:off", tools: ["read"] };
  const makeAgent = (id: string, name: string, status: AgentRecord["status"], model: string, thinking: string, workflow?: string): AgentRecord => ({
    id, name, status, workflow, task: "Investigate cache expiry and report evidence. Do not edit any source files.",
    config: { cwd: "/demo/project", model }, model, thinking,
    sessionFile: `/demo/${id}/session.jsonl`, logFile: `/demo/${id}/events.jsonl`, stderrFile: `/demo/${id}/stderr.log`,
    createdAt: created, updatedAt: created, usage: { cost: 0.042, assistantMessages: 6, tokens: { input: 1200, output: 340 } },
    cursor: 6, readCursor: 0, uiRequests: [], hadEnvOverrides: false,
    activity: status === "working" ? "Reading documentation" : "Waiting for instructions",
    updates: Array.from({ length: 6 }, (_, i) => ({ cursor: i + 1, kind: "assistant", time: new Date(now - 60000 + i * 8000).toISOString(),
      text: `Observation ${i + 1}: the cached entry includes a timestamp and a TTL.\nComparing this with the documented refresh behaviour.\nEvidence: docs/cache.md, lines ${10 + i * 5}–${15 + i * 5}.` })),
  });
  const reviewed = makeAgent("history", "Review dependencies", "idle", "xai/grok-4.7", "off");
  reviewed.readCursor = reviewed.cursor;
  const agents = [makeAgent("cache", "Investigate caching", "working", "claude-subscription/claude-opus-5-5", "xhigh"), reviewed,
    makeAgent("security", "Security review", "working", "xai/grok-4.7", "high", "workflow-demo"), makeAgent("compat", "Compatibility review", "stopped", "openai-codex/gpt-6-luna", "medium", "workflow-demo")];
  const run: WorkflowRun = {
    id: "workflow-demo", definition: { version: 1, name: "Documentation refresh", cwd: "/demo/project", limits: { concurrency: 2, maxAttempts: 12, timeoutSeconds: 300 },
      steps: [
        { id: "gather", kind: "task", worker, instructions: "Gather requirements." },
        { id: "security", kind: "task", worker, instructions: "Review authentication security.", dependsOn: ["gather"] },
        { id: "compatibility", kind: "task", worker, instructions: "Review compatibility.", dependsOn: ["gather"] },
        { id: "synthesis", kind: "loop", worker, instructions: "Synthesize both reviews, then repair until the checks pass.", dependsOn: ["security", "compatibility"], mode: "repair", maxIterations: 3,
          validator: { kind: "command", command: "npm test" } },
        { id: "approve", kind: "check", input: "synthesis", validator: { kind: "human", instructions: "Is this ready for publication?" } },
      ] }, directory: "/demo/workflow-demo", created, deadline: now + 207000, status: "running", usedAttempts: 3, unread: true, noticeRevision: 1,
    steps: {
      gather: { status: "passed", iteration: 0, attempts: [{ number: 1, kind: "task", status: "completed", started: created, directory: "/demo/gather", children: [] }] },
      security: { status: "running", activity: "Reviewing authentication documentation", iteration: 0, attempts: [{ number: 2, kind: "task", status: "running", started: created, directory: "/demo/security", children: ["security"] }] },
      compatibility: { status: "passed", iteration: 0, attempts: [{ number: 3, kind: "task", status: "completed", started: created, directory: "/demo/compatibility", children: ["compat"],
        artifact: { path: "/demo/artifacts/compatibility", digest: "demo-digest", summary: "No breaking changes found." } }] },
      synthesis: { status: "pending", iteration: 0, attempts: [] }, approve: { status: "pending", iteration: 0, attempts: [] },
    },
  };
  const approval: WorkflowRun = { ...structuredClone(run), id: "workflow-approval", status: "blocked", usedAttempts: 2, reason: "Waiting for human approval. Use /workflows approve <id> approve, then explicitly resume.",
    definition: { ...run.definition, name: "Release review", steps: [run.definition.steps[0], { id: "approve", kind: "check", input: "gather", validator: { kind: "human", instructions: "Approve the release evidence?" } }] },
    steps: { gather: structuredClone(run.steps.gather), approve: { status: "approval", iteration: 0, attempts: [{ number: 2, kind: "check", status: "waiting", directory: "/demo/approval", started: created, children: [] }] } } };
  return {
    agents: () => agents, workflows: () => [run, approval],
    activity: id => ({ tools: [{ id: `${id}-read`, time: new Date(now - 4000).toISOString(), name: "read", args: '{"path":"docs/cache.md"}', status: "completed", output: "Cache entries expire after the configured TTL." }],
      phase: "Writing (synthetic demo)", text: "This is simulated streaming output, not a running agent.\n" + "Comparing expiry with the refresh interval. ".repeat(1 + Math.floor(Math.max(0, Date.now() - now) / 1500) % 20) }),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subagents-demo", {
    description: "Open the synthetic inspector demo (no models or child processes)",
    async handler(_args, ctx) { await showInspector(ctx, demoSource()); },
  });
}
