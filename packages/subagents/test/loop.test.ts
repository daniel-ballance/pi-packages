import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy } from "../extensions/subagents/src/policy.js";
import { LoopController, type LoopTick } from "../extensions/subagents/src/loop.js";

const base = { version: 1, models: [{ id: "p/m:off" }] };
const loops = { enabled: true, minIntervalMs: 60_000, maxIterations: 3, maxDurationMs: 600_000 };

test("loops are off unless a policy enables them, with every ceiling explicit", () => {
  assert.equal(parsePolicy(base).loops, undefined);
  assert.deepEqual(parsePolicy({ ...base, loops }).loops, loops);
  for (const bad of [
    { ...loops, enabled: "yes" }, { ...loops, minIntervalMs: 500 }, { ...loops, maxIterations: 0 },
    { ...loops, maxDurationMs: 30_000 }, { ...loops, extra: 1 }, { enabled: true }, [],
  ]) assert.throws(() => parsePolicy({ ...base, loops: bad }), /loops/, JSON.stringify(bad));
});

function harness(policy: typeof loops | null = loops) {
  let now = 0, idle = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const ticks: LoopTick[] = [], ended: string[] = [];
  const controller = new LoopController({
    policy: () => policy ?? undefined,
    idle: () => idle,
    send: tick => ticks.push(tick),
    ended: reason => ended.push(reason),
    clock: () => now,
    setTimer: (run, ms) => { timers.set(++nextTimer, { at: now + ms, run }); return nextTimer; },
    clearTimer: id => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.run(); }
    }
  };
  return { controller, ticks, ended, advance, setIdle: (value: boolean) => { idle = value; }, timers };
}

test("start is refused when loops are disabled or a request exceeds a ceiling", () => {
  assert.throws(() => harness(null).controller.start({ task: "check CI", intervalMs: 60_000 }), /disabled/);
  const { controller } = harness();
  assert.throws(() => controller.start({ task: "check CI", intervalMs: 10_000 }), /at least 60000/);
  assert.throws(() => controller.start({ task: "check CI", intervalMs: 60_000, maxIterations: 4 }), /at most 3/);
  assert.throws(() => controller.start({ task: "check CI", intervalMs: 60_000, maxDurationMs: 700_000 }), /at most 600000/);
  assert.throws(() => controller.start({ task: "  ", intervalMs: 60_000 }), /task/);
});

test("ticks wake an idle parent on the interval and the loop ends after its iterations", () => {
  const { controller, ticks, ended, advance } = harness();
  const state = controller.start({ task: "check CI", intervalMs: 60_000 });
  assert.equal(state.maxIterations, 3);
  advance(59_999);
  assert.equal(ticks.length, 0);
  advance(1);
  assert.deepEqual(ticks.map(tick => [tick.iteration, tick.maxIterations, tick.task]), [[1, 3, "check CI"]]);
  advance(60_000); advance(60_000);
  assert.deepEqual(ticks.map(tick => tick.iteration), [1, 2, 3]);
  assert.deepEqual(ended, ["reached 3 ticks"]);
  assert.equal(controller.status(), undefined);
  advance(600_000);
  assert.equal(ticks.length, 3);
});

test("a tick that falls due while the parent works waits for it to settle, and never stacks", () => {
  const { controller, ticks, advance, setIdle } = harness();
  controller.start({ task: "check CI", intervalMs: 60_000 });
  setIdle(false);
  advance(60_000); advance(60_000); advance(60_000);
  assert.equal(ticks.length, 0);
  assert.equal(controller.status()?.due, true);
  setIdle(true);
  controller.settled();
  assert.deepEqual(ticks.map(tick => tick.iteration), [1]);
  controller.settled();
  assert.equal(ticks.length, 1, "one due tick, delivered once");
});

test("stopping or exhausting the duration ends the loop without another tick", () => {
  const stopped = harness();
  stopped.controller.start({ task: "check CI", intervalMs: 60_000 });
  assert.equal(stopped.controller.stop("model stopped it")?.task, "check CI");
  stopped.advance(120_000);
  assert.deepEqual([stopped.ticks.length, stopped.ended], [0, ["model stopped it"]]);
  assert.equal(stopped.controller.stop("again"), undefined);

  const timed = harness();
  timed.controller.start({ task: "check CI", intervalMs: 60_000, maxIterations: 3, maxDurationMs: 90_000 });
  timed.advance(60_000);
  timed.advance(60_000);
  assert.deepEqual(timed.ticks.map(tick => tick.iteration), [1]);
  assert.deepEqual(timed.ended, ["reached its 90000 ms limit"]);
});

test("one loop per parent, and a new start after the end is allowed", () => {
  const { controller, advance } = harness();
  controller.start({ task: "a", intervalMs: 60_000, maxIterations: 1 });
  assert.throws(() => controller.start({ task: "b", intervalMs: 60_000 }), /already running/);
  advance(60_000);
  assert.equal(controller.start({ task: "b", intervalMs: 60_000 }).task, "b");
});
