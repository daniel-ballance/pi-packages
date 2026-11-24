// Stand in for T3's supervised bridge. Register before p3stack, as T3 does.
import { Type } from "typebox";
const delegate = "mcp__t3-code__delegate_task";
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === delegate && !await ctx.ui.confirm(`Allow ${delegate}?`, JSON.stringify(event.input, null, 2).slice(0, 4000))) {
      return { block: true, reason: "declined" };
    }
  });
  pi.registerTool({ name: delegate, label: "Delegate", description: "Record transport input without starting a child.",
    parameters: Type.Object({ task: Type.String(), role: Type.String() }), async execute(_id, input) {
      return { content: [{ type: "text", text: input.task }], details: input };
    } });
  pi.registerTool({ name: "mcp__t3-code__orchestrator_capabilities", label: "Catalog", description: "Fixture catalog",
    parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: '{"providers":[]}' }], details: {} }; } });
}
