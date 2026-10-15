import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectHost, registerHostAware } from "./src/host.js";
import { apply, counts, emptyList, formatList, formatWidget, parseOperation, STATES, type Item, type TodoList } from "./src/list.js";

const ENTRY = "todo";

const parameters = Type.Object({
  op: Type.Union([Type.Literal("set"), Type.Literal("update"), Type.Literal("get")], {
    description: "set replaces the list; update changes the state of one item (id) or several (ids); get returns the list",
  }),
  items: Type.Optional(Type.Array(Type.String(), { description: "set: the steps, in order. Copy a playbook's steps verbatim." })),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "update: the item number" })),
  ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: "update: several item numbers given the same state, instead of id" })),
  state: Type.Optional(Type.Union(STATES.map(state => Type.Literal(state)), { description: "update: the new state" })),
  note: Type.Optional(Type.String({ description: "update: a short note. Required when state is skipped: the reason." })),
});

const itemSchema = Type.Object({
  id: Type.Integer(), text: Type.String(), state: Type.Union(STATES.map(state => Type.Literal(state))), note: Type.Optional(Type.String()),
});
const outputSchema = Type.Object({
  items: Type.Array(itemSchema),
  counts: Type.Object({ pending: Type.Integer(), in_progress: Type.Integer(), done: Type.Integer(), skipped: Type.Integer() }),
});

const isOpen = (item: Item) => item.state === "pending" || item.state === "in_progress";
/** Turns without a todo call, while items are open, before a reminder. */
const REMIND_AFTER_TURNS = 4;
const SET_HINT = "Update items as you finish them: update with id, or ids for several at once; codemode scripts can call tools.todo. Nothing marks them for you.";
// T3 names its tools mcp__t3-code__<name>; a todo tool there would duplicate this one.
const isT3Todo = (name: string) => /^mcp__t3[-_]code__.*todo/i.test(name);

export default function todo(pi: ExtensionAPI) {
  let list: TodoList = emptyList;
  let demoted = false;
  // Models set the list and then forget it while they work (seen with GPT and Claude
  // alike): nothing in their context mentions it again. So the extension does, once
  // after a few turns without a todo call, and once more before a run settles.
  let turnsSinceTodo = 0, reminded = false, usedThisRun = false, settleNudged = false;

  const showWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(ENTRY, list.items.some(isOpen) ? formatWidget(list) : undefined);
  };

  const result = (change: string, error?: string) => ({
    content: [{ type: "text" as const, text: [error ?? change, formatList(list)].filter(Boolean).join("\n") }],
    structuredContent: { items: list.items.map(item => ({ ...item })), counts: counts(list) },
    details: { items: list.items },
    ...(error ? { isError: true } : {}),
  });

  const tool: ToolDefinition<typeof parameters> = {
    name: "todo",
    label: "Todo",
    description: "Track the steps of the current task. set replaces the list (copy a playbook's steps verbatim); update moves one item (id) or several (ids) to pending, in_progress, done or skipped; get returns the list. Mark each item as you finish it. Items are never deleted: mark a wrong step skipped with the reason in note.",
    promptSnippet: "todo: track the current task's steps; never delete one, skip it with a reason",
    parameters,
    outputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      turnsSinceTodo = 0; reminded = false; usedThisRun = true;
      const operation = parseOperation(params);
      if ("error" in operation) return result("", operation.error);
      const outcome = apply(list, operation);
      if ("error" in outcome) return result("", outcome.error);
      if (operation.op !== "get") {
        list = outcome.list;
        pi.appendEntry(ENTRY, { items: list.items });
        showWidget(ctx);
      }
      return result(operation.op === "set" ? `${outcome.change}\n${SET_HINT}` : outcome.change);
    },
    renderCall(args, theme) {
      const detail = args.op === "update" ? ` ${args.ids?.join(", ") ?? args.id ?? "?"} → ${args.state ?? "?"}` : args.op === "set" ? ` ${args.items?.length ?? 0} items` : "";
      return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${args.op}${detail}`), 0, 0);
    },
    // In the TUI a call is one line, like other tools; the widget shows the list and
    // expanding the call shows it too. The text result stays complete for the model and T3.
    renderResult(output, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("muted", "updating…"), 0, 0);
      const text = output.content.map(part => part.type === "text" ? part.text : "").join("\n");
      if (expanded) return new Text(theme.fg("muted", text), 0, 0);
      const [change = ""] = text.split("\n");
      const items = (output.details as { items?: Item[] } | undefined)?.items ?? [];
      const resolved = items.filter(item => item.state === "done" || item.state === "skipped").length;
      const summary = items.length ? ` · ${resolved}/${items.length} resolved` : "";
      return new Text(output.isError ? theme.fg("error", change) : theme.fg("muted", `${change}${summary}`), 0, 0);
    },
  };
  registerHostAware(pi, tool, { duplicatesT3: false });

  // Snapshots are stored with appendEntry only to rebuild state per branch. They have no
  // transcript renderer, so the feed shows each change once, as its tool call.

  // State follows the active branch: rebuild it from the last snapshot on it.
  const rebuild = (_event: unknown, ctx: ExtensionContext) => {
    list = emptyList;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY) list = { items: (entry.data as { items?: Item[] } | undefined)?.items ?? [] };
    }
    showWidget(ctx);
  };
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);

  pi.on("before_agent_start", () => {
    if (demoted || detectHost() !== "t3" || !pi.getAllTools().some(candidate => isT3Todo(candidate.name))) return;
    demoted = true;
    registerHostAware(pi, tool, { duplicatesT3: true });
  });

  const openSummary = () => {
    const open = list.items.filter(isOpen);
    const resolved = list.items.length - open.length;
    return { open, line: `todo: ${resolved}/${list.items.length} resolved; next open: ${open[0] ? `${open[0].id}. ${open[0].text.slice(0, 120)}` : "none"}` };
  };
  const note = (customType: string, content: string) => ({ type: "custom_message" as const, customType, content, display: false });

  // A new request from the user (or a T3 wake) starts a fresh check. The continuation this
  // extension asks for does not, so one request gets at most one nudge.
  pi.on("before_agent_start", event => { if ((event as { messageType?: string }).messageType !== "custom") { usedThisRun = false; settleNudged = false; } });

  pi.on("turn_end", () => {
    turnsSinceTodo++;
    if (reminded || turnsSinceTodo < REMIND_AFTER_TURNS || !list.items.some(isOpen)) return;
    reminded = true;
    return { entries: [note("todo-reminder", `[${openSummary().line}] Mark items done or skipped as you finish them (ids for several at once).`)] };
  });

  // Once per run, and only for a list this run used: open items get one more turn to be
  // marked (the hidden message is what lets Pi continue; canContinue is false at a normal end), or a one-line reason they stay open (waiting on delegated work or the user).
  pi.on("agent_before_settle", event => {
    if (settleNudged || !usedThisRun || event.outcome !== "completed") return;
    const { open, line } = openSummary();
    if (open.length === 0) return;
    settleNudged = true;
    const names = open.map(item => `${item.id}. ${item.text.slice(0, 80)}`).join("; ");
    return { continue: true, entries: [note("todo-settle", `[${line}] Before you finish, the todo list still has ${open.length} open item${open.length === 1 ? "" : "s"}: ${names}. Mark each one done, or skipped with the reason in note. If one stays open on purpose, for example waiting on delegated work or the user, say so in one line and stop.`)] };
  });

  pi.on("agent_end", (_event, ctx) => {
    const active = list.items.filter(item => item.state === "in_progress");
    if (active.length === 0 || !ctx.hasUI) return;
    const names = active.map(item => `${item.id}. ${item.text}`).join(", ");
    ctx.ui.notify(`Todo: ${active.length} item${active.length === 1 ? "" : "s"} still in progress: ${names}`, "warning");
  });
}
