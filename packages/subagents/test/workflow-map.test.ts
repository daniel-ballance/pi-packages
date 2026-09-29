import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowMap, type WorkflowMap } from "../extensions/subagents/src/workflow-map.js";
import { dependencies, type WorkflowStep } from "../extensions/subagents/src/workflow-definition.js";

const task = (id: string, dependsOn: string[] = []): WorkflowStep => ({ id, kind: "task", dependsOn, worker: { model: "test/stub:off", tools: [] }, instructions: id });
const expectedEdges = (steps: readonly WorkflowStep[]) => steps.flatMap(step => dependencies(step).map(parent => `${parent}->${step.id}`)).sort();

/** Independently walk the printed wires, respecting arrowheads and crossovers.
 * Stops at the next node: this checks immediate edges, not transitive reachability. */
function drawnEdges(map: WorkflowMap): string[] {
  assert.equal(map.mode, "graph");
  const edges = new Set<string>();
  const masks: Record<string, string> = { "│": "UD", "─": "LR", "╰": "UR", "╯": "UL", "╭": "DR", "╮": "DL", "├": "UDR", "┤": "UDL", "╪": "UDLR", "▶": "LR", "◀": "LR", "●": "UD" };
  const vectors = { D: [0, 1], L: [-1, 0], R: [1, 0] } as const;
  const opposite = { D: "U", L: "R", R: "L" } as const;
  for (const [startY, row] of map.rows.entries()) {
    if (!row.step) continue;
    const seen = new Set<string>();
    const visit = (x: number, y: number, from: string): void => {
      const key = `${x}:${y}:${from}`;
      if (seen.has(key)) return;
      seen.add(key);
      const glyph = map.rows[y]?.prefix[x], ports = masks[glyph];
      if (!ports?.includes(from)) return;
      if (glyph === "▶" && from !== "L" || glyph === "◀" && from !== "R") return;
      if (glyph === "●") { edges.add(`${row.step!.id}->${map.rows[y].step!.id}`); return; }
      for (const direction of ["D", "L", "R"] as const) {
        if (direction === from || !ports.includes(direction)) continue;
        if (glyph === "╪" && ((from === "U") !== (direction === "D"))) continue;
        const [dx, dy] = vectors[direction];
        visit(x + dx, y + dy, opposite[direction]);
      }
    };
    visit(row.prefix.indexOf("●"), startY + 1, "U");
  }
  return [...edges].sort();
}

test("diamond draws connected fan-out and fan-in, one selectable node per row", () => {
  const steps = [task("gather"), task("security", ["gather"]), task("compat", ["gather"]), task("join", ["security", "compat"]), task("approve", ["join"])];
  const map = workflowMap(steps, 90);
  assert.deepEqual(map.rows.map(row => row.prefix.trimEnd()), ["●", "├─▶╮", "●  │", "│  │", "│  ●", "├◀─╯", "●", "│", "●"]);
  assert.deepEqual(map.rows.flatMap(row => row.step ? [row.step.id] : []), steps.map(step => step.id));
  assert.deepEqual(drawnEdges(map), expectedEdges(steps));
});

test("skipped layers and independent roots never become fabricated dependencies", () => {
  const steps = [task("a"), task("independent"), task("b", ["a"]), task("c", ["b"]), task("join", ["a", "c"])];
  const map = workflowMap(steps, 120);
  assert.deepEqual(drawnEdges(map), expectedEdges(steps));
  assert.ok(!drawnEdges(map).some(edge => edge.includes("independent")));
  assert.deepEqual(drawnEdges(workflowMap([task("only")], 80)), []);
});

test("multiple merges and splits do not mix earlier parents into unrelated branches", () => {
  const steps = [task("a"), task("b"), task("c", ["a"]), task("d", ["b"]), task("e", ["a", "d"]), task("f", ["b", "c", "d"]), task("join", ["e", "f"])];
  const map = workflowMap(steps, 120);
  assert.deepEqual(drawnEdges(map), expectedEdges(steps));
});

test("arbitrary small DAGs preserve exactly their edges, including crossings", () => {
  let seed = 142, crossed = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let n = 0; n < 300; n++) {
    const steps: WorkflowStep[] = [];
    const count = 3 + Math.floor(random() * 12);
    for (let i = 0; i < count; i++) steps.push(task(`s${i}`, steps.filter(() => random() < 0.25).map(step => step.id)));
    // Input order is not required to be topological.
    if (n % 2) steps.reverse();
    const map = workflowMap(steps, 1000);
    assert.equal(map.mode, "graph");
    if (map.crossings) { crossed++; assert.ok(map.rows.some(row => row.prefix.includes("╪"))); }
    assert.deepEqual(drawnEdges(map), expectedEdges(steps), `graph ${n}`);
  }
  assert.ok(crossed > 0, "fixture set must exercise crossovers");
});

test("implicit seed/input edges are drawn; loops remain one node, not fictitious DAG cycles", () => {
  const steps: WorkflowStep[] = [task("seed"), { id: "improve", kind: "loop", seed: "seed", worker: { model: "test/stub:off", tools: [] }, instructions: "improve", mode: "improve", direction: "max", maxIterations: 5, validator: { kind: "command", command: "true" } },
    { id: "check", kind: "check", input: "improve", validator: { kind: "human", instructions: "Approve?" } }];
  assert.deepEqual(drawnEdges(workflowMap(steps, 80)), ["improve->check", "seed->improve"]);
});

test("narrow and dense graphs fall back without dropping nodes or prerequisites", () => {
  const steps = [task("root"), ...Array.from({ length: 63 }, (_, i) => task(`branch${i}`, ["root"]))];
  const before = structuredClone(steps);
  for (const width of [1, 10, 40, 80, 140]) {
    const map = workflowMap(steps, width);
    assert.equal(map.mode, "list");
    assert.deepEqual(map.rows.map(row => row.step), steps);
  }
  const dense = Array.from({ length: 32 }, (_, i) => task(`s${i}`, Array.from({ length: i }, (_, j) => `s${j}`)));
  assert.equal(workflowMap(dense, 1000).mode, "list", "route density also triggers the fallback");
  assert.deepEqual(steps, before, "layout is read-only");
});
