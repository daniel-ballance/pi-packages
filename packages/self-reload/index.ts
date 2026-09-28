import process from "node:process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// pi.events belongs to the old runtime. Bridge plain data only; never retain its APIs.
const bridge: EventEmitter = process;
const COMPLETED = "pi-packages:self-reload:completed:v2";
interface Request {
  continuation: string;
  reason?: string;
  expectedTools?: string[];
}
interface Completion extends Request {
  sessionId: string;
  status: "reloaded" | "failed";
  error?: string;
  delivered?: boolean;
}
const clean = (text: string) => stripVTControlCharacters(text)
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

export default function selfReload(pi: ExtensionAPI) {
  let unsubscribe: (() => void) | undefined;
  let pending = false;
  let queued: { token: string; request: Request } | undefined;

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    const sessionId = ctx.sessionManager.getSessionId();
    const completed = (event: Completion) => {
      if (event.sessionId !== sessionId) return;
      ctx.ui.setStatus("self-reload", undefined);
      const active = new Set(pi.getActiveTools());
      const missingTools = event.status === "reloaded"
        ? (event.expectedTools ?? []).filter(name => !active.has(name)) : [];
      const availability = event.expectedTools?.length
        ? missingTools.length ? `Expected tools not active: ${missingTools.join(", ")}.`
          : "Expected tools are active."
        : "Tool availability has not been checked.";
      pi.sendMessage({
        customType: "self-reload",
        content: event.status === "failed"
          ? `Reload failed: ${clean(event.error ?? "Unknown error")}\n` +
            "Inspect the error and runtime before continuing. Do not automatically retry the reload. " +
            "If tools are unavailable, fix the extension and use manual /reload or restart Pi.\n\n" +
            `Intended next step (not executed): ${event.continuation}`
          : "Reload complete — conversation preserved. " + availability + " " +
            "Reload does not verify extension behavior or guarantee every extension loaded.\n\n" +
            (missingTools.length ? "Investigate the missing tools before proceeding. Do not automatically reload again.\n\n" : "Next: ") +
            event.continuation,
        details: { status: event.status, reason: event.reason, expectedTools: event.expectedTools ?? [], missingTools },
        display: true,
      }, { triggerTurn: true, deliverAs: "followUp" });
      event.delivered = true;
    };
    bridge.on(COMPLETED, completed);
    unsubscribe = () => bridge.off(COMPLETED, completed);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("self-reload", undefined);
    unsubscribe?.();
    unsubscribe = undefined;
  });

  pi.registerCommand("self-reload", {
    description: "Reload Pi resources, preserve the conversation, then continue with an optional instruction",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("self_reload requires interactive or RPC mode.");
      if (pending) throw new Error("A self-reload is already pending.");
      const request = queued?.token === args.trim() ? queued.request : undefined;
      if (queued && !request) throw new Error("A self-reload is already queued.");
      queued = undefined;
      pending = true;
      const completion: Completion = {
        ...(request ?? { continuation: args.trim() || "Verify the expected tools are available, then continue the task. Do not reload again unless needed." }),
        sessionId: ctx.sessionManager.getSessionId(),
        status: "reloaded",
      };
      try {
        // TUI already renders the tool reason and Pi's native reload banner.
        // Direct commands have no tool result, so retain their impact warning.
        if (ctx.mode === "rpc") {
          ctx.ui.notify("Reloading Pi resources" + (completion.reason ? ` — ${clean(completion.reason)}` : "") +
            ". Conversation preserved; extension-owned processes may stop.", "info");
        } else if (!request) {
          ctx.ui.notify("Conversation preserved; extension-owned processes may stop.", "info");
        }
        ctx.ui.setStatus("self-reload", "Waiting for agent to finish…");
        await ctx.waitForIdle();
        ctx.ui.setStatus("self-reload", ctx.mode === "rpc" ? "Reloading Pi resources…" : undefined);
        await ctx.reload();
      } catch (error) {
        pending = false;
        // Reload may already have invalidated ctx/pi. Let a surviving listener report failure.
        completion.status = "failed";
        completion.error = error instanceof Error ? error.message : String(error);
        bridge.emit(COMPLETED, completion);
        if (!completion.delivered) {
          throw new Error(`Reload failed: ${completion.error}. Automatic continuation unavailable; fix the extension and use manual /reload or restart Pi.`);
        }
        return;
      }
      // No old-runtime APIs after reload, including in the missing-listener case.
      bridge.emit(COMPLETED, completion);
      if (!completion.delivered) {
        throw new Error("Reload returned but automatic continuation is unavailable. Check that self-reload loaded; fix it and use manual /reload or restart Pi.");
      }
    },
  });

  pi.registerTool({
    name: "self_reload",
    label: "Self Reload",
    renderCall(args, theme, context) {
      const preview = typeof args?.reason === "string" ? clean(args.reason)
        : typeof args?.continuation === "string" ? clean(args.continuation) : "";
      let text = theme.fg("toolTitle", theme.bold("self reload"));
      if (args?.continuation != null && typeof args.continuation !== "string") text += " " + theme.fg("error", "[invalid arg]");
      else if (preview) text += " " + theme.fg("accent", context?.expanded || preview.length <= 80 ? preview : `${preview.slice(0, 80)}...`);
      else if (!context?.argsComplete) text += " " + theme.fg("toolOutput", "...");
      if (context?.expanded) {
        if (typeof args?.continuation === "string") text += "\n" + theme.fg("toolOutput", `Next: ${clean(args.continuation)}`);
        if (Array.isArray(args?.expectedTools)) text += "\n" + theme.fg("toolOutput", `Expected tools: ${args.expectedTools.filter((name: unknown) => typeof name === "string").map(clean).join(", ")}`);
      }
      const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(text);
      return component;
    },
    description: "Request a reload of Pi extensions, skills, prompts, themes, and context files; preserves the conversation. " +
      "Ends the current run, then resumes with a completion message. Call alone, after saving changes and running checks. " +
      "The immediate result means queued, not completed or verified. Inspect active subagents/workflows first and plan recovery: " +
      "reload runs shutdown hooks, stops subagent processes and stops workflow execution. TUI and RPC only.",
    parameters: Type.Object({
      continuation: Type.String({ minLength: 1, description: "What to verify or do after the reload." }),
      reason: Type.Optional(Type.String({ minLength: 1, description: "Short user-facing explanation of why a reload is needed." })),
      expectedTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Exact tool names to check are active afterward. This does not verify their behavior." })),
    }),
    async execute(_id, { continuation, reason, expectedTools }, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("self_reload requires interactive or RPC mode.");
      if (pending || queued) throw new Error("A self-reload is already pending.");
      if (!continuation.trim()) throw new Error("Provide a non-empty continuation instruction.");
      if (reason !== undefined && !reason.trim()) throw new Error("Provide a non-empty reason or omit it.");
      if (expectedTools?.some(name => !name.trim())) throw new Error("Expected tool names must not be blank.");
      const token = `request:${randomUUID()}`;
      queued = { token, request: { continuation, reason, expectedTools: expectedTools ? [...new Set(expectedTools)] : undefined } };
      try {
        // Dispatch immediately, but never await the handler: it waits for this run to finish.
        pi.sendUserMessage(`/self-reload ${token}`, { deliverAs: "followUp", expandPromptTemplates: true });
      } catch (error) {
        queued = undefined;
        throw error;
      }
      return {
        content: [{ type: "text" as const, text: "Reload queued. Conversation preserved; extension-owned processes may stop. The next run will report completion and tool-availability checks; behavior still needs verification." }],
        details: { status: "queued", reason, expectedTools: expectedTools ?? [] },
        terminate: true,
      };
    },
  });
}
