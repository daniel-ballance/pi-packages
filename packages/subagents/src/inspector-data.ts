import { stripVTControlCharacters } from "node:util";
import type { LiveActivity } from "./activity.js";
import type { AgentRecord, SubagentManager } from "./manager.js";
import { dependencies } from "./workflow-definition.js";
import { workflowMap } from "./workflow-map.js";
import type { WorkflowRun, Workflows } from "./workflows.js";
import { formatFooterStats, reportedCost } from "./usage.js";

export interface InspectorSource {
  agents(): readonly AgentRecord[];
  workflows(): readonly WorkflowRun[];
  activity(id: string): LiveActivity;
}
export function inspectorSource(manager: SubagentManager, workflows: Workflows): InspectorSource {
  return {
    agents: () => manager.list().map(agent => manager.get(agent.id)),
    workflows: () => workflows.list(),
    activity: id => manager.activitySnapshot(id),
  };
}
export type Location = { kind: "overview"; history?: boolean } | { kind: "agent"; id: string }
  | { kind: "workflow"; id: string } | { kind: "step"; id: string; step: string }
  | { kind: "attempt"; id: string; step: string; attempt: number };
export type Tone = "text" | "dim" | "accent" | "warning" | "error" | "success";
export interface Row { id: string; text: string; tone?: Tone; target?: Location; wrap?: boolean; prefix?: string }
export interface Page { title: string; subtitle: string; rows: Row[]; live?: boolean }
// Worker output and task names are untrusted terminal content, not ANSI or OSC links.
export const cleanText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
export const oneLine = (text: string) => cleanText(text).replace(/[\r\n]/g, " ");
export function statusTone(status: string): Tone {
  if (["failed", "error", "exhausted"].includes(status)) return "error";
  if (["blocked", "approval", "waiting_input", "paused", "pausing", "interrupted"].includes(status)) return "warning";
  if (["working", "running", "starting"].includes(status)) return "accent";
  return "dim";
}
function mark(status: string) {
  if (["passed", "succeeded", "completed", "idle"].includes(status)) return "✓";
  if (["working", "running", "starting"].includes(status)) return "●";
  if (["blocked", "approval", "waiting_input", "paused", "pausing"].includes(status)) return "◇";
  if (["failed", "error", "exhausted", "interrupted"].includes(status)) return "!";
  return "·";
}
function label(status: string) { return status === "approval" ? "approval needed" : status.replaceAll("_", " "); }
function cost(agent: AgentRecord) { const value = reportedCost(agent.usage); return value === undefined ? "cost unknown" : `$${value.toFixed(3)}`; }
function age(start: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(start)) / 1000));
  return Number.isFinite(seconds) ? seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` : "unknown";
}
const historicalAgent = (a: AgentRecord) => ["idle", "stopped"].includes(a.status);
const historicalRun = (r: WorkflowRun) => ["succeeded", "cancelled"].includes(r.status);

/** Pure presentation projection. In particular, never call inspect(id) or read(id). */
export function inspectorPage(source: InspectorSource, location: Location, now = Date.now(), width = 80): Page {
  const agents = source.agents(), runs = source.workflows();
  const rows: Row[] = [];
  const add = (id: string, text: string, tone: Tone = "text", wrap = true) => rows.push({ id, text, tone, wrap });
  const agentRow = (agent: AgentRecord) => rows.push({ id: `agent:${agent.id}`,
    text: `${mark(agent.status)} ${oneLine(agent.name)} · ${label(agent.status)} · ${cost(agent)}`,
    tone: statusTone(agent.status), target: { kind: "agent", id: agent.id } });
  if (location.kind === "overview") {
    const runIds = new Set(runs.map(r => r.id));
    const standalone = agents.filter(a => !a.workflow);
    const orphans = agents.filter(a => a.workflow && !runIds.has(a.workflow));
    const displayedRuns = runs.filter(r => historicalRun(r) === !!location.history);
    const displayedAgents = standalone.filter(a => historicalAgent(a) === !!location.history);
    if (displayedRuns.length) {
      add("workflows", "WORKFLOWS", "dim");
      for (const run of displayedRuns) {
        const passed = Object.values(run.steps).filter(s => s.status === "passed").length;
        const workers = agents.filter(a => a.workflow === run.id && ["starting", "working", "waiting_input"].includes(a.status)).length;
        const approval = Object.values(run.steps).some(s => s.status === "approval");
        rows.push({ id: `workflow:${run.id}`, text: `${mark(run.status)} ${oneLine(run.definition.name)} · ${approval ? "approval needed" : label(run.status)} · ${passed}/${run.definition.steps.length} steps · ${workers} active workers`,
          tone: statusTone(run.status), target: { kind: "workflow", id: run.id } });
      }
    }
    if (displayedAgents.length) { add("standalone", "STANDALONE AGENTS", "dim"); displayedAgents.forEach(agentRow); }
    if (orphans.length) { add("orphans", "WORKERS — WORKFLOW RECORD UNAVAILABLE", "warning"); orphans.forEach(agentRow); }
    if (!rows.length) add("empty", location.history ? "No completed work." : "No current background work.", "dim");
    if (!location.history) {
      const count = runs.filter(historicalRun).length + standalone.filter(historicalAgent).length;
      if (count) rows.push({ id: "history", text: `History · ${count} completed / idle entries`, target: { kind: "overview", history: true }, tone: "dim" });
    }
    return { title: location.history ? "Subagents / History" : "Subagents", subtitle: "Read-only inspector · workflow workers are grouped with their run", rows };
  }
  if (location.kind === "agent") {
    const agent = agents.find(a => a.id === location.id);
    if (!agent) return { title: "Worker unavailable", subtitle: location.id, rows };
    const live = source.activity(agent.id);
    add("identity", `${agent.id} · ${agent.model ?? agent.config.model ?? "model unknown"} · ${agent.thinking ?? "thinking unknown"}`, "dim");
    const stats = formatFooterStats(agent.usage);
    add("usage", `${stats.includes("$") ? stats : `${cost(agent)} · ${stats || "usage unavailable"}`} · created ${age(agent.createdAt, now)} ago`, "dim");
    add("cwd", `Working directory: ${agent.config.cwd}`, "dim");
    const selection = agent.config.selection;
    add("tools", `Selected tools: ${(selection?.tools ?? agent.config.tools)?.join(", ") || "none / unavailable"}`, "dim");
    for (const kind of ["extensions", "skills", "promptTemplates", "themes"] as const) {
      if (selection?.[kind]?.length) add(kind, `${kind}: ${selection[kind]!.join(", ")}`, "dim");
    }
    if (agent.pid) add("pid", `Process: ${agent.pid}`, "dim");
    add("task", `Task: ${agent.task}`);
    if (agent.error) add("error", agent.error, "error");
    if (agent.lastError) add("last-error", `Previous error: ${agent.lastError}`, "dim");
    for (const [index, request] of agent.uiRequests.entries()) add(`request:${index}`, `Input requested: ${request.title ?? request.method} — respond outside this viewer`, "warning");
    add("session", `Saved session: ${agent.sessionFile}`, "dim");
    add("log", `Event log: ${agent.logFile}`, "dim");
    add("activity-heading", "ACTIVITY · retained updates + transient tools; End follows new output", "dim");
    const events: { id: string; time: string; text: string; tone: Tone }[] = agent.updates.filter(u => u.kind !== "sent").map(u => ({
      id: `update:${u.cursor}`, time: u.time, text: `[${u.time.slice(11, 19)}] ${u.kind}\n${u.text}`, tone: ["error", "failure", "extension_error"].includes(u.kind) ? "error" : "text",
    }));
    for (const tool of live.tools) events.push({ id: `tool:${tool.id}`, time: tool.time,
      text: `[${tool.time.slice(11, 19)}] ${mark(tool.status)} ${tool.name} · ${tool.status}\n${tool.args}${tool.output ? `\n${tool.output}` : ""}`, tone: statusTone(tool.status) });
    events.sort((a, b) => a.time.localeCompare(b.time));
    for (const event of events.slice(-100)) add(event.id, event.text, event.tone);
    if (live.text) add("stream", `Writing…\n${live.text}`);
    if (!events.length && !live.text) add("no-output", "No output yet.", "dim");
    return { title: agent.name, subtitle: `${label(agent.status)} · ${live.phase ?? agent.activity ?? ""}`, rows, live: true };
  }
  const run = runs.find(r => r.id === location.id);
  if (!run) return { title: "Workflow unavailable", subtitle: location.id, rows };
  if (location.kind === "workflow") {
    add("id", `${run.id} · ${run.definition.cwd}`, "dim");
    add("limits", `${run.usedAttempts}/${run.definition.limits.maxAttempts} attempts · concurrency ${run.definition.limits.concurrency} · deadline ${new Date(run.deadline).toISOString()}`, "dim");
    if (run.reason) add("reason", run.reason, statusTone(run.status));
    const map = workflowMap(run.definition.steps, width);
    add("graph", map.mode === "graph" ? `WORKFLOW ↓ · select a step to inspect${map.crossings ? " · ╪ crosses without joining" : ""}` : "PREREQUISITES · compact view · ← names every input", "dim");
    for (const row of map.rows) {
      const step = row.step;
      if (!step) { rows.push({ id: row.key, text: row.prefix, tone: "dim" }); continue; }
      const state = run.steps[step.id];
      const detail = step.kind === "loop" ? `${step.mode} loop ${state.iteration}/${step.maxIterations}` : step.kind === "check" ? `${step.validator.kind} check` : "task";
      rows.push({ id: row.key, text: `${map.mode === "list" ? `${mark(state.status)} ` : ""}${step.id} · ${label(state.status)} · ${detail}`,
        prefix: map.mode === "graph" ? row.prefix.replace("●", mark(state.status)) + "  " : undefined,
        tone: statusTone(state.status), target: { kind: "step", id: run.id, step: step.id } });
      if (map.mode === "list") add(`deps:${step.id}`, `  ← ${dependencies(step).join(" + ") || "start"}`, "dim");
    }
    for (const step of run.definition.steps) {
      const state = run.steps[step.id];
      if (state.status === "running" && state.activity) add(`activity:${step.id}`, `Now · ${step.id}: ${state.activity}`, "accent");
    }
    for (const peer of run.definition.peers ?? []) add(`peer:${peer.a}:${peer.b}`, `Peer link: ${peer.a} ↔ ${peer.b} · ${peer.limit} messages/direction`, "dim");
    return { title: run.definition.name, subtitle: `${label(run.status)} · ${Object.values(run.steps).filter(s => s.status === "passed").length}/${run.definition.steps.length} steps passed`, rows };
  }
  const step = run.definition.steps.find(s => s.id === location.step), state = run.steps[location.step];
  if (!step || !state) return { title: "Step unavailable", subtitle: location.step, rows };
  if (location.kind === "step") {
    add("deps", `Prerequisites: ${dependencies(step).join(", ") || "none"}`, "dim");
    if (step.kind !== "check") add("instructions", `Instructions: ${step.instructions}`);
    if (step.kind !== "task") add("validator", `Validator (${step.validator.kind}): ${step.validator.kind === "command" ? step.validator.command : step.validator.instructions}`);
    if (step.kind === "loop") add("iteration", `${step.mode} · iteration ${state.iteration}/${step.maxIterations}${step.mode === "improve" ? ` · direction ${step.direction} · target ${step.target ?? "none"}` : ""}`);
    if (state.activity && state.status === "running") add("activity", state.activity);
    if (state.feedback) add("feedback", `Feedback: ${state.feedback}`, "warning");
    if (state.baselineVerdict) add("baseline-verdict", `Best validation: ${state.baselineVerdict.verdict} · score ${state.baselineVerdict.score ?? "n/a"}\n${state.baselineVerdict.findings ?? ""}`, "dim");
    for (const [key, artifact] of [["Output", state.output], ["Best", state.baseline], ["Latest", state.latest]] as const) {
      if (artifact) add(key, `${key}: ${artifact.path}\nDigest: ${artifact.digest}\n${artifact.summary}`, "dim");
    }
    add("attempts", "ATTEMPTS", "dim");
    for (const attempt of state.attempts) rows.push({ id: `attempt:${attempt.number}`,
      text: `${mark(attempt.status)} #${attempt.number} ${attempt.kind} · ${attempt.status}${attempt.verdict ? ` · ${attempt.verdict.verdict}` : ""}${attempt.decision ? ` · ${attempt.decision}` : ""} · ${attempt.children.length} workers`,
      tone: statusTone(attempt.status), target: { kind: "attempt", id: run.id, step: step.id, attempt: attempt.number } });
    if (!state.attempts.length) add("no-attempts", "Not attempted yet.", "dim");
    return { title: `${run.definition.name} / ${step.id}`, subtitle: `${step.kind} · ${label(state.status)}`, rows };
  }
  const attempt = state.attempts.find(a => a.number === location.attempt);
  if (!attempt) return { title: "Attempt unavailable", subtitle: String(location.attempt), rows };
  add("started", `Started: ${attempt.started}`, "dim");
  add("directory", `Directory / logs: ${attempt.directory}`, "dim");
  if (attempt.error) add("error", attempt.error, "error");
  if (attempt.verdict) add("verdict", `Verdict: ${attempt.verdict.verdict} · score ${attempt.verdict.score ?? "n/a"}\n${attempt.verdict.findings ?? ""}`, attempt.verdict.verdict === "pass" ? "success" : "warning");
  if (attempt.decision) add("decision", `Decision: ${attempt.decision}`);
  if (attempt.artifact) add("artifact", `Artifact: ${attempt.artifact.path}\nDigest: ${attempt.artifact.digest}\n${attempt.artifact.summary}`, "dim");
  add("workers", "WORKERS", "dim");
  for (const id of attempt.children) {
    const agent = agents.find(a => a.id === id);
    if (agent) agentRow(agent); else add(`missing:${id}`, `${id} · worker record unavailable`, "warning");
  }
  if (!attempt.children.length) add("no-workers", "No agent worker (command/human check, or not started).", "dim");
  return { title: `${run.definition.name} / ${step.id} / #${attempt.number}`, subtitle: `${attempt.kind} · ${attempt.status}`, rows };
}
