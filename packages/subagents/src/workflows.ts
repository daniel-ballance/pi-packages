import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidateDirectory, snapshot, verifyArtifact, type Artifact } from "./workflow-artifacts.js";
import { dependencies, parseWorkflow, workUnits, type WorkflowDefinition, type WorkflowStep, type Validator } from "./workflow-definition.js";
import type { AgentJob, WorkflowHost } from "./workflow-host.js";
import type { Notice } from "./manager.js";

export interface Verdict { verdict: "pass" | "fail" | "blocked"; findings?: string; score?: number }
export interface Attempt {
  number: number; kind: "task" | "check"; status: "running" | "completed" | "interrupted" | "error" | "waiting";
  directory: string; started: string; children: string[]; artifact?: Artifact; verdict?: Verdict; error?: string;
  decision?: "keep" | "discard" | "revise";
}
export interface StepState {
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "interrupted" | "exhausted" | "approval";
  iteration: number; attempts: Attempt[]; activity?: string; output?: Artifact; latest?: Artifact; baseline?: Artifact; baselineVerdict?: Verdict; feedback?: string;
}
export interface WorkflowRun {
  id: string; definition: WorkflowDefinition; directory: string; created: string; deadline: number;
  status: "running" | "pausing" | "paused" | "blocked" | "succeeded" | "exhausted" | "cancelled";
  reason?: string; usedAttempts: number; steps: Record<string, StepState>; noticeRevision: number; unread: boolean;
}
class Exhausted extends Error {}
const terminal = new Set(["succeeded", "exhausted", "cancelled"]);
function enforcePrivatePath(path: string, mode: number, directory: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe workflow state path: ${path}`);
  chmodSync(path, mode);
}
function enforcePrivatePathIfPresent(path: string, mode: number, directory: boolean) {
  try { enforcePrivatePath(path, mode, directory); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function parseVerdict(text: string): Verdict {
  const value = JSON.parse(text.trim());
  if (!value || !["pass", "fail", "blocked"].includes(value.verdict) ||
      (value.findings !== undefined && typeof value.findings !== "string") ||
      (value.score !== undefined && (typeof value.score !== "number" || !Number.isFinite(value.score)))) throw new Error("Evaluator must return {verdict: pass|fail|blocked, findings?: string, score?: finite number}");
  return { verdict: value.verdict, findings: value.findings?.slice(0, 4000), score: value.score };
}

/** One active run per parent. A small DAG scheduler, not a second child manager. */
export class Workflows {
  private runs = new Map<string, WorkflowRun>();
  private execution?: { id: string; controller: AbortController; active: Map<string, Promise<void>>; timer: NodeJS.Timeout };
  private closed = false;
  constructor(readonly directory: string, private host: WorkflowHost, private changed: () => void = () => {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    enforcePrivatePath(directory, 0o700, true);
    for (const name of readdirSync(directory)) {
      const runDirectory = join(directory, name), path = join(runDirectory, "run.json");
      if (!existsSync(path)) continue;
      enforcePrivatePath(runDirectory, 0o700, true);
      enforcePrivatePath(path, 0o600, false);
      const run = JSON.parse(readFileSync(path, "utf8")) as WorkflowRun;
      run.definition = parseWorkflow(run.definition);
      if (["running", "pausing"].includes(run.status)) {
        run.status = "paused"; run.reason = "Parent stopped. Interrupted work requires explicit retry; nothing was replayed.";
        for (const state of Object.values(run.steps)) {
          if (state.status === "running") state.status = "interrupted";
          for (const a of state.attempts) if (a.status === "running") a.status = "interrupted";
        }
        run.unread = true; run.noticeRevision++;
      }
      this.runs.set(run.id, run);
    }
  }
  private save(run: WorkflowRun) {
    const path = join(run.directory, "run.json"), temp = path + ".tmp";
    enforcePrivatePath(run.directory, 0o700, true);
    enforcePrivatePathIfPresent(temp, 0o600, false);
    writeFileSync(temp, JSON.stringify(run, null, 2), { mode: 0o600 });
    enforcePrivatePath(temp, 0o600, false); renameSync(temp, path); enforcePrivatePath(path, 0o600, false); this.changed();
  }
  /** Presentation-only enumeration: unlike inspect(id), does not acknowledge notices. */
  list(): readonly WorkflowRun[] { return [...this.runs.values()]; }
  get(id: string) { const run = this.runs.get(id); if (!run) throw new Error(`Unknown workflow: ${id}`); return run; }
  private notify(run: WorkflowRun) { run.unread = true; run.noticeRevision++; this.save(run); }
  pendingNotices(): Notice[] {
    return [...this.runs.values()].filter(r => r.unread).map(r => ({ id: r.id, name: `Workflow: ${r.definition.name}`, kind: r.status,
      text: `${r.reason ?? "All steps completed"}. ${r.usedAttempts}/${r.definition.limits.maxAttempts} attempts. Inspect with subagent_workflow_inspect.`,
      cursor: r.noticeRevision, key: `${r.id}:${r.noticeRevision}:workflow` }));
  }
  markNoticesDelivered(keys: string[]) {
    for (const notice of this.pendingNotices()) if (keys.includes(notice.key)) { const r = this.get(notice.id); r.unread = false; this.save(r); }
  }
  inspect(id?: string, step?: string) {
    const summary = (r: WorkflowRun) => ({ id: r.id, name: r.definition.name, status: r.status, reason: r.reason, usedAttempts: r.usedAttempts,
      limits: r.definition.limits, remainingSeconds: Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000)), directory: r.directory,
      steps: Object.entries(r.steps).map(([id, s]) => ({ id, status: s.status, activity: s.status === "running" ? s.activity : undefined, iteration: s.iteration, attempts: s.attempts.length,
        children: s.attempts.flatMap(a => a.children), output: s.output, best: s.baseline, latestVerdict: s.attempts.findLast(a => a.verdict)?.verdict, latestError: s.attempts.findLast(a => a.error)?.error })) });
    if (!id) return { runs: [...this.runs.values()].map(summary) };
    const run = this.get(id);
    if (step && !run.steps[step]) throw new Error(`Unknown workflow step: ${step}`);
    run.unread = false; this.save(run);
    return step ? { ...summary(run), step, detail: run.steps[step] } : summary(run);
  }
  start(value: unknown) {
    if (this.closed) throw new Error("Workflow runtime is shutting down");
    if (this.execution) throw new Error("Another workflow is running; pause/cancel it first");
    const definition = parseWorkflow(value); this.host.authorize(definition);
    const id = `workflow-${randomUUID().slice(0, 8)}`, directory = join(this.directory, id);
    mkdirSync(directory, { mode: 0o700 });
    enforcePrivatePath(directory, 0o700, true);
    const run: WorkflowRun = { id, definition, directory, created: new Date().toISOString(), deadline: Date.now() + definition.limits.timeoutSeconds * 1000,
      status: "running", usedAttempts: 0, noticeRevision: 0, unread: false,
      steps: Object.fromEntries(definition.steps.map(s => [s.id, { status: "pending", iteration: 0, attempts: [] }])) };
    this.runs.set(id, run); this.save(run); this.launch(run);
    return this.inspect(id);
  }
  private launch(run: WorkflowRun) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      run.status = "exhausted"; run.reason = "Run deadline reached"; controller.abort(); this.save(run); this.schedule(run);
    }, Math.max(1, run.deadline - Date.now()));
    this.execution = { id: run.id, controller, active: new Map(), timer };
    this.schedule(run);
  }
  private schedule(run: WorkflowRun) {
    const execution = this.execution;
    if (!execution || execution.id !== run.id) return;
    if (run.status === "running") {
      for (const unit of workUnits(run.definition)) {
        if (!unit.every(id => run.steps[id].status === "pending")) continue;
        if (!unit.every(id => dependencies(run.definition.steps.find(s => s.id === id)!).every(dep => run.steps[dep].status === "passed"))) continue;
        const occupied = [...execution.active.keys()].reduce((n, key) => n + key.split(",").length, 0);
        if (occupied + unit.length > run.definition.limits.concurrency) continue;
        unit.forEach(id => { run.steps[id].status = "running"; }); this.save(run);
        const key = unit.join(",");
        const promise = Promise.resolve().then(() => this.runUnit(run, unit, execution.controller.signal)).catch(error => {
          const interrupted = execution.controller.signal.aborted;
          for (const id of unit) {
            const state = run.steps[id];
            if (state.status === "running") state.status = interrupted ? "interrupted" : error instanceof Exhausted ? "exhausted" : "blocked";
            for (const attempt of state.attempts) if (attempt.status === "running") { attempt.status = interrupted ? "interrupted" : "error"; attempt.error = String(error); }
          }
          if (!interrupted) { run.status = error instanceof Exhausted ? "exhausted" : "blocked"; run.reason = String(error); execution.controller.abort(); }
          this.save(run);
        }).finally(() => { execution.active.delete(key); this.schedule(run); });
        execution.active.set(key, promise);
      }
    }
    if (execution.active.size) return;
    if (run.status === "running") {
      if (Object.values(run.steps).every(s => s.status === "passed")) { run.status = "succeeded"; run.reason = "All required steps completed"; }
      else { run.status = "blocked"; run.reason ??= "No runnable steps; inspect validation results"; }
    }
    if (run.status === "pausing") { run.status = "paused"; run.reason = "Paused at a step/iteration boundary"; }
    clearTimeout(execution.timer); this.execution = undefined; this.notify(run);
  }
  private allocate(run: WorkflowRun, step: string, kind: Attempt["kind"]): Attempt {
    if (run.usedAttempts >= run.definition.limits.maxAttempts) throw new Exhausted("Total attempt allowance exhausted (workers and checks both count)");
    const number = ++run.usedAttempts, directory = join(run.directory, `${number}-${step}-${kind}`);
    mkdirSync(directory, { mode: 0o700 });
    enforcePrivatePath(directory, 0o700, true);
    const a: Attempt = { number, kind, directory, started: new Date().toISOString(), status: "running", children: [] };
    run.steps[step].attempts.push(a); this.save(run); return a;
  }
  private inputs(run: WorkflowRun, step: WorkflowStep) {
    return Object.fromEntries(dependencies(step).map(id => {
      const artifact = run.steps[id].output; if (!artifact) throw new Error(`Missing accepted input: ${id}`);
      verifyArtifact(artifact); return [id, artifact];
    }));
  }
  private job(run: WorkflowRun, step: string, worker: AgentJob["worker"], instructions: string, attempt: Attempt, candidate: string, inputs: Record<string, Artifact>, feedback?: string): AgentJob {
    return { workflow: run.id, step, cwd: run.definition.cwd, worker, instructions, candidate, inputs, feedback,
      onChild: id => { attempt.children.push(id); this.save(run); },
      onActivity: text => { run.steps[step].activity = text; this.save(run); } };
  }
  private async runUnit(run: WorkflowRun, ids: string[], signal: AbortSignal) {
    signal.throwIfAborted(); this.host.authorize(run.definition);
    const steps = ids.map(id => run.definition.steps.find(s => s.id === id)!);
    if (steps.every(s => s.kind === "task")) {
      if (run.usedAttempts + steps.length > run.definition.limits.maxAttempts) throw new Exhausted("Not enough attempts for the task group");
      const attempts = steps.map(s => this.allocate(run, s.id, "task"));
      const jobs = steps.map((s, i) => this.job(run, s.id, s.worker, s.instructions, attempts[i],
        candidateDirectory(join(attempts[i].directory, "candidate"), s.seed ? run.steps[s.seed].output : undefined), this.inputs(run, s)));
      const replies = await this.host.agents(jobs, (run.definition.peers ?? []).filter(l => ids.includes(l.a)), signal);
      signal.throwIfAborted();
      steps.forEach(s => this.inputs(run, s));
      steps.forEach((s, i) => {
        const artifact = snapshot(jobs[i].candidate, join(attempts[i].directory, "artifact"), replies[i]);
        attempts[i].artifact = artifact; attempts[i].status = "completed"; run.steps[s.id].output = artifact; run.steps[s.id].status = "passed";
      });
    } else {
      const step = steps[0];
      if (step.kind === "check") {
        const artifact = this.inputs(run, step)[step.input];
        const verdict = await this.evaluate(run, step.id, step.validator, artifact, signal);
        if (verdict) {
          run.steps[step.id].status = verdict.verdict === "pass" ? "passed" : verdict.verdict === "fail" ? "failed" : "blocked";
          if (verdict.verdict === "pass") run.steps[step.id].output = artifact;
          else this.block(run, `${step.id}: ${verdict.findings ?? verdict.verdict}`);
        }
      } else if (step.kind === "loop") await this.loop(run, step, signal);
    }
    this.save(run);
  }
  private block(run: WorkflowRun, reason: string) {
    run.status = "blocked"; run.reason = reason; this.execution?.controller.abort(); this.save(run);
  }
  private async evaluate(run: WorkflowRun, step: string, validator: Validator, artifact: Artifact, signal: AbortSignal): Promise<Verdict | undefined> {
    signal.throwIfAborted(); verifyArtifact(artifact);
    const attempt = this.allocate(run, step, "check"); attempt.artifact = artifact; this.save(run);
    if (validator.kind === "human") {
      attempt.status = "waiting"; run.steps[step].status = "approval";
      this.block(run, `Human approval required for ${step}: ${validator.instructions}`); return undefined;
    }
    let verdict: Verdict;
    if (validator.kind === "agent") {
      const instructions = `${validator.instructions}\nEvaluate input artifact candidate. Do not modify it. Return ONLY JSON {"verdict":"pass"|"fail"|"blocked","findings":"evidence and reasons","score":optional finite number}. Agreement is not proof; cite evidence.`;
      const [reply] = await this.host.agents([this.job(run, step, validator.worker, instructions, attempt,
        candidateDirectory(join(attempt.directory, "review")), { candidate: artifact })], [], signal);
      verdict = parseVerdict(reply);
    } else {
      run.steps[step].activity = "Running deterministic check"; this.save(run);
      const result = await this.host.command(validator.command, run.definition.cwd, { WORKFLOW_CANDIDATE: artifact.path, WORKFLOW_RUN: run.directory, WORKFLOW_ATTEMPT: attempt.directory }, attempt.directory, signal);
      if (result.code !== 0 && result.code !== 1) throw new Error(`Evaluator execution failed with exit ${result.code}; see ${attempt.directory}/command.log`);
      const last = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
      verdict = last.startsWith("{") ? parseVerdict(last) : { verdict: result.code === 0 ? "pass" : "fail", findings: result.stdout.slice(-4000) };
      if (result.code === 1 && verdict.verdict === "pass") throw new Error("Evaluator returned pass but exited 1");
    }
    signal.throwIfAborted(); verifyArtifact(artifact);
    attempt.verdict = verdict; attempt.status = "completed"; this.save(run); return verdict;
  }
  private async loop(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "loop" }>, signal: AbortSignal) {
    const state = run.steps[step.id], inputs = this.inputs(run, step);
    if (step.mode === "improve" && !state.baseline) {
      const seed = inputs[step.seed!], verdict = (await this.evaluate(run, step.id, step.validator, seed, signal))!;
      if (verdict.verdict !== "pass" || verdict.score === undefined) throw new Error("Improvement baseline needs a passing verdict and finite score");
      state.baseline = seed; state.baselineVerdict = verdict; state.attempts.at(-1)!.decision = "keep"; this.save(run);
    }
    const targetReached = () => step.target !== undefined && state.baselineVerdict?.score !== undefined &&
      (step.direction === "min" ? state.baselineVerdict.score <= step.target : state.baselineVerdict.score >= step.target);
    while (state.iteration < step.maxIterations && !targetReached()) {
      signal.throwIfAborted();
      if (run.status === "pausing") { state.status = "pending"; return; }
      state.iteration++; this.save(run);
      const attempt = this.allocate(run, step.id, "task");
      const seed = step.mode === "improve" ? state.baseline : state.latest ?? (step.seed ? inputs[step.seed] : undefined);
      const candidate = candidateDirectory(join(attempt.directory, "candidate"), seed);
      const [reply] = await this.host.agents([this.job(run, step.id, step.worker,
        `${step.instructions}\nIteration ${state.iteration}/${step.maxIterations}; mode ${step.mode}. Accepted baseline score: ${state.baselineVerdict?.score ?? "none"}.`,
        attempt, candidate, inputs, state.feedback)], [], signal);
      signal.throwIfAborted();
      Object.values(inputs).forEach(verifyArtifact); if (seed) verifyArtifact(seed);
      const artifact = snapshot(candidate, join(attempt.directory, "artifact"), reply);
      attempt.artifact = artifact; attempt.status = "completed"; state.latest = artifact; this.save(run);
      const verdict = (await this.evaluate(run, step.id, step.validator, artifact, signal))!;
      state.feedback = JSON.stringify(verdict);
      if (verdict.verdict === "blocked") { state.status = "blocked"; this.block(run, `${step.id}: ${verdict.findings ?? "validator blocked"}`); return; }
      const evaluation = state.attempts.at(-1)!;
      evaluation.decision = step.mode === "repair" ? "revise" : "discard";
      if (step.mode === "repair" && verdict.verdict === "pass") { evaluation.decision = "keep"; state.output = artifact; state.status = "passed"; return; }
      if (step.mode === "improve" && verdict.verdict === "pass") {
        if (verdict.score === undefined) throw new Error("Improvement evaluator must report a finite score");
        const delta = step.direction === "min" ? state.baselineVerdict!.score! - verdict.score : verdict.score - state.baselineVerdict!.score!;
        if (delta > (step.minImprovement ?? 0)) { state.baseline = artifact; state.baselineVerdict = verdict; evaluation.decision = "keep"; }
      }
      this.save(run);
    }
    if (step.mode === "improve") state.output = state.baseline;
    if (step.mode === "improve" && (step.target === undefined || targetReached())) state.status = "passed";
    else { state.status = "exhausted"; throw new Exhausted(`${step.id}: iteration limit reached without satisfying acceptance`); }
  }
  async control(id: string, action: "pause" | "resume" | "cancel", retry: string[] = []) {
    const run = this.get(id);
    if (action === "resume") {
      if (this.closed || this.execution) throw new Error("Runtime busy or shutting down");
      if (!["paused", "blocked"].includes(run.status)) throw new Error("Only paused/blocked runs can resume");
      this.host.authorize(run.definition);
      const retryIds = new Set(retry);
      for (const unit of workUnits(run.definition)) if (unit.some(id => retryIds.has(id))) unit.forEach(id => retryIds.add(id));
      for (const step of retryIds) if (!run.steps[step] || !["interrupted", "blocked", "failed", "pending", "passed"].includes(run.steps[step].status)) throw new Error(`Cannot retry ${step}`);
      if (Object.entries(run.steps).some(([id, s]) => ["interrupted", "failed", "blocked"].includes(s.status) && !retryIds.has(id))) throw new Error("Specify retry step IDs explicitly; interrupted work may have side effects");
      if (Object.values(run.steps).some(s => s.status === "approval")) throw new Error("Human approval is pending; use /workflows approve or reject");
      // Retrying a previously passed peer sibling must not invalidate completed dependents.
      for (const s of run.definition.steps) if (dependencies(s).some(dep => retryIds.has(dep)) && run.steps[s.id].status !== "pending" && !retryIds.has(s.id)) throw new Error("Retry would invalidate completed downstream work; start a new workflow");
      retryIds.forEach(id => { run.steps[id].status = "pending"; delete run.steps[id].output; });
      if (Date.now() >= run.deadline || run.usedAttempts >= run.definition.limits.maxAttempts) { run.status = "exhausted"; run.reason = "Original run allowance exhausted; resume does not replenish it"; this.notify(run); }
      else { run.status = "running"; delete run.reason; this.save(run); this.launch(run); }
    } else if (action === "pause") {
      if (run.status !== "running") throw new Error("Workflow is not running");
      run.status = "pausing"; run.reason = "Pause requested; current steps/iterations may finish"; this.save(run); this.schedule(run);
    } else {
      if (terminal.has(run.status)) return this.inspect(id);
      run.status = "cancelled"; run.reason = "Cancelled by parent; artifacts retained, edits outside candidates not rolled back"; this.save(run);
      if (this.execution?.id === id) { this.execution.controller.abort(); await Promise.all(this.execution.active.values()); }
      else this.notify(run);
    }
    return this.inspect(id);
  }
  /** Called only by the human slash command, never a model-facing approval tool. */
  decide(id: string, step: string, decision: "pass" | "fail") {
    const run = this.get(id), state = run.steps[step];
    if (run.status !== "blocked" || state?.status !== "approval") throw new Error("No pending human approval for this step");
    const attempt = state.attempts.at(-1)!; verifyArtifact(attempt.artifact!);
    attempt.verdict = { verdict: decision, findings: "Human decision via /workflows" }; attempt.status = "completed";
    state.status = decision === "pass" ? "passed" : "failed";
    if (decision === "pass") state.output = attempt.artifact;
    run.reason = `Human ${decision} for ${step}; resume explicitly`; this.save(run); return this.inspect(id);
  }
  async shutdown() {
    this.closed = true;
    if (!this.execution) return;
    const execution = this.execution, run = this.get(execution.id);
    run.status = "paused"; run.reason = "Parent stopped; explicitly retry interrupted steps before continuing";
    execution.controller.abort(); this.save(run);
    await Promise.all(execution.active.values());
    if (this.execution) this.schedule(run);
  }
}
