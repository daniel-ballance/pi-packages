import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectHost, registerHostAware } from "./src/host.js";
import { apply, counts, emptyList, formatItem, formatList, formatWidget, parseOperation, STATES, type Item, type TodoList } from "./src/list.js";

const ENTRY = "todo";

const parameters = Type.Object({
  op: Type.Union([Type.Literal("set"), Type.Literal("update"), Type.Literal("get")], {
    description: "set replaces the list; update changes one item's state; get returns the list",
  }),
  items: Type.Optional(Type.Array(Type.String(), { description: "set: the steps, in order. Copy a playbook's steps verbatim." })),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "update: the item number" })),
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
// T3 names its tools mcp__t3-code__<name>; a todo tool there would duplicate this one.
const isT3Todo = (name: string) => /^mcp__t3[-_]code__.*todo/i.test(name);

export default function todo(pi: ExtensionAPI) {
  let list: TodoList = emptyList;
  let demoted = false;

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
    description: "Track the steps of the current task. set replaces the list (copy a playbook's steps verbatim); update moves one item to pending, in_progress, done or skipped; get returns the list. Items are never deleted: mark a wrong step skipped with the reason in note.",
    promptSnippet: "todo: track the current task's steps; never delete one, skip it with a reason",
    parameters,
    outputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const operation = parseOperation(params);
      if ("error" in operation) return result("", operation.error);
      const outcome = apply(list, operation);
      if ("error" in outcome) return result("", outcome.error);
      if (operation.op !== "get") {
        list = outcome.list;
        pi.appendEntry(ENTRY, { items: list.items });
        showWidget(ctx);
      }
      return result(outcome.change);
    },
    renderCall(args, theme) {
      const detail = args.op === "update" ? ` ${args.id ?? "?"} → ${args.state ?? "?"}` : args.op === "set" ? ` ${args.items?.length ?? 0} items` : "";
      return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${args.op}${detail}`), 0, 0);
    },
  };
  registerHostAware(pi, tool, { duplicatesT3: false });

  pi.registerEntryRenderer<{ items: Item[] }>(ENTRY, (entry, _options, theme) => {
    const items = entry.data?.items ?? [];
    return new Text(theme.fg("muted", items.length ? items.map(formatItem).join("\n") : "Todo: no items"), 0, 0);
  });

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

  pi.on("agent_end", (_event, ctx) => {
    const active = list.items.filter(item => item.state === "in_progress");
    if (active.length === 0 || !ctx.hasUI) return;
    const names = active.map(item => `${item.id}. ${item.text}`).join(", ");
    ctx.ui.notify(`Todo: ${active.length} item${active.length === 1 ? "" : "s"} still in progress: ${names}`, "warning");
  });
}
