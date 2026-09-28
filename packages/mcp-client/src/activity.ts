import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { displayText } from './diagnostics.js';

/** Delayed UI-only feedback for work without a native tool-call surface. */
export class McpActivity {
  private pending = new Map<symbol, { label: string; started: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private visible = false;
  constructor(private context: () => ExtensionContext | undefined) {}

  begin(label: string): () => void {
    if (!this.context()?.hasUI) return () => {};
    const id = Symbol();
    this.pending.set(id, { label: displayText(label, 100), started: Date.now() });
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 1000);
      this.timer.unref();
    }
    return () => {
      this.pending.delete(id);
      if (!this.pending.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      this.render();
    };
  }

  private render() {
    const ctx = this.context();
    if (!ctx?.hasUI) return;
    const waiting = [...this.pending.values()].filter((item) => Date.now() - item.started >= 2000);
    if (waiting.length) {
      const first = waiting[0];
      ctx.ui.setStatus(
        'mcp-activity',
        ctx.ui.theme.fg(
          'muted',
          `MCP · ${first.label} · ${Math.floor((Date.now() - first.started) / 1000)}s${waiting.length > 1 ? ` (+${waiting.length - 1})` : ''}`,
        ),
      );
      this.visible = true;
    } else if (this.visible) {
      ctx.ui.setStatus('mcp-activity', undefined);
      this.visible = false;
    }
  }

  async run<T>(label: string, work: () => Promise<T>): Promise<T> {
    const finish = this.begin(label);
    try {
      return await work();
    } finally {
      finish();
    }
  }

  clear() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.render();
  }
}
