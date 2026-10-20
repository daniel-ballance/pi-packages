import { SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Context } from "./mode.ts";
import { agentDir } from "./roles.ts";

const formatTokens = (count: number) => {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
};

export function modeFooter(ctx: Context): NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]> {
  return (tui, theme, footerData) => ({
    dispose: footerData.onBranchChange(() => tui.requestRender()),
    invalidate() {},
    render(width) {
      const model = ctx.model;
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      let latestCacheHitRate: number | undefined;
      for (const entry of ctx.sessionManager.getEntries()) {
        const usage = entry.type === "usage" ? entry.usage
          : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage
          : entry.type === "branch_summary" || entry.type === "compaction" ? entry.usage : undefined;
        if (usage) {
          totals.input += usage.input;
          totals.output += usage.output;
          totals.cacheRead += usage.cacheRead;
          totals.cacheWrite += usage.cacheWrite;
          totals.cost += usage.cost.total;
        }
        if (entry.type === "message" && entry.message.role === "assistant") {
          const usage = entry.message.usage, promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
          latestCacheHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens * 100 : undefined;
        }
      }
      let pwd = ctx.cwd;
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        const fromHome = relative(resolve(home), resolve(pwd));
        if (fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome))) pwd = fromHome ? `~${sep}${fromHome}` : "~";
      }
      const branch = footerData.getGitBranch(), name = ctx.sessionManager.getSessionName();
      if (branch) pwd += ` (${branch})`;
      if (name) pwd += ` • ${name}`;
      const parts: string[] = [];
      if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
      if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
      if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
      if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
      if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
      const subscription = model && (model.provider === "kimi-coding" || (ctx.modelRegistry.isUsingOAuth(model) && ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true));
      if (totals.cost || subscription) parts.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
      const usage = ctx.getContextUsage(), percent = usage?.percent ?? 0;
      const auto = SettingsManager.create(ctx.cwd, agentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionEnabled() ? " (auto)" : "";
      const window = formatTokens(usage?.contextWindow ?? model?.contextWindow ?? 0);
      let context = usage?.percent !== null ? `${percent.toFixed(1)}%/${window}${auto}` : `?/${window}${auto}`;
      if (percent > 90) context = theme.fg("error", context);
      else if (percent > 70) context = theme.fg("warning", context);
      parts.push(context);
      if (process.env.PI_EXPERIMENTAL === "1") parts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
      let left = parts.join(" ");
      if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
      const leftWidth = visibleWidth(left);
      let right = model?.id || "no-model";
      if (model?.reasoning) right += ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` • ${ctx.thinkingLevel}` : " • thinking off";
      if (model?.api === "pi-virtual") {
        const latest = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted");
        if (latest?.type === "message" && latest.message.role === "assistant" && ctx.modelRegistry.find(latest.message.provider, latest.message.model)) {
          right += ` → ${latest.message.model}${latest.message.thinkingLevel ? ` • ${latest.message.thinkingLevel}` : ""}`;
        }
      }
      if (model && footerData.getAvailableProviderCount() > 1) {
        const withProvider = `(${model.provider}) ${right}`;
        if (leftWidth + 2 + visibleWidth(withProvider) <= width) right = withProvider;
      }
      let remainder = "";
      if (leftWidth + 2 + visibleWidth(right) <= width) remainder = " ".repeat(width - leftWidth - visibleWidth(right)) + right;
      else if (width - leftWidth - 2 > 0) {
        right = truncateToWidth(right, width - leftWidth - 2, "");
        remainder = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(right))) + right;
      }
      const lines = [truncateToWidth(`🅿️ ${theme.fg("dim", pwd)}`, width, theme.fg("dim", "...")), theme.fg("dim", left) + theme.fg("dim", remainder)];
      const statuses = footerData.getExtensionStatuses();
      if (statuses.size) {
        const text = [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()).join(" ");
        lines.push(truncateToWidth(text, width, theme.fg("dim", "...")));
      }
      return lines;
    },
  });
}
