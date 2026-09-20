import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Always loaded by the manager. Independent of configurable resource choices. */
export default function childGuard(pi: ExtensionAPI) {
  const configured: unknown = JSON.parse(process.env.PI_SUBAGENT_ALLOWED_TOOLS ?? "[]");
  if (!Array.isArray(configured) || configured.some(v => typeof v !== "string")) throw new Error("Invalid child tool policy");
  const allowed = new Set<string>(configured.filter(name => !name.startsWith("subagent_")));
  const apply = () => pi.setActiveTools(pi.getActiveTools().filter(name => allowed.has(name) && !name.startsWith("subagent_")));
  pi.on("session_start", apply);
  pi.on("before_agent_start", apply);
  pi.on("context", apply);
  pi.on("tool_result", apply);
  // A resource can dynamically reactivate a tool; still block execution.
  pi.on("tool_call", event => {
    if (event.toolName.startsWith("subagent_") || !allowed.has(event.toolName)) {
      return { block: true, reason: "Tool excluded by managed child policy; recursive subagents are disabled." };
    }
  });
  pi.registerCommand("_child-policy-check", {
    description: "Report effective child tools to the parent manager (no model call)",
    handler: async () => {
      apply();
      pi.sendMessage({ customType: "child-policy-check", content: "Child tool policy checked.", display: false, details: { tools: pi.getActiveTools() } });
    },
  });
}
