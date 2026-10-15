// How the list looks in Pi's terminal: the widget above the editor and an expanded
// tool call. The text the model and T3 read is formatList's, unchanged.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { counts, widgetRows, type Item, type ItemState, type TodoList } from "./list.js";

/** The part of Pi's theme used here; tests pass plain text through. */
export interface Paint {
  fg(color: "accent" | "success" | "muted" | "dim" | "text" | "borderMuted", text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

/** Item rows the widget shows before it summarizes the rest. */
export const WIDGET_ROWS = 10;
const BAR = 12;
const GLYPHS: Record<ItemState, string> = { in_progress: "◐", pending: "○", done: "✓", skipped: "⊘" };

function header(list: TodoList, paint: Paint): string {
  const total = counts(list), resolved = total.done + total.skipped, size = list.items.length;
  const filled = size ? Math.round((resolved / size) * BAR) : 0;
  const bar = paint.fg("success", "━".repeat(filled)) + paint.fg("borderMuted", "─".repeat(BAR - filled));
  const active = total.in_progress ? paint.fg("accent", ` · ${total.in_progress} in progress`) : "";
  return `${paint.fg("accent", paint.bold("Todo"))} ${bar} ${paint.fg("muted", `${resolved}/${size}`)}${active}`;
}

function row(item: Item, idWidth: number, paint: Paint, withNote: boolean): string {
  const id = `${String(item.id).padStart(idWidth)}.`;
  const text = item.text.replace(/\s+/g, " ");
  const note = withNote && item.note ? paint.fg("dim", ` — ${item.state === "skipped" ? "skipped: " : ""}${item.note}`) : "";
  switch (item.state) {
    case "in_progress": return `${paint.fg("accent", GLYPHS.in_progress)} ${paint.fg("accent", id)} ${paint.fg("text", paint.bold(text))}${note}`;
    case "pending": return `${paint.fg("muted", GLYPHS.pending)} ${paint.fg("muted", id)} ${paint.fg("text", text)}${note}`;
    case "done": return `${paint.fg("success", GLYPHS.done)} ${paint.fg("dim", `${id} ${text}`)}${note}`;
    case "skipped": return `${paint.fg("dim", GLYPHS.skipped)} ${paint.fg("dim", id)} ${paint.fg("dim", paint.strikethrough(text))}${note}`;
  }
}

function more(hidden: Record<ItemState, number>, paint: Paint): string | undefined {
  const parts = ([["in_progress", "in progress"], ["pending", "pending"], ["done", "done"], ["skipped", "skipped"]] as const)
    .filter(([state]) => hidden[state]).map(([state, label]) => `${hidden[state]} ${label}`);
  return parts.length ? paint.fg("dim", `  … and ${parts.join(", ")}`) : undefined;
}

const fit = (lines: string[], width: number) => lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);

/** The widget: a progress header, then the work in hand first, one line per item. */
export function widgetLines(list: TodoList, width: number, paint: Paint, limit = WIDGET_ROWS): string[] {
  const { shown, hidden } = widgetRows(list, limit);
  const idWidth = String(Math.max(0, ...list.items.map(item => item.id))).length;
  const rest = more(hidden, paint);
  // One column of padding, as Pi gives its own widgets.
  return fit([header(list, paint), ...shown.map(item => ` ${row(item, idWidth, paint, false)}`), ...rest ? [rest] : []].map(line => ` ${line}`), width);
}

/** An expanded tool call: the whole list in number order, with notes, wrapped under each item's text. */
export function resultLines(list: TodoList, width: number, paint: Paint): string[] {
  const idWidth = String(Math.max(0, ...list.items.map(item => item.id))).length;
  const indent = " ".repeat(idWidth + 5); // " ◐ 12. "
  const wrapped = (line: string) => wrapTextWithAnsi(line, Math.max(1, width - indent.length)).map((part, index) => index ? indent + part : part);
  return [...wrapTextWithAnsi(header(list, paint), Math.max(1, width)), ...list.items.flatMap(item => wrapped(` ${row(item, idWidth, paint, true)}`))];
}
