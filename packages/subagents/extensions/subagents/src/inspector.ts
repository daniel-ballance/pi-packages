import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { cleanText, inspectorPage, oneLine, type InspectorSource, type Location, type Page, type Row } from "./inspector-data.js";

export interface InspectorActions {
  halt?(id: string): Promise<{ ok: boolean; message: string }>;
  kill?(id: string): Promise<{ ok: boolean; message: string }>;
}
type Frame = { location: Location; selected?: string; top: number; anchor?: string; follow: boolean };
type Line = { key: string; row: Row; text: string };
type Layout = { text: string; width: number; prefix: string; lines: string[] };
type ActionState = { inFlight: Set<"halt" | "kill">; messages: Partial<Record<"halt" | "kill", string>>; notice?: string };

/** One interaction, with stable-ID selection and scroll anchors across live refreshes. */
export class InspectorPanel {
  private frames: Frame[] = [{ location: { kind: "overview" }, top: 0, follow: false }];
  private page: Page = { title: "subagents", subtitle: "", rows: [] };
  private lines: Line[] = [];
  private bodyHeight = 10;
  private width = 80;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private revealSelection = false;
  private layout = new Map<string, Layout>();
  private pendingKill?: { id: string; name: string };
  private killConfirmReady = false;
  private workerActions = new Map<string, ActionState>();
  constructor(private source: InspectorSource, private theme: Theme,
    private keys: Pick<KeybindingsManager, "matches" | "getKeys">,
    private height: () => number, private redraw: () => void, private done: () => void,
    private actions: InspectorActions = {}) {}
  start() { this.timer ??= setInterval(() => this.redraw(), 250); this.timer.unref(); }
  dispose() { clearInterval(this.timer); this.timer = undefined; }
  close() { if (!this.closed) { this.closed = true; this.pendingKill = undefined; this.dispose(); this.done(); } }
  private actionState(id: string): ActionState {
    let state = this.workerActions.get(id);
    if (!state) this.workerActions.set(id, state = { inFlight: new Set(), messages: {} });
    return state;
  }
  private async act(kind: "halt" | "kill", id: string) {
    const callback = this.actions[kind];
    const state = this.actionState(id);
    if (!callback || state.inFlight.has(kind) || (kind === "halt" && state.inFlight.has("kill"))) return;
    state.inFlight.add(kind);
    state.notice = undefined;
    state.messages[kind] = `${kind} requested for ${id}…`;
    this.redraw();
    try {
      const result = await callback(id);
      if (!this.closed) state.messages[kind] = `${kind} ${result.ok ? "result" : "failed"} for ${id}: ${oneLine(result.message)}`;
    } catch (error) {
      if (!this.closed) state.messages[kind] = `${kind} failed for ${id}: ${oneLine(String(error))}`;
    } finally { state.inFlight.delete(kind); if (!this.closed) this.redraw(); }
  }
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
    if (this.pendingKill) {
      const target = this.pendingKill;
      if (this.keys.matches(data, "tui.select.confirm") && !this.killConfirmReady) {
        this.actionState(target.id).notice = "kill not confirmed: resize to read the complete warning.";
      } else {
        this.pendingKill = undefined;
        this.killConfirmReady = false;
        if (this.keys.matches(data, "tui.select.confirm") && this.frame.location.kind === "agent" && this.frame.location.id === target.id && this.source.agents().some(a => a.id === target.id && a.name === target.name)) void this.act("kill", target.id);
        else this.actionState(target.id).notice = "kill cancelled (target changed or confirmation dismissed).";
      }
    } else if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.frames.length > 1) this.frames.pop(); else this.close();
    } else if (this.frame.location.kind === "agent" && this.actions.halt && matchesKey(data, "h")) {
      void this.act("halt", this.frame.location.id);
    } else if (this.frame.location.kind === "agent" && this.actions.kill && matchesKey(data, "shift+k")) {
      const agent = this.source.agents().find(a => a.id === (this.frame.location as { id: string }).id);
      if (agent) { this.pendingKill = { id: agent.id, name: agent.name }; this.killConfirmReady = false; this.actionState(agent.id).notice = undefined; }
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const target = this.lines.slice(this.frame.top, this.frame.top + this.bodyHeight).find(line => line.row.id === this.frame.selected)?.row.target;
      if (target) { this.frames.push({ location: target, top: 0, follow: false }); this.revealSelection = false; }
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
    try { this.page = this.pendingKill ? {
      title: "break-glass kill", subtitle: "destructive intervention · no rollback",
      rows: [
        { id: "kill-target", text: `target: ${this.pendingKill.id} · ${this.pendingKill.name.toLowerCase()}`, wrap: true, tone: "warning" },
        { id: "kill-force", text: "force-stop the worker process (SIGKILL).", tone: "error" },
        { id: "kill-edits", text: "edits are not rolled back.", tone: "warning" },
        { id: "kill-detached", text: "detached subprocesses may survive.", tone: "warning" },
        { id: "kill-history", text: "saved conversation remains; parent notified; work held.", tone: "dim" },
        { id: "kill-confirm", text: `${this.keys.getKeys("tui.select.confirm")[0] ?? "unbound"} confirms this target · ${this.keys.getKeys("tui.select.cancel")[0] ?? "unbound"} cancels`, tone: "error" },
      ],
    } : inspectorPage(this.source, this.frame.location, Date.now(), Math.max(1, inner - 2)); }
    catch (error) { this.page = { title: "inspector unavailable", subtitle: "execution is unaffected; esc goes back", rows: [{ id: "error", text: String(error), tone: "error", wrap: true }] }; }
    const choices = this.page.rows.filter(row => row.target);
    if ((this.frame.selected !== undefined || this.frame.top === 0) && !choices.some(row => row.id === this.frame.selected)) this.frame.selected = choices[0]?.id;
    const layout = new Map<string, Layout>();
    this.lines = this.page.rows.flatMap(row => {
      let cached = this.layout.get(row.id);
      const prefix = oneLine(row.prefix ?? "");
      if (!cached || cached.text !== row.text || cached.width !== width || cached.prefix !== prefix) {
        const text = row.wrap ? cleanText(row.text) : oneLine(row.text);
        const bounded = text.length > 12000 ? `${text.slice(0, 12000)}\n[more in saved logs]` : text;
        const available = Math.max(1, inner - 2 - visibleWidth(prefix));
        const wrapped = row.wrap ? bounded.split("\n").flatMap(line => wrapTextWithAnsi(line, available)) : [truncateToWidth(bounded, available)];
        cached = { text: row.text, width, prefix, lines: wrapped.length > 300 ? [...wrapped.slice(0, 299), "[more in saved logs]"] : wrapped };
      }
      layout.set(row.id, cached);
      return cached.lines.map((text, index) => ({ key: `${row.id}:${index}`, row, text }));
    });
    this.layout = layout;
    this.killConfirmReady = !!this.pendingKill && width >= 55 && height >= 12 && this.lines.length <= this.bodyHeight;
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
    const output = [edge("╭", "╮"), box(fg("accent", oneLine(this.page.title))), box(fg(this.pendingKill ? "error" : "dim", this.pendingKill && !this.killConfirmReady ? "resize to read the complete warning before confirming" : oneLine(this.page.subtitle)))];
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
    const feedback = this.frame.location.kind === "agent" ? this.workerActions.get(this.frame.location.id) : undefined;
    output.push(box(fg("dim", feedback?.notice || Object.values(feedback?.messages ?? {}).join(" · ") || `${cancel} ${this.frames.length > 1 ? "back" : "close"} · ${up}/${down} ${choices.length ? "select" : "scroll"}${choices.length ? ` · ${confirm} inspect` : ""}`)));
    output.push(box(fg("dim", `${this.frame.location.kind === "agent" ? `${this.actions.halt ? "h halt · " : ""}${this.actions.kill ? "shift+k kill (confirm) · " : ""}` : ""}${pages} scroll · home/end ${this.page.live ? "top/follow" : "top/bottom"} · ${this.page.live ? this.frame.follow ? "following · " : "scroll paused · " : ""}${progress}`)));
    output.push(edge("╰", "╯"));
    return output.slice(0, height);
  }
}

export async function showInspector(ctx: ExtensionContext, source: InspectorSource, opened?: (panel: InspectorPanel) => void, actions?: InspectorActions) {
  if (ctx.mode !== "tui") return;
  let panel: InspectorPanel | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, keys, done) => {
      panel = new InspectorPanel(source, theme, keys, () => Math.min(36, Math.max(1, tui.terminal.rows - 4)), () => tui.requestRender(), () => done(), actions);
      panel.start(); opened?.(panel); return panel;
    }, { overlay: true, overlayOptions: { width: "90%", anchor: "center", margin: 1 } });
  } finally { panel?.dispose(); }
}
