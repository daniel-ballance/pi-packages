import { dependencies, type WorkflowStep } from "./workflow-definition.js";

export interface WorkflowMapRow {
  key: string;
  step?: WorkflowStep;
  /** Fixed-width lane drawing. A node's ● is replaced with its live status glyph by the caller. */
  prefix: string;
}
export interface WorkflowMap {
  mode: "graph" | "list";
  rows: WorkflowMapRow[];
  /** ╪ is a crossover, never a dependency junction. */
  crossings: boolean;
}

/** Stable topological layers, including implicit seed/input edges. Never depend on execution state. */
function workflowLayers(steps: readonly WorkflowStep[]): WorkflowStep[][] {
  const remaining = new Map(steps.map(step => [step.id, step]));
  const seen = new Set<string>(), layers: WorkflowStep[][] = [];
  while (remaining.size) {
    const layer = [...remaining.values()].filter(step => dependencies(step).every(id => seen.has(id)));
    if (!layer.length) throw new Error("Invalid workflow dependency graph");
    layers.push(layer);
    for (const step of layer) { seen.add(step.id); remaining.delete(step.id); }
  }
  return layers;
}

/**
 * A downward lane graph with one keyboard-selectable node per row. Each lane
 * names a future destination; unrelated wires cross at ╪, not at a junction.
 * Route outgoing edges separately: a shared horizontal bus could incorrectly
 * connect an earlier parent of one destination to the other destinations.
 * Released columns are reused, never shifted, so skipped layers stay legible.
 * Dense/narrow graphs fall back to a prerequisite list rather than losing edges.
 */
export function workflowMap(steps: readonly WorkflowStep[], width: number): WorkflowMap {
  const ordered = workflowLayers(steps).flat();
  const list = (): WorkflowMap => ({ mode: "list", crossings: false,
    rows: ordered.map(step => ({ key: `step:${step.id}`, step, prefix: "" })) });
  if (width < 52) return list();
  const children = new Map(ordered.map(step => [step.id, [] as string[]]));
  for (const step of ordered) for (const parent of dependencies(step)) children.get(parent)!.push(step.id);
  const lanes: (string | undefined)[] = [];
  const rows: WorkflowMapRow[] = [];
  let columns = 0, crossings = false;
  const reserve = (id: string) => {
    let lane = lanes.indexOf(undefined);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = id;
    columns = Math.max(columns, lane + 1);
    return lane;
  };
  const rails = () => lanes.map(id => id === undefined ? " " : "│").join("  ");
  for (const step of ordered) {
    let source = lanes.indexOf(step.id);
    if (source < 0) source = reserve(step.id); // A root, not a fabricated edge from the previous node.
    const node = lanes.map((id, index) => index === source ? "●" : id === undefined ? " " : "│").join("  ");
    rows.push({ key: `step:${step.id}`, step, prefix: node });
    const outgoing = children.get(step.id)!;
    // Continue straight into one NEW destination, only after routing the other
    // edges. Never merge existing parents into the source trunk before a split.
    const continuation = outgoing.find(id => !lanes.includes(id));
    const branches = outgoing.filter(id => id !== continuation);
    for (const [index, child] of branches.entries()) {
      const existing = lanes.includes(child);
      const target = existing ? lanes.indexOf(child) : reserve(child);
      const continuing = index < branches.length - 1 || continuation !== undefined;
      const left = Math.min(source, target) * 3, right = Math.max(source, target) * 3;
      const wire = [...rails()];
      for (let x = left + 1; x < right; x++) {
        if (wire[x] === "│") { wire[x] = "╪"; crossings = true; }
        else wire[x] = "─";
      }
      wire[source * 3] = source < target ? continuing ? "├" : "╰" : continuing ? "┤" : "╯";
      wire[target * 3] = target < source ? existing ? "├" : "╭" : existing ? "┤" : "╮";
      // Arrowheads also prevent a merge from looking like a bidirectional split.
      wire[target * 3 + (target < source ? 1 : -1)] = target < source ? "◀" : "▶";
      rows.push({ key: `edge:${step.id}:${child}`, prefix: wire.join("") });
    }
    lanes[source] = continuation;
    if (!branches.length) rows.push({ key: `after:${step.id}`, prefix: rails() });
    // With a branch, its source's downward stroke already feeds continuation.
    // Without continuation, the final branch turns the source's wire off.
  }
  if (!rows.at(-1)?.step) rows.pop();
  const graphWidth = Math.max(0, columns * 3 - 2);
  // Leave useful room for IDs, status and loop/check information. Avoid a wall
  // of edge routing even when an unusually wide terminal could accommodate it.
  if (graphWidth + 2 + 38 > width || rows.length > ordered.length * 4) return list();
  return { mode: "graph", crossings, rows: rows.map(row => ({ ...row, prefix: row.prefix.padEnd(graphWidth, " ") })) };
}
