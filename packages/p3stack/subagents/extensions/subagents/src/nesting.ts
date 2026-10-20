// Bounded nesting: a Child below the policy's maxDepth may manage its own
// subtree through proxied tools. Every call travels over the Child's private
// pipe to the one root Manager, which owns the whole tree and checks scope.

/** The subagent tools a Child can be given; everything else stays parent-only. */
export const PROXIED_TOOLS = ["subagent_catalog", "subagent_spawn", "subagent_send", "subagent_wait", "subagent_read", "subagent_close", "subagent_list"] as const;
export type ProxiedTool = typeof PROXIED_TOOLS[number];
export const isProxiedTool = (name: string): name is ProxiedTool => (PROXIED_TOOLS as readonly string[]).includes(name);

export type ManagementOp = "catalog" | "spawn" | "send" | "wait" | "read" | "close" | "list";
export const opOf = (tool: ProxiedTool) => tool.slice("subagent_".length) as ManagementOp;
const OPS = new Set<string>(PROXIED_TOOLS.map(opOf));
export const isManagementOp = (value: unknown): value is ManagementOp => typeof value === "string" && OPS.has(value);

/** Largest delegated reply: the private pipe caps frames at 64 KiB, envelope included. */
export const DELEGATED_REPLY_BYTES = 60_000;

/** A reply that fits one frame as sent (compact JSON), else a preview that does and a way to narrow. */
export function fitDelegatedReply(data: unknown, limit = DELEGATED_REPLY_BYTES): unknown {
  const text = JSON.stringify(data) ?? "null";
  if (Buffer.byteLength(text) <= limit) return data;
  const room = limit - 1024;
  let length = room;
  while (length > 0 && Buffer.byteLength(JSON.stringify(text.slice(0, length))) > room) length = Math.floor(length * 0.8);
  return { truncated: true, note: "Reply too large for delegation; narrow it (pass ids or since, or read one Child at a time).", preview: text.slice(0, length) };
}
