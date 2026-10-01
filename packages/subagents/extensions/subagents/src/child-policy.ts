/** Secret-free policy carried to the child. No endpoint/config/credential copies. */
export const BUILTINS = ["builtin:codemode", "builtin:tool-search", "builtin:mcp"] as const;
export type Builtin = typeof BUILTINS[number];
export interface ChildSettings {
  codemode?: { mode?: "on" | "only"; inlineBudget?: number };
  cacheWarming?: "off";
}
export interface McpGrant { name: string; tools: string[]; project: boolean }
export interface McpPolicy { servers: McpGrant[]; inheritCredentials: boolean }
export interface ChildPolicy {
  version: 1;
  builtins: Builtin[];
  toolSources: Record<string, string>;
  model: string;
  settings: ChildSettings;
  mcp: McpPolicy;
  agentDir: string;
  projectTrusted: boolean;
}
export function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  return value as Record<string, unknown>;
}
export function parseChildSettings(value: unknown): ChildSettings {
  if (value === undefined) return {};
  const v = object(value, ["codemode", "cacheWarming"], "childSettings");
  if (v.cacheWarming !== undefined && v.cacheWarming !== "off") throw new Error("childSettings.cacheWarming only supports off");
  const result: ChildSettings = {};
  if (v.cacheWarming === "off") result.cacheWarming = "off";
  if (v.codemode !== undefined) {
    const c = object(v.codemode, ["mode", "inlineBudget"], "childSettings.codemode");
    if (c.mode !== undefined && c.mode !== "on" && c.mode !== "only") throw new Error("codemode.mode must be on or only");
    if (c.inlineBudget !== undefined && (typeof c.inlineBudget !== "number" || !Number.isSafeInteger(c.inlineBudget) || c.inlineBudget < 0)) throw new Error("codemode.inlineBudget must be a nonnegative safe integer");
    result.codemode = c as ChildSettings["codemode"];
  }
  return result;
}
export function parseMcpPolicy(value: unknown): McpPolicy {
  if (value === undefined) return { servers: [], inheritCredentials: false };
  const v = object(value, ["servers", "inheritCredentials"], "mcp");
  if (v.inheritCredentials !== undefined && typeof v.inheritCredentials !== "boolean") throw new Error("mcp.inheritCredentials must be boolean");
  if (v.servers !== undefined && !Array.isArray(v.servers)) throw new Error("mcp.servers must be an array");
  const names = new Set<string>();
  const servers = ((v.servers ?? []) as unknown[]).map(value => {
    const s = object(value, ["name", "tools", "project"], "mcp server");
    if (typeof s.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(s.name)) throw new Error("Invalid MCP server name");
    const normalized = s.name.replaceAll("-", "_");
    if (names.has(normalized)) throw new Error("Duplicate or normalized-colliding MCP server names");
    names.add(normalized);
    if (!Array.isArray(s.tools) || s.tools.some(t => typeof t !== "string" || !t.trim() || t.startsWith("subagent_") || t.slice(0, -1).includes("*"))) throw new Error("MCP tools must be exact raw names or trailing-* patterns; recursive tools are forbidden");
    if (s.project !== undefined && typeof s.project !== "boolean") throw new Error("mcp server.project must be boolean");
    return { name: s.name, tools: [...new Set(s.tools as string[])], project: s.project === true };
  });
  return { servers, inheritCredentials: v.inheritCredentials === true };
}
export function permitsMcpTool(grant: McpGrant, raw: string) {
  if (raw.startsWith("subagent_")) return false;
  return grant.tools.some(pattern => pattern.endsWith("*") ? raw.startsWith(pattern.slice(0, -1)) : raw === pattern);
}
