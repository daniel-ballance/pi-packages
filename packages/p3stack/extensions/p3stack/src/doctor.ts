import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./roles.ts";

const CLAUDE_SUBSCRIPTION = /[/\\]claude-subscription[/\\]index\.[cm]?[jt]s$/;

export function doctor(pi: {
  getAllTools(): { name: string; exposure?: string }[];
  getCommands(): { source: string; sourceInfo: { path: string } }[];
}) {
  const claudeSubscriptionFiles = [...new Set(pi.getCommands()
    .filter(command => command.source === "extension")
    .flatMap(command => {
      try { return [realpathSync(command.sourceInfo.path)]; }
      catch { return []; } // No observable file to identify.
    })
    .filter(path => CLAUDE_SUBSCRIPTION.test(path)))];
  const problems: string[] = [];
  if (claudeSubscriptionFiles.length > 1) problems.push(`claude-subscription loaded from ${claudeSubscriptionFiles.length} files; T3's --extension must name the one file the package loads`);
  const report = {
    tools: pi.getAllTools().filter(tool => tool.name.startsWith("mcp__t3-code__")).map(tool => ({ name: tool.name, exposure: tool.exposure ?? "direct" })),
    claudeSubscriptionFiles,
    problems,
  };
  const file = join(agentDir(), "p3stack", "t3-contract.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}
