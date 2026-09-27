import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { cleanText, inspectorPage, oneLine, type InspectorSource, type Location, type Page, type Row } from "./inspector-data.js";

type Frame = { location: Location; selected?: string; top: number; anchor?: string; follow: boolean };
type Line = { key: string; row: Row; text: string };
type Layout = { text: string; width: number; prefix: string; lines: string[] };

/** One interaction, with stable-ID selection and scroll anchors across live refreshes. */
export class InspectorPanel {
  private frames: Frame[] = [{ location: { kind: "overview" }, top: 0, follow: false }];
  private page: Page = { title: "Subagents", subtitle: "", rows: [] };
  private lines: Line[] = [];
  private bodyHeight = 10;
  private width = 80;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private revealSelection = false;
  private layout = new Map<string, Layout>();
  constructor(private source: InspectorSource, private theme: Theme,
    private keys: Pick<KeybindingsManager, "matches" | "getKeys">,
    private height: () => number, private redraw: () => void, private done: () => void) {}
  start() { this.timer ??= setInterval(() => this.redraw(), 250); this.timer.unref(); }
  dispose() { clearInterval(this.timer); this.timer = undefined; }
  close() { if (!this.closed) { this.closed = true; this.dispose(); this.done(); } }
  invalidate() {} // Rebuild theme-dependent strings on every render.
  private get frame() { return this.frames[this.frames.length - 1]; }
  private anchor() { this.frame.anchor = this.lines[this.frame.top]?.key; }
  private scroll(delta: number) {
    this.frame.follow = false;
    this.frame.top = Math.max(0, Math.min(Math.max(0, this.lines.length - this.bodyHeight), this.frame.top + delta));
    this.anchor();
    const visible = this.lines.slice(this.frame.top, this.frame.top + this.bodyHeight).filter(line => line.row.target);
    if (!visible.some(line => line.row.id === this.frame.selected)) this.frame.selected = (delta < 0 ? visible.at(-1) : visible[0])?.row.id;
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.frames.length > 1) this.frames.pop(); else this.close();
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const target = this.lines.slice(this.frame.top, this.frame.top + this.bodyHeight).find(line => line.row.id === this.frame.selected)?.row.target;
      if (target) this.frames.push({ location: target, top: 0, follow: target.kind === "agent" });
    } else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll(-this.bodyHeight);
    else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll(this.bodyHeight);
    else if (matchesKey(data, "home")) { this.frame.follow = false; this.frame.top = 0; this.anchor(); }
    else if (matchesKey(data, "end")) {
      this.frame.follow = !!this.page.live;
      this.frame.top = Math.max(0, this.lines.length - this.bodyHeight); this.anchor();
    } else {
      const direction = this.keys.matches(data, "tui.select.up") ? -1 : this.keys.matches(data, "tui.select.down") ? 1 : 0;
      if (!direction) return;
      const choices = this.page.rows.filter(row => row.target);
      if (choices.length) {
        const index = choices.findIndex(row => row.id === this.frame.selected);
        this.frame.selected = choices[Math.max(0, Math.min(choices.length - 1, index + direction))].id;
        this.revealSelection = true;
      } else this.scroll(direction);
    }
    this.redraw();
  }
  render(width: number): string[] {
    // A responsive graph/list switch must not strand a previously visible selection.
    if (width !== this.width && this.lines.slice(this.frame.top, this.frame.top + this.bodyHeight).some(line => line.row.target && line.row.id === this.frame.selected)) this.revealSelection = true;
    this.width = Math.max(1, width);
    const height = Math.max(1, this.height());
    const inner = Math.max(1, width - 4);
    this.bodyHeight = Math.max(1, height - 6);
    try { this.page = inspectorPage(this.source, this.frame.location, Date.now(), Math.max(1, inner - 2)); }
    catch (error) { this.page = { title: "Inspector unavailable", subtitle: "Execution is unaffected; Esc goes back", rows: [{ id: "error", text: String(error), tone: "error", wrap: true }] }; }
    const choices = this.page.rows.filter(row => row.target);
    if ((this.frame.selected !== undefined || this.frame.top === 0) && !choices.some(row => row.id === this.frame.selected)) this.frame.selected = choices[0]?.id;
    const layout = new Map<string, Layout>();
    this.lines = this.page.rows.flatMap(row => {
      let cached = this.layout.get(row.id);
      const prefix = oneLine(row.prefix ?? "");
      if (!cached || cached.text !== row.text || cached.width !== width || cached.prefix !== prefix) {
        const text = row.wrap ? cleanText(row.text) : oneLine(row.text);
        const bounded = text.length > 12000 ? `${text.slice(0, 12000)}\n[More in saved logs]` : text;
        const available = Math.max(1, inner - 2 - visibleWidth(prefix));
        const wrapped = row.wrap ? bounded.split("\n").flatMap(line => wrapTextWithAnsi(line, available)) : [truncateToWidth(bounded, available)];
        cached = { text: row.text, width, prefix, lines: wrapped.length > 300 ? [...wrapped.slice(0, 299), "[More in saved logs]"] : wrapped };
      }
      layout.set(row.id, cached);
      return cached.lines.map((text, index) => ({ key: `${row.id}:${index}`, row, text }));
    });
    this.layout = layout;
    if (!this.page.live) this.bodyHeight = Math.min(this.bodyHeight, Math.max(4, this.lines.length));
    const anchored = this.frame.anchor ? this.lines.findIndex(line => line.key === this.frame.anchor) : -1;
    if (this.frame.follow) this.frame.top = Math.max(0, this.lines.length - this.bodyHeight);
    else if (anchored >= 0) this.frame.top = anchored;
    if (this.revealSelection) {
      const index = this.lines.findIndex(line => line.row.id === this.frame.selected);
      if (index >= 0 && index < this.frame.top) this.frame.top = index;
      else if (index >= this.frame.top + this.bodyHeight) this.frame.top = index - this.bodyHeight + 1;
      this.revealSelection = false;
    }
    this.frame.top = Math.max(0, Math.min(this.frame.top, Math.max(0, this.lines.length - this.bodyHeight)));
    this.anchor();
    const fg = (tone: Parameters<Theme["fg"]>[0], text: string) => this.theme.fg(tone, text);
    const box = (content: string) => {
      const clipped = truncateToWidth(content, inner);
      return truncateToWidth(fg("border", "│ ") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + fg("border", " │"), this.width);
    };
    const edge = (left: string, right: string) => truncateToWidth(fg("border", left + "─".repeat(Math.max(0, width - 2)) + right), this.width);
    const output = [edge("╭", "╮"), box(fg("accent", oneLine(this.page.title))), box(fg("dim", oneLine(this.page.subtitle)))];
    for (const line of this.lines.slice(this.frame.top, this.frame.top + this.bodyHeight)) {
      const selected = !!line.row.target && line.row.id === this.frame.selected;
      output.push(box((selected ? fg("accent", "› ") : "  ") + fg("dim", oneLine(line.row.prefix ?? "")) + fg(selected ? "accent" : line.row.tone ?? "text", line.text)));
    }
    while (output.length < this.bodyHeight + 3) output.push(box(""));
    const cancel = this.keys.getKeys("tui.select.cancel")[0] ?? "unbound";
    const confirm = this.keys.getKeys("tui.select.confirm")[0] ?? "unbound";
    const up = this.keys.getKeys("tui.select.up")[0] ?? "unbound";
    const down = this.keys.getKeys("tui.select.down")[0] ?? "unbound";
    const pages = `${this.keys.getKeys("tui.select.pageUp")[0] ?? "unbound"}/${this.keys.getKeys("tui.select.pageDown")[0] ?? "unbound"}`;
    const progress = `${this.frame.top + 1}–${Math.min(this.lines.length, this.frame.top + this.bodyHeight)}/${this.lines.length}`;
    output.push(box(fg("dim", `${cancel} ${this.frames.length > 1 ? "back" : "close"} · ${up}/${down} ${choices.length ? "select" : "scroll"}${choices.length ? ` · ${confirm} inspect` : ""}`)));
    output.push(box(fg("dim", `${pages} scroll · Home/End ${this.page.live ? "top/follow" : "top/bottom"} · ${this.page.live ? this.frame.follow ? "following · " : "scroll paused · " : ""}${progress}`)));
    output.push(edge("╰", "╯"));
    return output.slice(0, height);
  }
}

export async function showInspector(ctx: ExtensionContext, source: InspectorSource, opened?: (panel: InspectorPanel) => void) {
  if (ctx.mode !== "tui") return;
  let panel: InspectorPanel | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, keys, done) => {
      panel = new InspectorPanel(source, theme, keys, () => Math.min(36, Math.max(1, tui.terminal.rows - 4)), () => tui.requestRender(), () => done());
      panel.start(); opened?.(panel); return panel;
    }, { overlay: true, overlayOptions: { width: "90%", anchor: "center", margin: 1 } });
  } finally { panel?.dispose(); }
}
