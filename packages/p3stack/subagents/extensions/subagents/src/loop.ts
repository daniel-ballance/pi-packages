// Parent wake loops: on an interval, start a parent turn with a fixed task until
// the model stops the loop or a policy bound ends it. Ticks only reach an idle
// parent; one that falls due during a turn waits for the turn to settle.

import { randomUUID } from "node:crypto";

export interface LoopPolicy { enabled: boolean; minIntervalMs: number; maxIterations: number; maxDurationMs: number }
export interface LoopRequest { task: string; intervalMs: number; maxIterations?: number; maxDurationMs?: number }
export interface LoopState {
  task: string; intervalMs: number; iteration: number; maxIterations: number;
  startedAt: number; deadline: number; nextAt: number; due: boolean;
}
export interface LoopTick { id: string; task: string; iteration: number; maxIterations: number; intervalMs: number; deadline: number }

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
  private awaiting?: string;
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
    // Also keeps every timer delay within Node's range (policy durations cap at 7 days).
    if (request.intervalMs >= maxDurationMs) throw new Error(`The interval must be shorter than the run (${maxDurationMs} ms).`);
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
    if (!this.state?.due || !this.options.idle()) return;
    if (this.expired()) return;
    this.fire();
  }

  dispose(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.state = undefined;
    this.awaiting = undefined;
  }

  // One timer, for whichever comes first: the next tick or the deadline. A tick
  // waiting for a busy parent keeps the deadline timer running.
  private schedule() {
    if (!this.state) return;
    const wakeAt = this.state.due ? this.state.deadline : Math.min(this.state.nextAt, this.state.deadline);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (!this.state || this.expired()) return;
      this.state.due = true;
      if (this.options.idle()) this.fire();
      else this.schedule();
    }, Math.max(0, wakeAt - this.clock()));
  }

  private expired(): boolean {
    if (!this.state || this.clock() < this.state.deadline) return false;
    this.end(`reached its ${this.state.deadline - this.state.startedAt} ms limit`);
    return true;
  }

  private fire() {
    const state = this.state!;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    state.due = false;
    const id = this.awaiting = randomUUID(), iteration = state.iteration + 1;
    // Pi's void sendMessage swallows asynchronous delivery errors. Arm the
    // receipt deadline before sending: even a synchronous receipt must count.
    const awaitReceipt = () => {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        if (this.awaiting !== id) return;
        // A busy parent has the tick queued behind compaction, run preparation or a run in
        // progress: it will still be delivered, so keep waiting until the loop's deadline.
        if (!this.options.idle() && this.clock() < state.deadline) { awaitReceipt(); return; }
        this.end(`could not confirm tick ${iteration} delivery: no message_start before timeout`);
      }, Math.max(0, Math.min(10_000, state.deadline - this.clock())));
    };
    awaitReceipt();
    try {
      this.options.send({ id, task: state.task, iteration, maxIterations: state.maxIterations, intervalMs: state.intervalMs, deadline: state.deadline });
    } catch (error) {
      if (this.awaiting === id) this.end(`could not confirm tick ${iteration} delivery: ${error}`);
    }
  }

  delivered(id: unknown) {
    const state = this.state;
    if (!state || !this.awaiting || id !== this.awaiting) return;
    this.awaiting = undefined;
    this.clearTimer(this.timer); this.timer = undefined;
    state.iteration++;
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
