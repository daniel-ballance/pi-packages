import { homedir } from "node:os";
import { sep } from "node:path";
import { keyText, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { cardLines, cardsFromDetails, inline, paint, plain, STATES } from "./card.js";
import { limitLabel } from "./child-limit.js";
import { reportedCost } from "./usage.js";

type Data = Record<string, unknown>;
type Action = "catalog" | "loop" | "spawn" | "list" | "send" | "read" | "wait" | "abort" | "close" | "release-hold" | "resume" | "respond" | "connect" | "disconnect" | "renew" | "peers" | "workflow" | "workflow-start" | "workflow-inspect" | "workflow-control";
type Color = Parameters<Theme["fg"]>[0];
export type NameLookup = (kind: "child" | "workflow", id: string) => string | undefined;
const workflowAction = (action: Action) => action === "workflow" || action.startsWith("workflow-");
const object = (value: unknown): Data | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

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

function overlapLines(child: Data, theme: Theme): string[] {
  return array(child.coordinationWarnings).slice(0, 3).map(object).map(warning => theme.fg("warning",
    `work-area overlap: ${inline(warning?.path) || inline(warning?.requestedPath)} · ${(inline(warning?.name) || inline(warning?.ownerName)).toLowerCase()}`));
}

function catalogLines(data: Data, theme: Theme): string[] {
  const models = array(data.models);
  const tools = array(data.tools);
  const enabled = data.spawnEnabled === true;
  const childLimit = limitLabel(data.maxChildren);
  const lines = [theme.fg(enabled ? "success" : "warning", enabled ? "✓ ready to spawn" : "○ spawning disabled") +
    theme.fg("muted", ` · ${models.length} model options · ${tools.length} tools${childLimit ? ` · ${childLimit}` : ""}`)];
  if (data.error) lines.push(theme.fg("error", inline(data.error)));
  for (const model of models.slice(0, 5)) lines.push(theme.fg("accent", `  ${inline(object(model)?.id)}`));
  if (models.length > 5) lines.push(theme.fg("dim", `  … ${models.length - 5} more model options`));
  if (tools.length) lines.push(theme.fg("dim", `tools: ${tools.slice(0, 8).map(inline).join(", ")}${tools.length > 8 ? ", …" : ""}`));
  const always = [...array(data.alwaysExtensions), ...array(data.alwaysTools)].map(inline);
  if (always.length) lines.push(theme.fg("dim", `always loaded: ${always.slice(0, 6).join(", ")}${always.length > 6 ? ", …" : ""}`));
  if (count(data.omittedEntries)) lines.push(theme.fg("warning", `${data.omittedEntries} unavailable option(s) · /subagents diagnostics`));
  return lines;
}

function groupLines(data: Data, width: number, theme: Theme): string[] {
  const children = cardsFromDetails(array(data.agents), "summary");
  const lines: string[] = [];
  if (data.needsInput === true) lines.push(theme.fg("warning", "input required · waiting stopped"));
  if (data.needsHold === true) lines.push(theme.fg("warning", "human hold · discuss before releasing work"));
  if (array(data.reports).length) lines.push(theme.fg("accent", `${array(data.reports).length} report page(s) collected`));
  if (data.hasMoreReports === true) lines.push(theme.fg("warning", "more reports remain · read deferred children"));
  if (data.timedOut === true) lines.push(theme.fg("warning", "wait timed out · children may still be working"));
  const totals = object(data.totals);
  if (totals) {
    const totalCost = reportedCost({ cost: totals.reportedCost });
    lines.push(theme.fg("muted", `${count(totals.active) ?? "?"} active / ${count(totals.tracked) ?? children.length} tracked` +
      ` · ${totalCost === undefined ? "cost unknown" : `$${totalCost.toFixed(3)}`}` +
      (count(totals.missingCost) ? ` · ${totals.missingCost} cost unknown` : "")));
  }
  if (!children.length) lines.push(theme.fg("dim", "no subagents tracked."));
  for (const child of children.slice(0, 4)) lines.push(...cardLines(child, width).map(line => paint(theme, line.spans)));
  if (children.length > 4) {
    const hidden = children.slice(4);
    const attention = hidden.filter(child => STATES[child.state].group === "attention").length;
    lines.push(theme.fg(attention ? "warning" : "dim", `… ${hidden.length} more children${attention ? ` (${attention} need attention)` : ""}`));
  }
  return lines;
}

function workflowLines(data: Data, theme: Theme): string[] {
  const runs = data.id ? [data] : array(data.runs).map(object).filter((r): r is Data => !!r);
  const lines: string[] = [];
  for (const run of runs.slice(0, 4)) {
    lines.push(theme.fg(run.status === "succeeded" ? "success" : run.status === "running" ? "accent" : "warning", `${inline(run.name).toLowerCase()} · ${inline(run.status)} · ${inline(run.id)}`));
    const limits = object(run.limits);
    lines.push(theme.fg("muted", `${count(run.usedAttempts) ?? 0}/${count(limits?.maxAttempts) ?? "?"} attempts · ${count(run.remainingSeconds) ?? "?"}s remaining`));
    if (run.reason) lines.push(theme.fg("dim", inline(run.reason)));
    for (const step of array(run.steps).map(object).filter((s): s is Data => !!s).slice(0, 6)) {
      lines.push(theme.fg("muted", `  ${inline(step.id)} · ${inline(step.status)} · iteration ${count(step.iteration) ?? 0}${step.activity ? ` · ${inline(step.activity)}` : ""}`));
    }
  }
  if (runs.length > 4) lines.push(theme.fg("dim", `… ${runs.length - 4} more workflows`));
  return lines.length ? lines : [theme.fg("dim", "no workflows tracked.")];
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
  if (data.gap) lines.push(theme.fg("warning", "history gap · older exchanges no longer retained"));
  if (data.hasMore) lines.push(theme.fg("warning", `more exchanges · continue from cursor ${count(data.nextCursor) ?? "?"}`));
  return lines.length ? lines : [theme.fg("dim", "no peer links or exchanges.")];
}

function readLines(data: Data, width: number, theme: Theme): string[] {
  const [card] = cardsFromDetails([data], "read");
  const lines = card ? cardLines(card, width).map(line => paint(theme, line.spans)) : [];
  if (data.gap === true) lines.push(theme.fg("warning", "history gap · some older updates are no longer retained"));
  if (data.hasMore === true) lines.push(theme.fg("warning", "more unread updates available · read again"));
  const updates = array(data.updates).map(object).filter((update): update is Data => !!update);
  const errors = updates.filter(update => ["error", "extension_error", "failure"].includes(String(update.kind)));
  if (errors.length) lines.push(...preview(inline(errors.at(-1)?.kind) + ": " + plain(errors.at(-1)?.text), width, theme, "error", 2));
  const reply = updates.findLast(update => update.kind === "assistant" && plain(update.text).trim());
  if (reply) lines.push(...preview(plain(reply.text), width, theme));
  else {
    const report = updates.findLast(update => ["aborted", "completed", "input_requested"].includes(String(update.kind)));
    if (report) lines.push(...preview(plain(report.text), width, theme, "muted", 2));
    else if (!errors.length) lines.push(theme.fg("dim", updates.length ? "no new assistant reply." : "no new updates."));
  }
  if (updates.length > 1) lines.push(theme.fg("dim", `${updates.length} updates · latest reply shown when available`));
  return lines;
}

function words(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function clip(value: string, limit = 80): string {
  const text = inline(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
function named(kind: "child" | "workflow", value: unknown, names?: NameLookup): string {
  const raw = inline(value);
  if (!raw) return "";
  const name = names?.(kind, raw);
  return clip(name ? name.toLowerCase() : raw, 120);
}
function command(theme: Theme, action: string, thing?: string): string {
  return theme.fg("toolTitle", theme.bold(thing ? `${thing} • ${action}` : action));
}
function shortenPath(value: string): string {
  const home = homedir();
  return home && (value === home || value.startsWith(home + sep)) ? `~${value.slice(home.length)}` : value;
}

/** Call row only. Result dashboards stay as they are. */
function formatCall(action: Action, data: Data, theme: Theme, complete: boolean, names?: NameLookup): string {
  const accent = (value: string) => value ? " " + theme.fg("accent", clip(value)) : "";
  const output = (value: string) => value ? " " + theme.fg("toolOutput", clip(value)) : "";
  const muted = (value: string) => theme.fg("muted", ` (${value})`);
  const pending = " " + theme.fg("toolOutput", "...");
  const invalid = " " + theme.fg("error", "[invalid arg]");
  const bad = (value: unknown) => value != null && typeof value !== "string";
  const childCall = (verb: string, key: string, messageKey?: string) => {
    if (bad(data[key])) return command(theme, verb) + invalid;
    const id = named("child", data[key], names);
    let text = command(theme, verb, id || undefined);
    if (!id && !complete) text += pending;
    if (messageKey) {
      if (bad(data[messageKey])) text += invalid;
      else {
        const message = inline(data[messageKey]);
        if (message) text += accent(message);
        else if (verb === "send" && !complete) text += pending;
      }
    }
    return text;
  };
  switch (action) {
    case "catalog":
      return command(theme, "catalog");
    case "loop":
      return command(theme, "loop") + (typeof data.op === "string" ? " " + theme.fg("accent", inline(data.op)) : "") +
        (typeof data.task === "string" ? " " + theme.fg("toolOutput", clip(inline(data.task))) : "");
    case "list":
      return command(theme, "list") + (data.includeRejected === true ? output("rejected") : "");
    case "spawn": {
      if (bad(data.name)) return command(theme, "spawn") + invalid;
      const name = inline(data.name).toLowerCase();
      let text = command(theme, "spawn", name || undefined);
      if (!name && !complete) text += pending;
      if (bad(data.task)) text += invalid;
      else {
        const task = inline(data.task);
        if (task) text += accent(task);
        else if (name && !complete) text += pending;
      }
      const model = inline(data.model);
      if (model) text += output(`${model}${data.thinking ? `:${inline(data.thinking)}` : ""}`);
      return text;
    }
    case "send": {
      let text = childCall("send", "id", "message");
      if (typeof data.behavior === "string" && data.behavior) text += muted(words(data.behavior));
      return text;
    }
    case "resume":
      return childCall("resume", "id", "message");
    case "read": {
      let text = childCall("read", "id");
      if (count(data.since) !== undefined) text += muted(`since ${data.since}`);
      return text;
    }
    case "abort":
      return childCall("abort", "id");
    case "close":
      return childCall("close", "id");
    case "release-hold": {
      const raw = inline(data.id);
      const name = names?.("child", raw) ?? names?.("workflow", raw);
      return command(theme, "release hold", name ? clip(name.toLowerCase(), 120) : raw);
    }
    case "respond": {
      if (bad(data.id)) return command(theme, "respond") + invalid;
      const id = named("child", data.id, names);
      let text = command(theme, "respond", id || undefined);
      if (!id && !complete) text += pending;
      if (typeof data.value === "string" && inline(data.value)) text += accent(data.value);
      else if (data.confirmed === true) text += accent("confirmed");
      else if (data.cancelled === true) text += accent("cancelled");
      else if (!complete) text += pending;
      return text;
    }
    case "wait": {
      const ids = array(data.ids);
      if (ids.some(id => id != null && typeof id !== "string")) return command(theme, "wait") + invalid;
      const labels = ids.map(id => named("child", id, names)).filter(Boolean);
      const mode = inline(data.mode);
      const timeout = count(data.timeoutSeconds);
      const tail = (mode && mode !== "all" ? output(mode) : "") + (timeout !== undefined && timeout !== 30 ? output(`${timeout}s`) : "");
      if (labels.length === 1) return command(theme, "wait", labels[0]) + tail;
      let text = command(theme, "wait");
      if (labels[0]) text += accent(labels[0]);
      for (const label of labels.slice(1)) text += output(label);
      if (!labels.length && !mode && timeout === undefined && !complete) text += pending;
      return text + tail;
    }
    case "connect":
    case "disconnect":
    case "renew": {
      const leftKey = action === "renew" ? "sender" : "a";
      const rightKey = action === "renew" ? "recipient" : "b";
      if (bad(data[leftKey]) || bad(data[rightKey])) return command(theme, action) + invalid;
      const left = named("child", data[leftKey], names);
      const right = named("child", data[rightKey], names);
      let text = command(theme, action, left || undefined);
      if (!left && !complete) text += pending;
      if (right) text += accent(right);
      else if (left && !complete) text += pending;
      if (count(data.limit) !== undefined) text += muted(`limit ${data.limit}`);
      return text;
    }
    case "peers": {
      if (bad(data.id)) return command(theme, "peers") + invalid;
      const id = named("child", data.id, names);
      return command(theme, "peers", id || undefined) + (count(data.since) !== undefined ? muted(`since ${data.since}`) : "");
    }
    case "workflow-start":
      return workflowStart(data, theme, complete);
    case "workflow-inspect":
      return workflowInspect(data, theme, names);
    case "workflow-control":
      return workflowControl(data, theme, complete, names);
    case "workflow":
      if ("path" in data) return workflowStart(data, theme, complete);
      if (typeof data.action === "string" || Array.isArray(data.retry)) return workflowControl(data, theme, complete, names);
      if ("id" in data || "step" in data) return workflowInspect(data, theme, names);
      return command(theme, "workflows") + (complete ? "" : pending);
    default:
      return command(theme, action);
  }
}

function workflowStart(data: Data, theme: Theme, complete: boolean): string {
  const text = command(theme, "workflow start");
  if (data.path != null && typeof data.path !== "string") return text + " " + theme.fg("error", "[invalid arg]");
  const path = typeof data.path === "string" ? shortenPath(inline(data.path)) : "";
  if (path) return text + " " + theme.fg("accent", clip(path, 120));
  return complete ? text : text + " " + theme.fg("toolOutput", "...");
}
function workflowInspect(data: Data, theme: Theme, names?: NameLookup): string {
  const id = named("workflow", data.id, names);
  if (!id) return command(theme, "workflows");
  return command(theme, "inspect", id) + (inline(data.step) ? " " + theme.fg("accent", clip(inline(data.step))) : "");
}
function workflowControl(data: Data, theme: Theme, complete: boolean, names?: NameLookup): string {
  const id = named("workflow", data.id, names);
  const verb = inline(data.action);
  const known = verb === "pause" || verb === "resume" || verb === "cancel";
  if (data.action != null && !known) return command(theme, "control", id || undefined) + " " + theme.fg("error", "[invalid arg]");
  let text = command(theme, known ? verb : "control", id || undefined);
  if ((!id || !known) && !complete) text += " " + theme.fg("toolOutput", "...");
  const retry = array(data.retry).map(inline).filter(Boolean);
  if (retry[0]) text += " " + theme.fg("accent", clip(retry[0]));
  for (const step of retry.slice(1)) text += " " + theme.fg("toolOutput", clip(step));
  return text;
}

/** UI-only adapters. Never mutate results, read files, or acknowledge child updates. */
export function subagentRenderers(action: Action, names?: NameLookup): Required<Pick<ToolDefinition, "renderCall" | "renderResult">> {
  return {
    renderCall(args, theme, context) {
      return component(() => [command(theme, "subagents • ") +
        formatCall(action, object(args) ?? {}, theme, context?.argsComplete === true, names)]);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return component(width => {
        const raw = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const data = object(result.details);
        let lines: string[];
        if (context?.isError) lines = preview(raw || "tool failed", width, theme, "error");
        else if (isPartial) lines = [theme.fg("warning", "updating…")];
        else if (typeof data?.fullResult === "string") {
          lines = [theme.fg("warning", "result truncated · full output saved to file"), ...preview(data.fullResult, width, theme, "dim", 3)];
        } else if (!data) lines = preview(raw || "no result data.", width, theme);
        else if (action === "catalog") lines = catalogLines(data, theme);
        else if (action === "loop") lines = preview(raw, width, theme);
        else if (workflowAction(action)) lines = workflowLines(data, theme);
        else if (action === "list" || action === "wait") {
          lines = groupLines(data, width, theme);
          for (const report of array(data.reports).map(object).filter((r): r is Data => !!r).slice(0, 2)) {
            const reply = array(report.updates).map(object).findLast(update => update?.kind === "assistant");
            if (reply) lines.push(...preview(`${inline(report.name).toLowerCase()}: ${plain(reply.text)}`, width, theme, "toolOutput", 2));
          }
        }
        else if (action === "read") lines = readLines(data, width, theme);
        else if (["connect", "disconnect", "renew", "peers"].includes(action)) lines = peerLines(data, theme);
        else {
          const [card] = cardsFromDetails([data], "summary");
          lines = [...card ? cardLines(card, width).map(line => paint(theme, line.spans)) : preview(raw, width, theme), ...overlapLines(data, theme)];
          if (action === "spawn" && data.task) lines.push(theme.fg("dim", `task: ${inline(data.task)}`));
        }
        if (expanded && raw) {
          lines.push("", theme.fg("dim", "full result"));
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
