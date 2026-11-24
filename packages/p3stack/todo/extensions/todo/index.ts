import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerHostAware } from "./src/host.js";
import { apply, counts, emptyList, formatList, isOpen, isTodoList, parseOperation, STATES, type Item, type Operation, type TodoList } from "./src/list.js";
import { resultLines, widgetLines } from "./src/render.js";

const ENTRY = "todo";

const parameters = Type.Object({
  op: Type.Union(["set", "add", "update", "remove", "get"].map(op => Type.Literal(op)), {
    description: "set replaces the list; add appends items; update changes one item (id) or several (ids); remove deletes pending items added by mistake; get returns the list",
  }),
  items: Type.Optional(Type.Array(Type.String(), { description: "set, add: the steps, in order. Copy a playbook's steps verbatim." })),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "update, remove: the item number" })),
  ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: "update, remove: several item numbers, instead of id" })),
  state: Type.Optional(Type.Union(STATES.map(state => Type.Literal(state)), { description: "update: the new state" })),
  text: Type.Optional(Type.String({ description: "update: new wording for one item (id)" })),
  note: Type.Optional(Type.String({ description: "update: a short note. Required when state is skipped: the reason." })),
});

const itemSchema = Type.Object({
  id: Type.Integer(), text: Type.String(), state: Type.Union(STATES.map(state => Type.Literal(state))), note: Type.Optional(Type.String()),
});
const outputSchema = Type.Object({
  items: Type.Array(itemSchema),
  counts: Type.Object({ pending: Type.Integer(), in_progress: Type.Integer(), done: Type.Integer(), skipped: Type.Integer() }),
});

/** Turns without a todo call, while items are open, before a reminder. */
const REMIND_AFTER_TURNS = 4;
const SET_HINT = "Update items as you finish them: update with id, or ids for several at once; add appends new steps; codemode scripts can call tools.todo. Nothing marks them for you.";

export default function todo(pi: ExtensionAPI) {
  let list: TodoList = emptyList;
  // Models set the list and then forget it while they work (seen with GPT and Claude
  // alike): nothing in their context mentions it again. So the extension does, once
  // after a few turns without a todo call. There is no end-of-run check: in real sessions
  // it mostly bought a visible "still waiting" reply for items left open on purpose.
  let turnsSinceTodo = 0, reminded = false, usedThisTurn = false;

  let lastStatus: string | undefined;
  const showList = (ctx: ExtensionContext, restored = false) => {
    if (!ctx.hasUI) return;
    if (host !== "cli" || ctx.mode !== "tui") {
      const open = list.items.filter(isOpen), size = list.items.length;
      const next = open[0]?.text.trim().replace(/\s+/g, " ");
      const status = next && `todo ${size - open.length}/${size} · next: ${[...next].slice(0, 60).join("")}`;
      if (restored || status !== lastStatus) ctx.ui.setStatus(ENTRY, status);
      lastStatus = status;
      return;
    }
    const shown = list;
    // A component, not lines: Pi cuts a widget's lines at ten, and this one decides what to leave out.
    ctx.ui.setWidget(ENTRY, shown.items.some(isOpen) ? (_tui, theme) => ({ render: width => widgetLines(shown, width, theme), invalidate() {} }) : undefined);
  };

  const result = (op: Operation["op"] | "error", change: string) => ({
    content: [{ type: "text" as const, text: [change, formatList(list, op === "add" || op === "update" || op === "remove")].filter(Boolean).join("\n") }],
    structuredContent: { items: list.items.map(item => ({ ...item })), counts: counts(list) },
    details: { items: list.items },
    ...(op === "error" ? { isError: true } : {}),
  });

  const tool: ToolDefinition<typeof parameters> = {
    name: "todo",
    label: "Todo",
    description: "Track the current task’s steps. Mark finished work done and intentionally omitted steps skipped.",
    promptSnippet: "track the current task's steps (set, add, update, remove, get); skip a step you won't do, with a reason",
    parameters,
    outputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      turnsSinceTodo = 0; reminded = false; usedThisTurn = true;
      const operation = parseOperation(params);
      if ("error" in operation) return result("error", operation.error);
      const outcome = apply(list, operation);
      if ("error" in outcome) return result("error", outcome.error);
      if (operation.op !== "get") {
        list = outcome.list;
        pi.appendEntry(ENTRY, { items: list.items, nextId: list.nextId });
        showList(ctx);
      }
      return result(operation.op, [outcome.change, operation.op === "set" ? SET_HINT : ""].filter(Boolean).join("\n"));
    },
    renderCall(args, theme) {
      const ids = args.ids?.join(", ") ?? args.id ?? "?";
      const change = [args.state, args.text === undefined ? undefined : "reworded", args.note === undefined || args.state ? undefined : "note"].filter(Boolean).join(", ");
      const detail = args.op === "update" ? ` ${ids} → ${change || "?"}` : args.op === "remove" ? ` ${ids}` : args.op === "set" || args.op === "add" ? ` ${args.items?.length ?? 0} items` : "";
      return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${args.op}${detail}`), 0, 0);
    },
    // In the TUI a call is one line, like other tools; the widget shows the list and
    // expanding the call shows all items, including resolved rows omitted from the text.
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
  const host = registerHostAware(pi, tool, { duplicatesT3: false });

  // Snapshots are stored with appendEntry only to rebuild state per branch. They have no
  // transcript renderer, so the feed shows each change once, as its tool call.

  // State follows the active branch: rebuild it from the last snapshot on it.
  const rebuild = (_event: unknown, ctx: ExtensionContext) => {
    list = emptyList;
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === ENTRY && isTodoList(entry.data)) {
        list = entry.data;
        break;
      }
    }
    showList(ctx, true);
  };
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);

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

  // Both user requests and idle custom wakes start here.
  pi.on("before_agent_start", () => { turnsSinceTodo = 0; reminded = false; usedThisTurn = false; });

  pi.on("turn_end", event => {
    // Pi records a script's calls on the outer tool result, in call order.
    const names = event.toolResults.flatMap(result => result.toolName === "codemode" && result.nestedCalls?.calls.length
      ? result.nestedCalls.calls.map(call => call.name) : [result.toolName]);
    const ranTodo = usedThisTurn;
    usedThisTurn = false;
    if (!names.length) return;
    // A bounded nested-call record can omit a todo that execute() saw, so check both.
    if (ranTodo || names.includes(tool.name)) return;
    turnsSinceTodo++;
    if (reminded || turnsSinceTodo < REMIND_AFTER_TURNS || !list.items.some(isOpen)) return;
    reminded = true;
    return { entries: [...event.entries, note("todo-reminder", `${openSummary().line}. Mark items done or skipped as you finish them (ids for several at once), and carry on with the task.`)] };
  });
}
