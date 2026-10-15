// The todo list as data: operations validated at the boundary, applied purely.
export type ItemState = "pending" | "in_progress" | "done" | "skipped";
export interface Item { readonly id: number; readonly text: string; readonly state: ItemState; readonly note?: string }
export interface TodoList { readonly items: readonly Item[] }
export type Operation =
  | { readonly op: "set"; readonly items: readonly string[] }
  | { readonly op: "update"; readonly id: number; readonly state: ItemState; readonly note?: string }
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
      const { id, state, note } = params;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return { error: "update needs the item id, a positive integer" };
      if (typeof state !== "string" || !STATES.includes(state as ItemState)) return { error: `update needs a state: ${STATES.join(", ")}` };
      if (note !== undefined && typeof note !== "string") return { error: "note must be text" };
      const trimmed = typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
      if (state === "skipped" && trimmed === undefined) return { error: "a skipped item needs a reason in note; items are never deleted" };
      return trimmed === undefined ? { op: "update", id, state: state as ItemState } : { op: "update", id, state: state as ItemState, note: trimmed };
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
      const target = list.items.find(item => item.id === operation.id);
      if (!target) return { error: `no item ${operation.id}; the list has ${list.items.length}` };
      const { note: _previous, ...rest } = target;
      const updated: Item = operation.note === undefined ? { ...rest, state: operation.state } : { ...rest, state: operation.state, note: operation.note };
      return { list: { items: list.items.map(item => item.id === target.id ? updated : item) }, change: `Item ${target.id} is ${operation.state.replace("_", " ")}.` };
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

export function formatList(list: TodoList): string {
  if (list.items.length === 0) return "Todo: no items";
  const total = counts(list);
  const summary = `Todo: ${total.done} done, ${total.skipped} skipped, ${total.in_progress} in progress, ${total.pending} pending`;
  return [summary, ...list.items.map(formatItem)].join("\n");
}
