// T3 v0.1.11 made Pi's underscore aliases callable by the model without declaring them.
export function isT3Tool(toolName: string, name: string): boolean {
  return toolName === `mcp__t3-code__${name}` || toolName === `mcp__t3_code__${name}`;
}
