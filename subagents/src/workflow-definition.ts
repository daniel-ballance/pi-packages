import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { SubagentPolicy } from "./policy.js";

const text = Type.String({ minLength: 1, maxLength: 20000 });
const id = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" });
const strings = Type.Optional(Type.Array(Type.String()));
export const WorkerSchema = Type.Object({
  model: Type.String(), tools: Type.Array(Type.String()), extensions: strings, skills: strings,
  promptTemplates: strings, themes: strings, systemPrompt: Type.Optional(Type.String()),
  appendSystemPrompt: Type.Optional(Type.String()), contextFiles: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const agent = { worker: WorkerSchema, instructions: text };
export const ValidatorSchema = Type.Union([
  Type.Object({ kind: Type.Literal("command"), command: text }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("agent"), ...agent }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("human"), instructions: text }, { additionalProperties: false }),
]);
const base = { id, dependsOn: Type.Optional(Type.Array(id)) };
const task = Type.Object({ ...base, kind: Type.Literal("task"), ...agent, seed: Type.Optional(id) }, { additionalProperties: false });
const check = Type.Object({ ...base, kind: Type.Literal("check"), input: id, validator: ValidatorSchema }, { additionalProperties: false });
const loop = Type.Object({ ...base, kind: Type.Literal("loop"), ...agent, seed: Type.Optional(id), validator: ValidatorSchema,
  mode: Type.Union([Type.Literal("repair"), Type.Literal("improve")]),
  maxIterations: Type.Integer({ minimum: 1, maximum: 100 }),
  direction: Type.Optional(Type.Union([Type.Literal("min"), Type.Literal("max")])),
  minImprovement: Type.Optional(Type.Number({ minimum: 0 })), target: Type.Optional(Type.Number()),
}, { additionalProperties: false });
export const WorkflowSchema = Type.Object({
  version: Type.Literal(1), name: Type.String({ minLength: 1, maxLength: 120 }), cwd: Type.String(),
  limits: Type.Object({ concurrency: Type.Integer({ minimum: 1, maximum: 64 }), maxAttempts: Type.Integer({ minimum: 1, maximum: 1000 }), timeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }) }, { additionalProperties: false }),
  steps: Type.Array(Type.Union([task, check, loop]), { minItems: 1, maxItems: 64 }),
  peers: Type.Optional(Type.Array(Type.Object({ a: id, b: id, limit: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false }), { maxItems: 64 })),
}, { additionalProperties: false });
export type WorkflowDefinition = Static<typeof WorkflowSchema>;
export type WorkflowStep = WorkflowDefinition["steps"][number];
export type Worker = Static<typeof WorkerSchema>;
export type Validator = Static<typeof ValidatorSchema>;
export type PeerLink = NonNullable<WorkflowDefinition["peers"]>[number];
export const dependencies = (s: WorkflowStep) => [...new Set([...(s.dependsOn ?? []), ...(s.kind === "check" ? [s.input] : s.seed ? [s.seed] : [])])];

/** Structural checks only; live model/tool/directory policy is checked separately. */
export function parseWorkflow(value: unknown): WorkflowDefinition {
  if (!Check(WorkflowSchema, value)) throw new Error(`Invalid workflow: ${JSON.stringify([...Errors(WorkflowSchema, value)].slice(0, 3))}`);
  const def = structuredClone(value);
  const steps = new Map(def.steps.map(s => [s.id, s]));
  if (steps.size !== def.steps.length) throw new Error("Workflow step IDs must be unique");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Workflow dependencies must form a DAG");
    if (visited.has(id)) return;
    const step = steps.get(id); if (!step) throw new Error(`Unknown dependency: ${id}`);
    visiting.add(id); dependencies(step).forEach(visit); visiting.delete(id); visited.add(id);
  };
  def.steps.forEach(s => {
    visit(s.id);
    if (s.kind === "loop") {
      if (s.validator.kind === "human") throw new Error("Put human approval after a loop, not inside it");
      if (s.mode === "improve" && (!s.seed || !s.direction)) throw new Error("Improvement loops require seed and direction");
      if (s.mode === "repair" && (s.direction !== undefined || s.target !== undefined || s.minImprovement !== undefined)) throw new Error("Score settings only apply to improvement loops");
    }
  });
  const pairs = new Set<string>();
  for (const link of def.peers ?? []) {
    const a = steps.get(link.a), b = steps.get(link.b), key = [link.a, link.b].sort().join(":");
    if (!a || !b || a === b || a.kind !== "task" || b.kind !== "task") throw new Error("Peer links require two distinct task steps");
    if (pairs.has(key)) throw new Error("Duplicate peer link"); pairs.add(key);
    if (JSON.stringify(dependencies(a).sort()) !== JSON.stringify(dependencies(b).sort())) throw new Error("Peer task steps must have the same dependencies");
    if (![a, b].every(s => s.worker.tools.includes("peer_send"))) throw new Error("Peer task workers must select peer_send");
  }
  if (workUnits(def).some(unit => unit.length > def.limits.concurrency)) throw new Error("Concurrency must accommodate each connected peer group");
  return def;
}

/** Connected tasks start and settle together. Unlinked steps are single units. */
export function workUnits(def: WorkflowDefinition): string[][] {
  const units = def.steps.map(s => [s.id]);
  for (const { a, b } of def.peers ?? []) {
    const first = units.find(u => u.includes(a))!, second = units.find(u => u.includes(b))!;
    if (first !== second) { first.push(...second); units.splice(units.indexOf(second), 1); }
  }
  return units;
}
export function authorizeWorkflow(def: WorkflowDefinition, policy: SubagentPolicy) {
  policy.directory(def.cwd);
  if (def.limits.concurrency > (policy.config?.maxChildren ?? 0)) throw new Error("Workflow concurrency exceeds policy maxChildren");
  const validate = (v: Validator) => {
    if (v.kind === "agent") policy.compile(def.cwd, v.worker);
    if (v.kind === "command") policy.commandDirectory(def.cwd);
  };
  for (const s of def.steps) {
    if (s.kind !== "check") policy.compile(def.cwd, s.worker);
    if (s.kind !== "task") validate(s.validator);
  }
  if ((def.peers ?? []).some(l => l.limit > (policy.config?.peerMessageLimit ?? 0))) throw new Error("Workflow peer limit exceeds current policy");
}
