// The todo list as data: operations validated at the boundary, applied purely.
export type ItemState = "pending" | "in_progress" | "done" | "skipped";
export interface Item { readonly id: number; readonly text: string; readonly state: ItemState; readonly note?: string }
export interface TodoList { readonly items: readonly Item[] }
export type Operation =
  | { readonly op: "set"; readonly items: readonly string[] }
  | { readonly op: "update"; readonly ids: readonly number[]; readonly state: ItemState; readonly note?: string }
  | { readonly op: "get" };

export const STATES: readonly ItemState[] = ["pending", "in_progress", "done", "skipped"];
export const emptyList: TodoList = { items: [] };

type Failure = { readonly error: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// Model-facing parameters are one flat object (providers require it), so the
// rules a schema cannot express, such as a reason for every skip, live here.
export function parseOperation(params: unknown): Operation | Failure {
  if (!isRecord(params)) return { error: "todo expects an object" };
  switch (params.op) {
    case "get": return { op: "get" };
    case "set": {
      const items = params.items;
      if (!Array.isArray(items) || items.length === 0) return { error: "set needs a non-empty items array" };
      if (!items.every(item => typeof item === "string" && item.trim() !== "")) return { error: "every item must be non-empty text" };
      return { op: "set", items };
    }
    case "update": {
      const { id, ids, state, note } = params;
      if ((id === undefined) === (ids === undefined)) return { error: "update needs either id or ids" };
      const wanted = ids === undefined ? [id] : ids;
      if (!Array.isArray(wanted) || wanted.length === 0 || !wanted.every(value => typeof value === "number" && Number.isInteger(value) && value >= 1)) {
        return { error: "update needs id, or ids: positive integers" };
      }
      if (typeof state !== "string" || !STATES.includes(state as ItemState)) return { error: `update needs a state: ${STATES.join(", ")}` };
      if (note !== undefined && typeof note !== "string") return { error: "note must be text" };
      const trimmed = typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
      if (state === "skipped" && trimmed === undefined) return { error: "a skipped item needs a reason in note; items are never deleted" };
      const unique = [...new Set(wanted as number[])];
      return trimmed === undefined ? { op: "update", ids: unique, state: state as ItemState } : { op: "update", ids: unique, state: state as ItemState, note: trimmed };
    }
    default: return { error: "op must be set, update or get" };
  }
}

export function apply(list: TodoList, operation: Operation): { readonly list: TodoList; readonly change: string } | Failure {
  switch (operation.op) {
    case "get": return { list, change: "" };
    case "set": {
      const open = list.items.filter(item => item.state === "pending" || item.state === "in_progress").length;
      const items = operation.items.map((text, index): Item => ({ id: index + 1, text, state: "pending" }));
      return { list: { items }, change: `Set ${items.length} items${open ? `, replacing a list with ${open} open` : ""}.` };
    }
    case "update": {
      const missing = operation.ids.filter(id => !list.items.some(item => item.id === id));
      if (missing.length) return { error: `no item ${missing.join(", ")}; the list has ${list.items.length}` };
      const targets = new Set(operation.ids);
      const items = list.items.map(item => {
        if (!targets.has(item.id)) return item;
        const { note: _previous, ...rest } = item;
        return operation.note === undefined ? { ...rest, state: operation.state } : { ...rest, state: operation.state, note: operation.note };
      });
      const state = operation.state.replace("_", " ");
      const change = operation.ids.length === 1 ? `Item ${operation.ids[0]} is ${state}.` : `Items ${operation.ids.join(", ")} are ${state}.`;
      return { list: { items }, change };
    }
  }
}

const MARKS: Record<ItemState, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]", skipped: "[-]" };

export function counts(list: TodoList): Record<ItemState, number> {
  const result = { pending: 0, in_progress: 0, done: 0, skipped: 0 };
  for (const item of list.items) result[item.state]++;
  return result;
}

export function formatItem(item: Item): string {
  const note = item.note === undefined ? "" : item.state === "skipped" ? ` (skip: ${item.note})` : ` (${item.note})`;
  return `${MARKS[item.state]} ${item.id}. ${item.text}${note}`;
}

/** A glanceable list for the widget: one line per item, notes left to the tool result. */
export function formatWidget(list: TodoList, width = 100): string[] {
  const total = counts(list);
  const line = (item: Item) => {
    const text = `${MARKS[item.state]} ${item.id}. ${item.text.replace(/\s+/g, " ")}`;
    return text.length > width ? `${text.slice(0, width - 1)}…` : text;
  };
  return [`Todo: ${total.done + total.skipped}/${list.items.length} resolved`, ...list.items.map(line)];
}

export function formatList(list: TodoList): string {
  if (list.items.length === 0) return "Todo: no items";
  const total = counts(list);
  const summary = `Todo: ${total.done} done, ${total.skipped} skipped, ${total.in_progress} in progress, ${total.pending} pending`;
  return [summary, ...list.items.map(formatItem)].join("\n");
}
