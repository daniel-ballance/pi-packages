import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Tasks } from "./src/tasks.js";
import { result } from "./src/result.js";

export default function t3Subagents(pi: ExtensionAPI) {
  // T3 owns admission, processes, permissions, notifications and cancellation.
  // No manager, timers, lifecycle hooks or extension-started parent turns.
  const tasks = new Tasks(pi);
  pi.registerTool({
    name: "t3_subagent_catalog", label: "T3 Subagent Catalog",
    description: "Read T3's live provider/model catalog, configured custom models, inherited defaults and app-owned features. This is not the native subagents.json allowlist. Select provider/model/options here before bounded T3 delegation.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _args, signal, _update, ctx) { return result(await tasks.catalog(ctx, signal), ctx); },
  });
  pi.registerTool({
    name: "t3_subagent_read", label: "T3 Read Task",
    description: "Read current T3 status and the stable original task summary; workState distinguishes working/waiting_for_children/result_available. A completed turn with live nested work is not completed task work. hasPendingChildRuns and latestTerminal* describe later backing-thread turns separately. A terminal read acknowledges T3's completion delivery. Do not poll in a loop; async completion wakes are T3-owned.",
    parameters: Type.Object({ taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, { taskId }, signal, _update, ctx) { return result(await tasks.read(ctx, taskId, signal), ctx); },
  });
  pi.registerTool({
    name: "t3_subagent_cancel", label: "T3 Cancel Task",
    description: "Request interruption and dispose T3's automatic delivery for this task. Use a stable unique clientRequestId for retries of this cancellation. cancel_requested is not confirmed termination; inspect status if needed. Cancellation scope is T3-version-dependent: some builds also stop later backing-thread runs and delegated descendants, even for terminal tasks. Consult the deployed T3 contract; this wrapper does not guarantee task-only scope or undo edits. No implicit cancellation on parent abort/shutdown.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
      clientRequestId: Type.String({ minLength: 1, maxLength: 256 }),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) { return result(await tasks.cancel(ctx, args, signal), ctx); },
  });
  pi.registerTool({
    name: "t3_subagent_delegate", label: "T3 Delegate Task",
    description: "Delegate one bounded T3-owned task asynchronously. Consult T3's live catalog first. Supply a complete brief (parent history is not copied) and a unique clientRequestId for each task/review round; reuse that exact brief/key only on an uncertain retry. No native tool/resource/cwd allowlist composition is supported; permissions and workspace inherit from T3. Aborting this call does not cancel the child. Completion wakes belong to T3.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 120000 }),
      clientRequestId: Type.String({ minLength: 1, maxLength: 256 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      target: Type.Optional(Type.Object({
        providerInstanceId: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
        options: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean()]))),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) { return result(await tasks.delegate(ctx, args, signal), ctx); },
  });
  pi.registerTool({
    name: "t3_subagent_list", label: "T3 Tracked Tasks",
    description: "List this Pi session branch's tracked T3 request/task identities and cancellation intents/receipts. Local snapshots are stale until read; this is not a list of every T3 child. Uncertain requests may already exist. Does not poll, acknowledge completion or wake the parent.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) { return result(tasks.list(ctx), ctx); },
  });
}
