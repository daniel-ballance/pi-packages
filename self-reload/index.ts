import process from "node:process";
import type { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// pi.events belongs to the old runtime and cannot be used after ctx.reload().
// A process-local event bridges only the completion signal to the NEW instance.
const bridge: EventEmitter = process;
const COMPLETED = "pi-extensions:self-reload:completed:v1";
interface Completion {
  sessionId: string;
  continuation: string;
}

export default function selfReload(pi: ExtensionAPI) {
  let unsubscribe: (() => void) | undefined;
  let pending = false;

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    const sessionId = ctx.sessionManager.getSessionId();
    const completed = (event: Completion) => {
      if (event.sessionId !== sessionId) return;
      // This closure belongs to the new runtime. The old command invokes it
      // only after reload (including resource discovery) has actually returned.
      pi.sendMessage({
        customType: "self-reload",
        content: "Self-reload completed. The new extension runtime is active. " +
          "This does not guarantee every extension loaded successfully; verify the expected tools.\n\n" +
          event.continuation,
        display: true,
      }, { triggerTurn: true, deliverAs: "followUp" });
    };
    bridge.on(COMPLETED, completed);
    unsubscribe = () => bridge.off(COMPLETED, completed);
  });

  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  pi.registerCommand("self-reload", {
    description: "Reload Pi resources, then continue with an optional instruction",
    handler: async (args, ctx) => {
      if (pending) throw new Error("A self-reload is already pending.");
      pending = true;
      // Capture plain data only. Neither old pi nor old ctx is used after reload.
      const completion: Completion = {
        sessionId: ctx.sessionManager.getSessionId(),
        continuation: args.trim() || "Verify the expected tools are available, then continue the task. Do not reload again unless needed.",
      };
      try {
        await ctx.waitForIdle();
        await ctx.reload();
      } catch (error) {
        pending = false;
        throw error;
      }
      bridge.emit(COMPLETED, completion);
    },
  });

  pi.registerTool({
    name: "self_reload",
    label: "Self Reload",
    renderCall(args, theme, context) {
      const raw = typeof args?.continuation === "string"
        ? stripVTControlCharacters(args.continuation).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()
        : "";
      const continuation = raw.length > (context?.expanded ? 240 : 80) ? `${raw.slice(0, context?.expanded ? 240 : 80)}...` : raw;
      let text = theme.fg("toolTitle", theme.bold("self reload"));
      if (args?.continuation != null && typeof args.continuation !== "string") text += " " + theme.fg("error", "[invalid arg]");
      else if (continuation) text += " " + theme.fg("accent", continuation);
      else if (!context?.argsComplete) text += " " + theme.fg("toolOutput", "...");
      const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(text);
      return component;
    },
    description: "Request a reload of Pi extensions, skills, prompts, themes, and context files. " +
      "Ends the current run, then resumes with a completion message from the new runtime. " +
      "Call alone, after saving changes and running checks. The immediate result means queued, not completed. " +
      "Reload runs extension shutdown hooks and may stop extension-owned processes. TUI and RPC only.",
    parameters: Type.Object({
      continuation: Type.String({ minLength: 1, description: "What to verify or do after the reload." }),
    }),
    async execute(_id, { continuation }, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        throw new Error("self_reload requires interactive or RPC mode.");
      }
      if (pending) throw new Error("A self-reload is already pending.");
      if (!continuation.trim()) throw new Error("Provide a non-empty continuation instruction.");
      // Extension commands dispatch immediately with expansion enabled. The
      // handler waits for idle; never await that handler from inside this tool.
      pi.sendUserMessage(`/self-reload ${continuation}`, {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
      return {
        content: [{ type: "text" as const, text: "Self-reload requested. Stop this run; the new runtime will confirm completion and continue." }],
        details: { status: "queued" },
        terminate: true,
      };
    },
  });
}
