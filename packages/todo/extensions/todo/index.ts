import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectHost, registerHostAware } from "./src/host.js";
import { apply, counts, emptyList, formatList, parseOperation, STATES, type Item, type TodoList } from "./src/list.js";
import { resultLines, widgetLines } from "./src/render.js";

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
const SETTLED = "That answers the todo check. End your turn now without writing anything: your last reply to the user stands.";
// T3 names its tools mcp__t3-code__<name>; a todo tool there would duplicate this one.
const isT3Todo = (name: string) => /^mcp__t3[-_]code__.*todo/i.test(name);

export default function todo(pi: ExtensionAPI) {
  let list: TodoList = emptyList;
  let demoted = false;
  // Models set the list and then forget it while they work (seen with GPT and Claude
  // alike): nothing in their context mentions it again. So the extension does, once
  // after a few turns without a todo call, and once more before a run settles.
  let turnsSinceTodo = 0, reminded = false, usedThisRun = false, settleNudged = false;
  // Whether the model used other tools after its last todo call: only then can the
  // list have fallen behind the work.
  let workSinceTodo = false;

  const showWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const shown = list;
    // A component, not lines: Pi cuts a widget's lines at ten, and this one decides what to leave out.
    ctx.ui.setWidget(ENTRY, shown.items.some(isOpen) ? (_tui, theme) => ({ render: width => widgetLines(shown, width, theme), invalidate() {} }) : undefined);
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
      // Answering the end-of-run check: models otherwise follow the update with a recap.
      if (settleNudged) return result(`${outcome.change}\n${SETTLED}`);
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
      const [change = ""] = text.split("\n");
      const items = (output.details as { items?: Item[] } | undefined)?.items ?? [];
      if (expanded) {
        const first = output.isError ? theme.fg("error", change) : theme.fg("muted", change);
        return { render: (width: number) => [...wrapTextWithAnsi(first, width), ...items.length ? resultLines({ items }, width, theme) : []], invalidate() {} };
      }
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
  // Pi hands a custom message to the model as a user message. Unlabelled, these were
  // answered as if the user had written them ("You asked for…"), so each says where it
  // comes from and that it gets no reply.
  const note = (customType: string, content: string) => ({
    type: "custom_message" as const, customType, display: false,
    content: `<todo-extension-note>\nAutomated note from the todo tool's extension, not from the user, who does not see it. Do not mention it or reply to it.\n${content}\n</todo-extension-note>`,
  });

  // A new request from the user (or a T3 wake) starts a fresh check. The continuation this
  // extension asks for does not, so one request gets at most one nudge.
  pi.on("before_agent_start", event => { if ((event as { messageType?: string }).messageType !== "custom") { usedThisRun = false; settleNudged = false; workSinceTodo = false; } });

  pi.on("turn_end", event => {
    // Results come in call order, so work after a todo call in the same turn counts.
    const names = event.toolResults.map(result => result.toolName);
    const last = names.lastIndexOf(tool.name);
    if (last >= 0) workSinceTodo = last < names.length - 1;
    else if (names.length) workSinceTodo = true;
    turnsSinceTodo++;
    // A turn without tool calls ends the run; the end-of-run check covers that.
    if (!names.length || reminded || turnsSinceTodo < REMIND_AFTER_TURNS || !list.items.some(isOpen)) return;
    reminded = true;
    return { entries: [note("todo-reminder", `${openSummary().line}. Mark items done or skipped as you finish them (ids for several at once), and carry on with the task.`)] };
  });

  // Once per run, for a list this run used and then worked past: open items get one more
  // turn to be marked (the hidden message is what lets Pi continue; canContinue is false
  // at a normal end). Each one costs a visible reply, so a run whose last tool call was
  // todo itself, with the list as the model left it, is not checked.
  pi.on("agent_before_settle", event => {
    if (settleNudged || !usedThisRun || !workSinceTodo || event.outcome !== "completed") return;
    const { open, line } = openSummary();
    if (open.length === 0) return;
    settleNudged = true;
    const names = open.map(item => `${item.id}. ${item.text.slice(0, 80)}`).join("; ");
    return { continue: true, entries: [note("todo-settle", `${line}. The run is ending with ${open.length} open item${open.length === 1 ? "" : "s"}: ${names}. Mark any that are finished done, or skipped with the reason in note; leave any that stay open on purpose, for example waiting on delegated work or the user. Then end your turn without writing anything: your last reply to the user stands.`)] };
  });
}
