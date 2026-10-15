// The todo list as data: operations validated at the boundary, applied purely.
export type ItemState = "pending" | "in_progress" | "done" | "skipped";
export interface Item { readonly id: number; readonly text: string; readonly state: ItemState; readonly note?: string }
/** `nextId` keeps a removed item's number from being reused; older snapshots lack it. */
export interface TodoList { readonly items: readonly Item[]; readonly nextId?: number }
export type Operation =
  | { readonly op: "set"; readonly items: readonly string[] }
  | { readonly op: "add"; readonly items: readonly string[] }
  | { readonly op: "update"; readonly ids: readonly number[]; readonly state?: ItemState; readonly text?: string; readonly note?: string }
  | { readonly op: "remove"; readonly ids: readonly number[] }
  | { readonly op: "get" };

export const STATES: readonly ItemState[] = ["pending", "in_progress", "done", "skipped"];
export const emptyList: TodoList = { items: [] };

type Failure = { readonly error: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parseItems(items: unknown): readonly string[] | Failure {
  if (!Array.isArray(items) || items.length === 0) return { error: "needs a non-empty items array" };
  if (!items.every(item => typeof item === "string" && item.trim() !== "")) return { error: "every item must be non-empty text" };
  return items;
}

function parseIds({ id, ids }: Record<string, unknown>, op: string): number[] | Failure {
  if ((id === undefined) === (ids === undefined)) return { error: `${op} needs either id or ids` };
  const wanted = ids === undefined ? [id] : ids;
  if (!Array.isArray(wanted) || wanted.length === 0 || !wanted.every(value => typeof value === "number" && Number.isInteger(value) && value >= 1)) {
    return { error: `${op} needs id, or ids: positive integers` };
  }
  return [...new Set(wanted as number[])];
}

// Model-facing parameters are one flat object (providers require it), so the
// rules a schema cannot express, such as a reason for every skip, live here.
export function parseOperation(params: unknown): Operation | Failure {
  if (!isRecord(params)) return { error: "todo expects an object" };
  switch (params.op) {
    case "get": return { op: "get" };
    case "set":
    case "add": {
      const items = parseItems(params.items);
      return "error" in items ? { error: `${params.op} ${items.error}` } : { op: params.op, items };
    }
    case "update": {
      const ids = parseIds(params, "update");
      if ("error" in ids) return ids;
      const { state, text, note } = params;
      if (state === undefined && text === undefined && note === undefined) return { error: "update needs a state, text or note" };
      if (state !== undefined && (typeof state !== "string" || !STATES.includes(state as ItemState))) return { error: `update needs a state: ${STATES.join(", ")}` };
      if (text !== undefined && (typeof text !== "string" || text.trim() === "")) return { error: "text must be non-empty" };
      if (text !== undefined && ids.length > 1) return { error: "text rewords one item: use id, not ids" };
      if (note !== undefined && typeof note !== "string") return { error: "note must be text" };
      const trimmed = typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
      if (state === "skipped" && trimmed === undefined) return { error: "a skipped item needs a reason in note" };
      if (state === undefined && text === undefined && trimmed === undefined) return { error: "note must be non-empty" };
      return {
        op: "update", ids,
        ...state === undefined ? {} : { state: state as ItemState },
        ...text === undefined ? {} : { text: (text as string).trim() },
        ...trimmed === undefined ? {} : { note: trimmed },
      };
    }
    case "remove": {
      const ids = parseIds(params, "remove");
      return "error" in ids ? ids : { op: "remove", ids };
    }
    default: return { error: "op must be set, add, update, remove or get" };
  }
}

const nextIdOf = (list: TodoList) => list.nextId ?? Math.max(0, ...list.items.map(item => item.id)) + 1;
const numbered = (ids: readonly number[]) => ids.length === 1 ? `item ${ids[0]}` : `items ${ids.join(", ")}`;
const missingFrom = (list: TodoList, ids: readonly number[]) => {
  const missing = ids.filter(id => !list.items.some(item => item.id === id));
  return missing.length ? { error: `no item ${missing.join(", ")}; the list has ${list.items.length}` } : undefined;
};

export function apply(list: TodoList, operation: Operation): { readonly list: TodoList; readonly change: string } | Failure {
  switch (operation.op) {
    case "get": return { list, change: "" };
    case "set": {
      const open = list.items.filter(item => item.state === "pending" || item.state === "in_progress").length;
      const items = operation.items.map((text, index): Item => ({ id: index + 1, text, state: "pending" }));
      return { list: { items, nextId: items.length + 1 }, change: `Set ${items.length} items${open ? `, replacing a list with ${open} open` : ""}.` };
    }
    case "add": {
      const first = nextIdOf(list);
      const added = operation.items.map((text, index): Item => ({ id: first + index, text, state: "pending" }));
      return { list: { items: [...list.items, ...added], nextId: first + added.length }, change: `Added ${numbered(added.map(item => item.id))}.` };
    }
    case "update": {
      const missing = missingFrom(list, operation.ids);
      if (missing) return missing;
      const targets = new Set(operation.ids);
      const { state, text, note } = operation;
      const items = list.items.map((item): Item => {
        if (!targets.has(item.id)) return item;
        // A new state starts without the old state's note.
        const { note: previous, ...rest } = item;
        const kept = note ?? (state === undefined ? previous : undefined);
        return { ...rest, ...text === undefined ? {} : { text }, ...state === undefined ? {} : { state }, ...kept === undefined ? {} : { note: kept } };
      });
      const one = operation.ids.length === 1, subject = one ? `Item ${operation.ids[0]}` : `Items ${operation.ids.join(", ")}`;
      const stateText = state && `${one ? "is" : "are"} ${state.replace("_", " ")}`;
      const change = text !== undefined ? `${subject} now reads: ${text}${stateText ? `, and ${stateText}` : ""}.`
        : stateText ? `${subject} ${stateText}.`
        : `${subject} ${one ? "has" : "have"} a new note.`;
      return { list: { ...list, items }, change };
    }
    case "remove": {
      const missing = missingFrom(list, operation.ids);
      if (missing) return missing;
      const started = list.items.find(item => operation.ids.includes(item.id) && item.state !== "pending");
      if (started) return { error: `item ${started.id} is ${started.state.replace("_", " ")}; only pending items can be removed. Mark a step you won't do skipped, with the reason in note.` };
      return { list: { items: list.items.filter(item => !operation.ids.includes(item.id)), nextId: nextIdOf(list) }, change: `Removed ${numbered(operation.ids)}.` };
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

// The widget puts the work in hand first: in progress, then pending, then resolved.
const FOCUS: Record<ItemState, number> = { in_progress: 0, pending: 1, done: 2, skipped: 2 };

/** Items in focus order, by number within each group. */
export function focusOrder(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => FOCUS[a.state] - FOCUS[b.state] || a.id - b.id);
}

/**
 * What the widget has room for: at most `limit` rows. When the list is longer, the
 * last row counts what is left out, and in focus order that is resolved items first.
 */
export function widgetRows(list: TodoList, limit: number): { readonly shown: readonly Item[]; readonly hidden: Record<ItemState, number> } {
  const ordered = focusOrder(list.items);
  const shown = ordered.length <= limit ? ordered : ordered.slice(0, Math.max(0, limit - 1));
  return { shown, hidden: counts({ items: ordered.slice(shown.length) }) };
}

export function formatList(list: TodoList): string {
  if (list.items.length === 0) return "Todo: no items";
  const total = counts(list);
  const summary = `Todo: ${total.done} done, ${total.skipped} skipped, ${total.in_progress} in progress, ${total.pending} pending`;
  return [summary, ...list.items.map(formatItem)].join("\n");
}
