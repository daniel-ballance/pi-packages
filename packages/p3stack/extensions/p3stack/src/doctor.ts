import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir } from "./roles.ts";

export function doctor(pi: { getAllTools(): { name: string; exposure?: string }[] }) {
  const path = process.env.T3_PI_MCP_EXTENSION_PATH;
  const extensions = process.argv.flatMap((arg, index, args) => {
    if (arg === "-e" || arg === "--extension") return args[index + 1] ? [resolve(args[index + 1]!)] : [];
    return arg.startsWith("--extension=") ? [resolve(arg.slice("--extension=".length))] : [];
  });
  const bridge = path ? extensions.indexOf(resolve(path)) : -1;
  const provider = extensions.findIndex(path => /[/\\]claude-subscription[/\\](?:index\.[cm]?[jt]s)$/.test(path));
  let sha256: string | null = null;
  const problems: string[] = [];
  if (path) {
    try { sha256 = createHash("sha256").update(readFileSync(path)).digest("hex"); }
    catch (error) { problems.push(`Cannot hash ${path}, ${String(error)}`); }
  } else problems.push("T3_PI_MCP_EXTENSION_PATH is not set");
  const report = {
    tools: pi.getAllTools().filter(tool => tool.name.startsWith("mcp__t3-code__")).map(tool => ({ name: tool.name, exposure: tool.exposure ?? "direct" })),
    extension: { path: path ?? null, sha256 },
    claudeSubscriptionBeforeBridge: provider >= 0 && bridge > provider,
    problems,
  };
  const file = join(agentDir(), "p3stack", "t3-contract.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}
