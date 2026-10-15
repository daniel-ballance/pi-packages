// Parent wake loops: on an interval, start a parent turn with a fixed task until
// the model stops the loop or a policy bound ends it. Ticks only reach an idle
// parent; one that falls due during a turn waits for the turn to settle.

export interface LoopPolicy { enabled: boolean; minIntervalMs: number; maxIterations: number; maxDurationMs: number }
export interface LoopRequest { task: string; intervalMs: number; maxIterations?: number; maxDurationMs?: number }
export interface LoopState {
  task: string; intervalMs: number; iteration: number; maxIterations: number;
  startedAt: number; deadline: number; nextAt: number; due: boolean;
}
export interface LoopTick { task: string; iteration: number; maxIterations: number; intervalMs: number; deadline: number }

const LIMITS = {
  minIntervalMs: [1_000, 86_400_000], maxIterations: [1, 10_000], maxDurationMs: [60_000, 604_800_000],
} as const;

export function parseLoopPolicy(value: unknown): LoopPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("loops must be an object with enabled, minIntervalMs, maxIterations and maxDurationMs");
  const v = value as Record<string, unknown>;
  const keys = ["enabled", ...Object.keys(LIMITS)];
  for (const key of Object.keys(v)) if (!keys.includes(key)) throw new Error(`Unknown loops field: ${key}`);
  if (typeof v.enabled !== "boolean") throw new Error("loops.enabled must be boolean");
  const bounded = Object.fromEntries(Object.entries(LIMITS).map(([key, [min, max]]) => {
    const n = v[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`loops.${key} must be an integer from ${min} to ${max}`);
    return [key, n];
  })) as Omit<LoopPolicy, "enabled">;
  return { enabled: v.enabled, ...bounded };
}

type Timer = unknown;
export interface LoopOptions {
  policy: () => LoopPolicy | undefined;
  idle: () => boolean;
  send: (tick: LoopTick) => void;
  /** requested: the parent stopped it, rather than a bound ending it. */
  ended: (reason: string, state: LoopState, requested: boolean) => void;
  clock?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export class LoopController {
  private state?: LoopState;
  private timer?: Timer;
  private readonly clock: () => number;
  private readonly setTimer: (run: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  constructor(private readonly options: LoopOptions) {
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(request: LoopRequest): LoopState {
    const policy = this.options.policy();
    if (!policy?.enabled) throw new Error("Loops are disabled by the subagents policy; enable them with a \"loops\" field (see the configuration reference).");
    if (this.state) throw new Error(`A loop is already running (${this.state.task}); stop it first.`);
    const task = request.task.trim();
    if (!task) throw new Error("A loop needs a non-empty task.");
    if (!Number.isInteger(request.intervalMs) || request.intervalMs < policy.minIntervalMs) throw new Error(`The interval must be at least ${policy.minIntervalMs} ms.`);
    const maxIterations = request.maxIterations ?? policy.maxIterations;
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > policy.maxIterations) throw new Error(`maxIterations must be from 1 to at most ${policy.maxIterations}.`);
    const maxDurationMs = request.maxDurationMs ?? policy.maxDurationMs;
    if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > policy.maxDurationMs) throw new Error(`maxDurationMs must be at most ${policy.maxDurationMs}.`);
    const startedAt = this.clock();
    this.state = { task, intervalMs: request.intervalMs, iteration: 0, maxIterations, startedAt, deadline: startedAt + maxDurationMs, nextAt: startedAt + request.intervalMs, due: false };
    this.schedule();
    return { ...this.state };
  }

  stop(reason: string): LoopState | undefined {
    return this.end(reason, true);
  }

  status(): LoopState | undefined {
    return this.state && { ...this.state };
  }

  /** The parent settled: deliver a tick that fell due during its turn. */
  settled(): void {
    if (this.state?.due && this.options.idle()) this.fire();
  }

  dispose(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.state = undefined;
  }

  private schedule() {
    if (!this.state) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (!this.state) return;
      if (this.clock() >= this.state.deadline) { this.end(`reached its ${this.state.deadline - this.state.startedAt} ms limit`); return; }
      this.state.due = true;
      if (this.options.idle()) this.fire();
    }, Math.max(0, this.state.nextAt - this.clock()));
  }

  private fire() {
    const state = this.state!;
    state.due = false;
    state.iteration++;
    this.options.send({ task: state.task, iteration: state.iteration, maxIterations: state.maxIterations, intervalMs: state.intervalMs, deadline: state.deadline });
    if (state.iteration >= state.maxIterations) { this.end(`reached ${state.maxIterations} ticks`); return; }
    state.nextAt = this.clock() + state.intervalMs;
    this.schedule();
  }

  private end(reason: string, requested = false): LoopState | undefined {
    const state = this.state;
    if (!state) return undefined;
    this.dispose();
    this.options.ended(reason, state, requested);
    return { ...state };
  }
}

export function formatInterval(ms: number): string {
  for (const [unit, size] of [["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
}

export function parseInterval(text: string): number | undefined {
  const match = /^(\d+)(s|m|h)$/.exec(text);
  return match ? Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"] : undefined;
}

export function describeLoop(state: LoopState): string {
  return `${JSON.stringify(state.task)} every ${formatInterval(state.intervalMs)}, at most ${state.maxIterations} ticks (${state.iteration} so far), until ${new Date(state.deadline).toISOString()}`;
}

/** The parent-turn prompt for one tick. Authored by the parent, not a user message. */
export function loopTickMessage(tick: LoopTick): string {
  return `LOOP TICK ${tick.iteration}/${tick.maxIterations} — an automated wake from subagent_loop, not a user message.\n\n` +
    `Task: ${tick.task}\n\n` +
    `If the task's stop condition holds, call subagent_loop with {"op":"stop"}. Otherwise do the next step and end your turn; ` +
    `the next tick comes in ${formatInterval(tick.intervalMs)}. The loop ends by itself after ${tick.maxIterations} ticks or at ${new Date(tick.deadline).toISOString()}.`;
}
