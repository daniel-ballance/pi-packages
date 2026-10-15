// Host detection shared by every package in this collection. Pi loads each
// package from its own module root, so packages carry generated copies of this
// file; edit it here and run `node scripts/sync-shared.mjs`.

export type Host = "cli" | "t3";

type Environment = Readonly<Record<string, string | undefined>>;
type Exposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

// T3 Code sets T3_MCP_URL for the Pi sessions it launches with its MCP bridge.
export function detectHost(env: Environment = process.env): Host {
  return env.T3_MCP_URL ? "t3" : "cli";
}

// Under T3, a tool that duplicates a T3 primitive is registered `deferred`:
// codemode scripts can call it and tool_search can load it, but it is not
// declared to the model beside T3's own tool. An inactive `direct` tool would be
// unreachable from both, so `defaultActive: false` is not used here.
export function registerHostAware<T extends { exposure?: Exposure }>(
  pi: { registerTool(tool: T): void },
  tool: T,
  options: { duplicatesT3: boolean; env?: Environment },
): Host {
  const host = detectHost(options.env);
  const demote = host === "t3" && options.duplicatesT3 && tool.exposure !== "hidden";
  pi.registerTool(demote ? { ...tool, exposure: "deferred" } : tool);
  return host;
}
