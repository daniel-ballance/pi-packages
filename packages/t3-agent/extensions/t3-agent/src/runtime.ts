// Facts about the T3 launch that every module reads. T3's injected bridge
// (pi-t3-mcp-extension.ts) owns the MCP connection and the permission hook;
// this package only reads the same environment it sets.

export type Environment = Readonly<Record<string, string | undefined>>;
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** Public prefix of the bridge's tools. `mcp__t3_code__` names are hidden duplicates. */
export const T3_PREFIX = "mcp__t3-code__";
const T3_NAME = /^mcp__t3[-_]code__([a-z][a-z0-9_]*)$/;

/** The bare T3 tool name (`delegate_task`) for a bridge tool name, else undefined. */
export function t3ToolName(toolName: string): string | undefined {
  return T3_NAME.exec(toolName)?.[1];
}

/** Mirrors the bridge: an unknown or missing value means full access. */
export function runtimeMode(env: Environment = process.env): RuntimeMode {
  const value = env.T3_PI_RUNTIME_MODE;
  return value === "approval-required" || value === "auto-accept-edits" || value === "auto" || value === "full-access"
    ? value
    : "full-access";
}

/** The bridge confirms these tools in every mode except full access. */
export function asksForBash(mode: RuntimeMode): boolean {
  return mode !== "full-access";
}

/** The bridge confirms edit and write unless the mode accepts edits or grants full access. */
export function asksForEdits(mode: RuntimeMode): boolean {
  return mode === "approval-required" || mode === "auto";
}

/** T3 shows Pi's stored `auto` as Supervised, because the bridge confirms every non-read-only call. */
export function modeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case "full-access": return "full access";
    case "auto-accept-edits": return "auto-accept edits";
    default: return "supervised";
  }
}

/**
 * T3 Code 0.1.9 builds the composer's `/` menu from a short-lived `pi --mode rpc --no-session --offline`
 * that it starts without T3_MCP_URL but under its own `T3CODE_*` environment. That process runs no session.
 */
export function isT3CommandDiscovery(env: Environment = process.env, argv: readonly string[] = process.argv): boolean {
  if (env.T3_MCP_URL) return false;
  const mode = argv.indexOf("--mode");
  return mode >= 0 && argv[mode + 1] === "rpc" && argv.includes("--no-session") && argv.includes("--offline") &&
    Object.keys(env).some(name => name.startsWith("T3CODE_") && env[name]);
}
