import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./src/models.js";
import { Antigravity } from "./src/provider.js";
import { registerStandIn } from "./src/stand-in.js";
import { WAKE_TYPE, wakeNote } from "./src/transcript.js";

export default function antigravity(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const bridge = new Antigravity({ bindPi(scope) {
    const ctx = context;
    if (!ctx || ctx.sessionManager.getSessionId() !== scope) return;
    return { cwd: ctx.cwd, tools: pi, wake(id) {
      if (!ctx.isIdle() || ctx.model?.provider !== PROVIDER_ID) return false;
      pi.sendMessage({ customType: WAKE_TYPE, content: wakeNote(id), display: false }, { triggerTurn: true });
      return true;
    } };
  } });
  registerStandIn(pi, bridge, () => queueMicrotask(() => {
    if (context) bridge.refreshTools(context.sessionManager.getSessionId());
  }));
  pi.registerProvider(bridge.provider);
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("model_select", (_event, ctx) => { context = ctx; });
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; bridge.refreshTools(ctx.sessionManager.getSessionId()); });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.isError) bridge.rejectUnexecuted(ctx.sessionManager.getSessionId(), event.toolCallId);
  });
  pi.on("agent_settled", (_event, ctx) => { context = ctx; return bridge.settled(ctx.sessionManager.getSessionId()); });
  pi.on("session_shutdown", async () => { context = undefined; await bridge.closeSessions(); });
}
