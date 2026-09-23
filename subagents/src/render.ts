import { stripVTControlCharacters } from "node:util";
import { keyText, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { formatFooterStats, reportedCost } from "./usage.js";

type Data = Record<string, unknown>;
type Action = "catalog" | "spawn" | "list" | "send" | "read" | "wait" | "abort" | "close" | "resume" | "respond" | "connect" | "disconnect" | "renew" | "peers" | "workflow";
type Color = Parameters<Theme["fg"]>[0];
const titles: Record<Action, string> = {
  catalog: "Subagent catalog", spawn: "Spawn subagent", list: "Subagents", send: "Message subagent",
  read: "Read subagent", wait: "Wait for subagents", abort: "Abort subagent work",
  close: "Close subagent", resume: "Resume subagent", respond: "Respond to subagent",
  connect: "Connect peers", disconnect: "Disconnect peers", renew: "Renew peer allowance", peers: "Peer exchanges", workflow: "Workflow",
};
const object = (value: unknown): Data | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
// Child names, tasks and output are untrusted terminal text, not ANSI styling.
const plain = (value: unknown): string => typeof value === "string"
  ? stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") : "";
const inline = (value: unknown): string => plain(value).replace(/\s+/g, " ").trim();

/** Stateless layout: re-evaluate theme and terminal width on every render. */
function component(layout: (width: number) => string[]): Component {
  return {
    invalidate() {},
    render(width) {
      if (width < 1) return [];
      return layout(width).map(line => truncateToWidth(line, width));
    },
  };
}

function preview(text: string, width: number, theme: Theme, color: Color = "toolOutput", limit = 4): string[] {
  const lines = wrapTextWithAnsi(plain(text), width);
  const shown = lines.slice(0, limit).map(line => theme.fg(color, line));
  if (lines.length > limit) shown.push(theme.fg("dim", "… more in details"));
  return shown;
}

function childLines(child: Data, theme: Theme): string[] {
  const status = inline(child.status) || "unknown";
  const failed = status === "failed" || !!child.error;
  const waiting = status === "waiting_input";
  const active = status === "working" || status === "starting";
  const color: Color = failed ? "error" : waiting || child.aborted === true ? "warning" : active ? "accent" : status === "idle" ? "success" : "dim";
  const label = child.aborted === true && !failed ? "cancelled" : waiting ? "needs input" : status;
  const icon = failed ? "✗" : waiting ? "?" : active ? "●" : status === "idle" ? "✓" : "○";
  const lines = [theme.fg(color, `${icon} ${label}`) + "  " + theme.bold(inline(child.name) || inline(child.id) || "Subagent") +
    (child.name && child.id ? theme.fg("dim", `  ${inline(child.id)}`) : "")];
  const usage = object(child.usage);
  const turns = count(usage?.assistantMessages);
  const model = inline(child.model);
  const metadata = [model ? `${model}${child.thinking ? `:${inline(child.thinking)}` : ""}` : "",
    turns === undefined ? "" : `${turns} ${turns === 1 ? "turn" : "turns"}`].filter(Boolean);
  if (metadata.length) lines.push(theme.fg("dim", metadata.join(" · ")));
  if (usage) {
    const cost = reportedCost(usage);
    const stats = formatFooterStats(usage) || (cost === undefined ? "" : `$${cost.toFixed(3)}`);
    lines.push(theme.fg("muted", `${stats}${cost === undefined ? `${stats ? " · " : ""}cost unknown` : ""}`));
  }
  if (child.error) lines.push(theme.fg("error", inline(child.error)));
  if (count(child.unread)) lines.push(theme.fg("accent", `${child.unread} unread report(s)`));
  const requests = array(child.uiRequests);
  if (requests.length) lines.push(theme.fg("warning", `${requests.length} pending input request(s)`));
  return lines;
}

function catalogLines(data: Data, theme: Theme): string[] {
  const models = array(data.models);
  const tools = array(data.tools);
  const enabled = data.spawnEnabled === true;
  const lines = [theme.fg(enabled ? "success" : "warning", enabled ? "✓ Ready to spawn" : "○ Spawning disabled") +
    theme.fg("muted", ` · ${models.length} model options · ${tools.length} tools${count(data.maxChildren) !== undefined ? ` · max ${data.maxChildren} children` : ""}`)];
  if (data.error) lines.push(theme.fg("error", inline(data.error)));
  for (const model of models.slice(0, 5)) lines.push(theme.fg("accent", `  ${inline(object(model)?.id)}`));
  if (models.length > 5) lines.push(theme.fg("dim", `  … ${models.length - 5} more model options`));
  if (tools.length) lines.push(theme.fg("dim", `Tools: ${tools.slice(0, 8).map(inline).join(", ")}${tools.length > 8 ? ", …" : ""}`));
  if (count(data.omittedEntries)) lines.push(theme.fg("warning", `${data.omittedEntries} unavailable option(s) · /subagents diagnostics`));
  return lines;
}

function groupLines(data: Data, theme: Theme): string[] {
  const children = array(data.agents).map(object).filter((child): child is Data => !!child);
  const lines: string[] = [];
  if (data.needsInput === true) lines.push(theme.fg("warning", "Input required · waiting stopped"));
  if (data.timedOut === true) lines.push(theme.fg("warning", "Wait timed out · children may still be working"));
  const totals = object(data.totals);
  if (totals) {
    const totalCost = reportedCost({ cost: totals.reportedCost });
    lines.push(theme.fg("muted", `${count(totals.active) ?? "?"} active / ${count(totals.tracked) ?? children.length} tracked` +
      ` · ${totalCost === undefined ? "cost unknown" : `$${totalCost.toFixed(3)}`}` +
      (count(totals.missingCost) ? ` · ${totals.missingCost} cost unknown` : "")));
  }
  if (!children.length) lines.push(theme.fg("dim", "No subagents tracked."));
  for (const child of children.slice(0, 4)) lines.push(...childLines(child, theme));
  if (children.length > 4) {
    const hidden = children.slice(4);
    const attention = hidden.filter(child => child.error || child.status === "failed" || child.status === "waiting_input" || array(child.uiRequests).length).length;
    lines.push(theme.fg(attention ? "warning" : "dim", `… ${hidden.length} more children${attention ? ` (${attention} need attention)` : ""}`));
  }
  return lines;
}

function workflowLines(data: Data, theme: Theme): string[] {
  const runs = data.id ? [data] : array(data.runs).map(object).filter((r): r is Data => !!r);
  const lines: string[] = [];
  for (const run of runs.slice(0, 4)) {
    lines.push(theme.fg(run.status === "succeeded" ? "success" : run.status === "running" ? "accent" : "warning", `${inline(run.name)} · ${inline(run.status)} · ${inline(run.id)}`));
    const limits = object(run.limits);
    lines.push(theme.fg("muted", `${count(run.usedAttempts) ?? 0}/${count(limits?.maxAttempts) ?? "?"} attempts · ${count(run.remainingSeconds) ?? "?"}s remaining`));
    if (run.reason) lines.push(theme.fg("dim", inline(run.reason)));
    for (const step of array(run.steps).map(object).filter((s): s is Data => !!s).slice(0, 6)) {
      lines.push(theme.fg("muted", `  ${inline(step.id)} · ${inline(step.status)} · iteration ${count(step.iteration) ?? 0}${step.activity ? ` · ${inline(step.activity)}` : ""}`));
    }
  }
  if (runs.length > 4) lines.push(theme.fg("dim", `… ${runs.length - 4} more workflows`));
  return lines.length ? lines : [theme.fg("dim", "No workflows tracked.")];
}

function peerLines(data: Data, theme: Theme): string[] {
  const links = data.a ? [data] : array(data.links).map(object).filter((l): l is Data => !!l);
  const lines: string[] = [];
  for (const link of links.slice(0, 4)) {
    const ab = object(link.ab), ba = object(link.ba);
    lines.push(theme.fg(link.enabled ? "success" : "dim", `${inline(link.a)} ↔ ${inline(link.b)} · ${link.enabled ? "connected" : "disconnected"}`));
    lines.push(theme.fg("muted", `  → ${count(ab?.used) ?? "?"}/${count(ab?.limit) ?? "?"} used · ← ${count(ba?.used) ?? "?"}/${count(ba?.limit) ?? "?"} used`));
  }
  if (links.length > 4) lines.push(theme.fg("dim", `… ${links.length - 4} more links`));
  if (data.sender) lines.push(theme.fg("success", `${inline(data.sender)} → ${inline(data.recipient)} · generation ${count(data.generation) ?? "?"} · ${count(data.remaining) ?? "?"} remaining`));
  const messages = array(data.messages).map(object).filter((m): m is Data => !!m);
  for (const m of messages) lines.push(theme.fg("muted", `${inline(m.sender)} → ${inline(m.recipient)} · ${inline(m.status)} · ${inline(m.id)}`));
  if (data.gap) lines.push(theme.fg("warning", "History gap · older exchanges no longer retained"));
  if (data.hasMore) lines.push(theme.fg("warning", `More exchanges · continue from cursor ${count(data.nextCursor) ?? "?"}`));
  return lines.length ? lines : [theme.fg("dim", "No peer links or exchanges.")];
}

function readLines(data: Data, width: number, theme: Theme): string[] {
  const lines = childLines(data, theme);
  if (data.gap === true) lines.push(theme.fg("warning", "History gap · some older updates are no longer retained"));
  if (data.hasMore === true) lines.push(theme.fg("warning", "More unread updates available · read again"));
  const updates = array(data.updates).map(object).filter((update): update is Data => !!update);
  const errors = updates.filter(update => ["error", "extension_error", "failure"].includes(String(update.kind)));
  if (errors.length) lines.push(...preview(inline(errors.at(-1)?.kind) + ": " + plain(errors.at(-1)?.text), width, theme, "error", 2));
  const reply = updates.findLast(update => update.kind === "assistant" && plain(update.text).trim());
  if (reply) lines.push(...preview(plain(reply.text), width, theme));
  else {
    const report = updates.findLast(update => ["aborted", "completed", "input_requested"].includes(String(update.kind)));
    if (report) lines.push(...preview(plain(report.text), width, theme, "muted", 2));
    else if (!errors.length) lines.push(theme.fg("dim", updates.length ? "No new assistant reply." : "No new updates."));
  }
  if (updates.length > 1) lines.push(theme.fg("dim", `${updates.length} updates · latest reply shown when available`));
  return lines;
}

/** UI-only adapters. Never mutate results, read files, or acknowledge child updates. */
export function subagentRenderers(action: Action): Required<Pick<ToolDefinition, "renderCall" | "renderResult">> {
  return {
    renderCall(args, theme) {
      return component(() => {
        const data = object(args) ?? {};
        const target = inline(data.name) || inline(data.id) || (data.a ? `${inline(data.a)} ↔ ${inline(data.b)}` : data.sender ? `${inline(data.sender)} → ${inline(data.recipient)}` : "");
        const scope = action === "wait" ? `${array(data.ids).length || "all"} children · ${inline(data.mode) || "all"} · ${count(data.timeoutSeconds) ?? 30}s` : target;
        return [theme.fg("toolTitle", theme.bold(titles[action])) + (scope ? theme.fg("dim", `  ${scope}`) : "")];
      });
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return component(width => {
        const raw = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const data = object(result.details);
        let lines: string[];
        if (context?.isError) lines = preview(raw || "Tool failed", width, theme, "error");
        else if (isPartial) lines = [theme.fg("warning", "Updating…")];
        else if (typeof data?.fullResult === "string") {
          lines = [theme.fg("warning", "Result truncated · full output saved to file"), ...preview(data.fullResult, width, theme, "dim", 3)];
        } else if (!data) lines = preview(raw || "No result data.", width, theme);
        else if (action === "catalog") lines = catalogLines(data, theme);
        else if (action === "workflow") lines = workflowLines(data, theme);
        else if (action === "list" || action === "wait") lines = groupLines(data, theme);
        else if (action === "read") lines = readLines(data, width, theme);
        else if (["connect", "disconnect", "renew", "peers"].includes(action)) lines = peerLines(data, theme);
        else {
          lines = childLines(data, theme);
          if (action === "spawn" && data.task) lines.push(theme.fg("dim", `Task: ${inline(data.task)}`));
        }
        if (expanded && raw) {
          lines.push("", theme.fg("dim", "Full result"));
          lines.push(...wrapTextWithAnsi(plain(raw), width).map(line => theme.fg("dim", line)));
        } else if (!isPartial) {
          const key = keyText("app.tools.expand");
          lines.push(theme.fg("dim", `↳ ${key ? `${key} · ` : ""}expand for details`));
        }
        return lines;
      });
    },
  };
}
