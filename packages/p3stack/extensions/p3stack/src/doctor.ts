import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./roles.ts";

const CLAUDE_SUBSCRIPTION = /[/\\]claude-subscription[/\\]index\.[cm]?[jt]s$/;

export function doctor(pi: {
  getAllTools(): { name: string; exposure?: string }[];
  getCommands(): { source: string; sourceInfo: { path: string } }[];
}) {
  const path = process.env.T3_PI_MCP_EXTENSION_PATH;
  const claudeSubscriptionFiles = [...new Set(pi.getCommands()
    .filter(command => command.source === "extension")
    .flatMap(command => {
      try { return [realpathSync(command.sourceInfo.path)]; }
      catch { return []; } // No observable file to identify.
    })
    .filter(path => CLAUDE_SUBSCRIPTION.test(path)))];
  let sha256: string | null = null;
  const problems: string[] = [];
  if (path) {
    try { sha256 = createHash("sha256").update(readFileSync(path)).digest("hex"); }
    catch (error) { problems.push(`Cannot hash ${path}, ${String(error)}`); }
  } else problems.push("T3_PI_MCP_EXTENSION_PATH is not set");
  if (claudeSubscriptionFiles.length > 1) problems.push(`claude-subscription loaded from ${claudeSubscriptionFiles.length} files; T3's --extension must name the one file the package loads`);
  const report = {
    tools: pi.getAllTools().filter(tool => tool.name.startsWith("mcp__t3-code__")).map(tool => ({ name: tool.name, exposure: tool.exposure ?? "direct" })),
    extension: { path: path ?? null, sha256 },
    claudeSubscriptionFiles,
    problems,
  };
  const file = join(agentDir(), "p3stack", "t3-contract.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}
