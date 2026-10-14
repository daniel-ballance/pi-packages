import { createConnection } from "node:net";

export type HerdrState = "working" | "blocked" | "idle";
export type HerdrSend = (request: Record<string, unknown>) => Promise<void>;
export interface HerdrActivity { children: number; workflows: number }

/**
 * Keeps a herdr pane "working" while subagents run after the parent settles.
 *
 * herdr's Pi integration (`herdr integration install pi`) reports the parent
 * only: it goes idle on agent_settled even with children still running. herdr
 * lets the official `herdr:pi` source hold lifecycle authority and ignores
 * state from other sources, and accepts `herdr:pi` reports only from Pi itself.
 * So this co-reports from the parent process under that source, with a
 * wall-clock seq that outranks the integration's load-time counter.
 *
 * Once engaged the integration's later reports are ignored for the rest of the
 * runtime, so this mirrors its whole state machine (blocked > working > idle)
 * from then on. It stays silent until a subagent first runs, so sessions that
 * never spawn one are untouched. Reload, /new and /resume load fresh modules,
 * and the integration's new counter outranks these reports again.
 *
 * Without the integration installed herdr ignores these reports: a no-op.
 * Labels go through display-only metadata under this package's own source.
 */
export class HerdrStatus {
  private engaged = false;
  private disposed = false;
  private parentActive = false;
  private blockedCount = 0;
  private blockedMessage?: string;
  private activity: HerdrActivity = { children: 0, workflows: 0 };
  private last?: { state: HerdrState; message?: string; label?: string };
  private lastSeq = 0;
  private queue = new Map<string, Record<string, unknown>>();
  private draining = false;

  constructor(
    private readonly paneId: string,
    private readonly send: HerdrSend,
    /** herdr anchors authority to it; a report without one would drop the anchor. */
    private readonly sessionRef: () => Record<string, string>,
    private readonly now = Date.now,
  ) {}

  /** Undefined outside a herdr pane. Pass TUI contexts only: herdr shows PTYs. */
  static fromEnv(env: NodeJS.ProcessEnv, sessionRef: () => Record<string, string>): HerdrStatus | undefined {
    const { HERDR_ENV, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: pane } = env;
    if (HERDR_ENV !== "1" || !socket || !pane) return undefined;
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socket}` : socket;
    return new HerdrStatus(pane, request => sendRequest(endpoint, request), sessionRef);
  }

  /** A reload can replace the extension mid-run without another agent_start. */
  start(parentActive: boolean) { this.parentActive = parentActive; this.publish(); }
  parent(active: boolean) { this.parentActive = active; this.publish(); }
  /** Mirrors the integration's `herdr:blocked` event-bus contract. */
  blocked(data: unknown) {
    const event = data && typeof data === "object" ? data as { active?: unknown; label?: unknown } : {};
    if (!event.active) {
      this.blockedCount = Math.max(0, this.blockedCount - 1);
      if (!this.blockedCount) this.blockedMessage = undefined;
    } else {
      this.blockedCount++;
      this.blockedMessage = typeof event.label === "string" ? event.label : undefined;
    }
    this.publish();
  }
  subagents(activity: HerdrActivity) { this.activity = activity; this.publish(); }
  /**
   * Stop before shutdown stops children, leaving the next runtime to report.
   * Labels and tokens outlive this runtime and Pi itself, so clear any shown.
   */
  dispose(): Promise<void> {
    const shown = !this.disposed && this.last?.label;
    this.disposed = true;
    this.queue.clear();
    if (!shown) return Promise.resolve();
    const seq = this.seq();
    return this.send({ id: `pi-subagents:metadata:${seq}`, ...this.metadata(undefined, seq) }).catch(() => {});
  }

  private publish() {
    const running = this.activity.children + this.activity.workflows;
    if (this.disposed || (!this.engaged && !running)) return;
    this.engaged = true;
    const state: HerdrState = this.blockedCount ? "blocked" : this.parentActive || running ? "working" : "idle";
    const message = state === "blocked" ? this.blockedMessage : undefined;
    const label = running ? (this.parentActive ? `working + ${describe(this.activity)}` : describe(this.activity)) : undefined;
    const last = this.last;
    this.last = { state, message, label };
    if (!last || last.state !== state || last.message !== message) {
      this.enqueue("state", { method: "pane.report_agent", params: {
        pane_id: this.paneId, source: "herdr:pi", agent: "pi", state, message, seq: this.seq(), ...this.sessionRef(),
      } });
    }
    if (last?.label !== label) {
      this.enqueue("metadata", this.metadata(label && describe(this.activity), this.seq(), label));
    }
  }

  private metadata(token: string | undefined, seq: number, label?: string) {
    return { method: "pane.report_metadata", params: {
      pane_id: this.paneId, source: "pi-subagents", applies_to_source: "herdr:pi", seq,
      ...label ? { state_labels: { working: label } } : { clear_state_labels: true },
      tokens: { subagents: token ?? null },
    } };
  }

  /** herdr ignores a source's reports at or below its last accepted seq. */
  private seq() { return this.lastSeq = Math.max(this.now() * 1000 + 999, this.lastSeq + 1); }

  /** Latest report per kind wins; seqs keep superseded deliveries harmless. */
  private enqueue(kind: string, request: Record<string, unknown>) {
    this.queue.delete(kind);
    this.queue.set(kind, { id: `pi-subagents:${kind}:${this.lastSeq}`, ...request });
    void this.drain();
  }
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.entries().next(); !next.done; next = this.queue.entries().next()) {
        this.queue.delete(next.value[0]);
        await this.send(next.value[1]).catch(() => {}); // Cosmetic: never disturb the session.
      }
    } finally { this.draining = false; }
  }
}

function describe({ children, workflows }: HerdrActivity): string {
  const parts = [];
  if (children) parts.push(`${children} subagent${children === 1 ? "" : "s"}`);
  if (workflows) parts.push(`${workflows} workflow${workflows === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** One newline-delimited JSON request per connection, as herdr's integration does. */
async function sendRequest(endpoint: string, request: Record<string, unknown>) {
  if (!await attempt(endpoint, request, 500)) await attempt(endpoint, request, 1500);
}
function attempt(endpoint: string, request: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(endpoint);
    const finish = (delivered: boolean) => { clearTimeout(timer); socket.destroy(); resolve(delivered); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
  });
}
