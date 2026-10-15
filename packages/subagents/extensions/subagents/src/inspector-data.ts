import { stripVTControlCharacters } from "node:util";
import type { LiveActivity } from "./activity.js";
import type { AgentRecord, SubagentManager } from "./manager.js";
import { dependencies } from "./workflow-definition.js";
import { workflowMap } from "./workflow-map.js";
import type { WorkflowRun, Workflows } from "./workflows.js";
import { formatFooterStats, reportedCost } from "./usage.js";
import type { PeerBroker } from "./peers.js";

export interface InspectorSource {
  agents(): readonly AgentRecord[];
  workflows(): readonly WorkflowRun[];
  activity(id: string): LiveActivity;
  /** Read-only bounded audit snapshot; does not acknowledge child output. */
  peers?(id: string, since?: number): ReturnType<PeerBroker["inspect"]>;
}
export function inspectorSource(manager: SubagentManager, workflows: Workflows): InspectorSource {
  return {
    agents: () => manager.list().map(agent => manager.get(agent.id)),
    workflows: () => workflows.list(),
    activity: id => manager.activitySnapshot(id),
    peers: (id, since) => {
      if (since !== undefined) return manager.peers.inspect(id, since);
      // Bounded audit (200 retained): walk pages to get the last page relevant to this worker.
      let page = manager.peers.inspect(id, 0);
      while (page.hasMore && page.nextCursor > 0) page = manager.peers.inspect(id, page.nextCursor);
      return page;
    },
  };
}
export type Location = { kind: "overview"; history?: boolean } | { kind: "agent"; id: string } | { kind: "agent-details"; id: string } | { kind: "agent-peers"; id: string; since?: number }
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
  if (["passed", "succeeded", "completed"].includes(status)) return "✓";
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
// Preview only: original task and update bodies remain in details/activity and saved logs.
function preview(text: string, limit: number) {
  const safe = oneLine(text);
  return safe.length > limit ? `${safe.slice(0, limit)}… (more in details / activity)` : safe;
}
const unread = (a: AgentRecord) => (a.resultReview
  ? a.resultReview.status === "unreviewed" || a.updates.some(u => u.cursor > a.readCursor && ["error", "extension_error", "input_requested", "human_intervention"].includes(u.kind))
  : a.updates.some(u => u.cursor > a.readCursor && ["assistant", "error", "extension_error", "input_requested", "aborted", "completed", "failure", "human_intervention"].includes(u.kind)));
const historicalAgent = (a: AgentRecord) => ["idle", "stopped"].includes(a.status) && !unread(a) && !a.hold;
const historicalRun = (r: WorkflowRun, agents: readonly AgentRecord[]) => ["succeeded", "cancelled"].includes(r.status) && !r.unread && !r.interventionHold && !agents.some(a => a.workflow === r.id && a.hold);
const attentionAgent = (a: AgentRecord) => !!a.hold || a.status === "failed" || a.status === "waiting_input";
const attentionRun = (r: WorkflowRun, agents: readonly AgentRecord[]) => !!r.interventionHold || agents.some(a => a.workflow === r.id && a.hold) || ["blocked", "exhausted", "paused", "pausing"].includes(r.status);
const assignment = (a: AgentRecord) => a.assignment;
function latestResult(a: AgentRecord) {
  if (a.assignment?.status === "running" && !a.assignment.resultCursor) return "no result for current assignment yet.";
  const update = a.assignment?.resultCursor
    ? a.updates.find(u => u.cursor === a.assignment!.resultCursor)
    : [...a.updates].reverse().find(u => ["assistant", "error", "failure", "aborted", "completed"].includes(u.kind));
  return update ? `${update.kind}: ${update.text}` : "no result reported yet.";
}

/** Each agent after its nearest ancestor in the same list, otherwise in list order. */
export function treeOrder(list: readonly AgentRecord[], everyone: readonly AgentRecord[] = list): AgentRecord[] {
  const byId = new Map(list.map(agent => [agent.id, agent]));
  const all = new Map(everyone.map(agent => [agent.id, agent]));
  const anchor = (agent: AgentRecord) => {
    const seen = new Set<string>();
    for (let id = agent.parentId; id && !seen.has(id); id = all.get(id)?.parentId) { seen.add(id); if (byId.has(id)) return id; }
    return undefined;
  };
  const below = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];
  for (const agent of list) {
    const parent = anchor(agent);
    if (parent) below.set(parent, [...(below.get(parent) ?? []), agent]); else roots.push(agent);
  }
  const ordered: AgentRecord[] = [];
  const visit = (agent: AgentRecord) => { ordered.push(agent); for (const child of below.get(agent.id) ?? []) visit(child); };
  roots.forEach(visit);
  return ordered;
}

/** Pure presentation projection. In particular, never call inspect(id) or read(id). */
export function inspectorPage(source: InspectorSource, location: Location, now = Date.now(), width = 80): Page {
  const agents = source.agents(), runs = source.workflows();
  const rows: Row[] = [];
  const add = (id: string, text: string, tone: Tone = "text", wrap = true) => rows.push({ id, text, tone, wrap });
  // Rows are grouped by state; within a group a nested Child follows its delegator,
  // indented by depth, and always names who delegated it.
  const delegator = (agent: AgentRecord) => agent.parentId && agents.find(candidate => candidate.id === agent.parentId);
  const indent = (agent: AgentRecord) => agent.parentId ? `${"  ".repeat(Math.max(0, (agent.depth ?? 2) - 2))}↳ ` : "";
  const agentRow = (agent: AgentRecord) => rows.push({ id: `agent:${agent.id}`,
    text: `${mark(agent.status)} ${indent(agent)}${oneLine(agent.name).toLowerCase()} · ${label(agent.status)}${assignment(agent) ? ` · ${assignment(agent)!.status}` : ""}${unread(agent) ? (agent.parentId ? " · unread by its coordinator" : " · parent review needed") : ""}${agent.hold ? ` · ${agent.hold.kind} ${agent.hold.outcome}` : ""}${delegator(agent) ? ` · from ${oneLine((delegator(agent) as AgentRecord).name).toLowerCase()}` : ""} · ${cost(agent)}`,
    tone: statusTone(agent.status), target: { kind: "agent", id: agent.id } });
  if (location.kind === "overview") {
    const runIds = new Set(runs.map(r => r.id));
    const standalone = agents.filter(a => !a.workflow);
    const orphans = agents.filter(a => a.workflow && !runIds.has(a.workflow));
    const displayedRuns = runs.filter(r => historicalRun(r, agents) === !!location.history);
    const displayedAgents = standalone.filter(a => historicalAgent(a) === !!location.history);
    const runRow = (run: WorkflowRun) => {
      const passed = Object.values(run.steps).filter(s => s.status === "passed").length;
      const workers = agents.filter(a => a.workflow === run.id && ["starting", "working", "waiting_input"].includes(a.status)).length;
      const approval = Object.values(run.steps).some(s => s.status === "approval");
      rows.push({ id: `workflow:${run.id}`, text: `${mark(run.status)} ${oneLine(run.definition.name).toLowerCase()} · ${approval ? "approval needed" : label(run.status)}${run.interventionHold || agents.some(a => a.workflow === run.id && a.hold) ? " · intervention hold" : ""} · ${passed}/${run.definition.steps.length} steps · ${workers} active workers${run.unread ? " · parent review needed" : ""}`,
        tone: statusTone(run.status), target: { kind: "workflow", id: run.id } });
    };
    if (location.history) {
      if (displayedRuns.length || displayedAgents.length) add("history-group", "history · reviewed / idle", "dim");
      displayedRuns.forEach(runRow); treeOrder(displayedAgents, agents).forEach(agentRow);
    } else {
      const attentionRuns = displayedRuns.filter(r => attentionRun(r, agents)), attentionAgents = displayedAgents.filter(attentionAgent);
      if (attentionRuns.length || attentionAgents.length) add("attention", "attention · intervention / approval", "warning");
      attentionRuns.forEach(runRow); treeOrder(attentionAgents, agents).forEach(agentRow);
      const workingRuns = displayedRuns.filter(r => !attentionRun(r, agents) && !["succeeded", "cancelled"].includes(r.status));
      const workingAgents = displayedAgents.filter(a => !attentionAgent(a) && !["idle", "stopped"].includes(a.status));
      if (workingRuns.length || workingAgents.length) add("working", "working", "dim");
      workingRuns.forEach(runRow); treeOrder(workingAgents, agents).forEach(agentRow);
      const resultRuns = displayedRuns.filter(r => !attentionRun(r, agents) && !workingRuns.includes(r));
      const resultAgents = displayedAgents.filter(a => !attentionAgent(a) && !workingAgents.includes(a));
      if (resultRuns.length || resultAgents.length) add("results", "results · parent review needed", "warning");
      resultRuns.forEach(runRow); treeOrder(resultAgents, agents).forEach(agentRow);
    }
    if (orphans.length) { add("orphans", "workers · workflow record unavailable", "warning"); orphans.forEach(agentRow); }
    if (!rows.length) add("empty", location.history ? "no completed work." : "no current background work.", "dim");
    if (!location.history) {
      const count = runs.filter(r => historicalRun(r, agents)).length + standalone.filter(historicalAgent).length;
      if (count) rows.push({ id: "history", text: `history · ${count} reviewed / idle entries`, target: { kind: "overview", history: true }, tone: "dim" });
    }
    return { title: location.history ? "subagents / history" : "subagents", subtitle: "inspection does not mark parent reports reviewed · workflow workers grouped by run", rows };
  }
  if (location.kind === "agent" || location.kind === "agent-details" || location.kind === "agent-peers") {
    const agent = agents.find(a => a.id === location.id);
    if (!agent) return { title: "worker unavailable", subtitle: location.id, rows };
    const live = source.activity(agent.id);
    if (location.kind === "agent-peers") {
      const peers = source.peers?.(agent.id, location.since);
      if (!peers) add("unavailable", "peer audit unavailable.", "dim");
      else {
        add("policy", `peer policy ceiling: ${peers.policyCeiling} · retained messages: ${peers.retained}${peers.gap ? " · older history gap" : ""}`, "dim");
        for (const link of peers.links) {
          const allowance = (direction: typeof link.ab) => `${Math.max(0, direction.limit - direction.used)}/${direction.limit} remaining · ${direction.total} lifetime · generation ${direction.generation}`;
          add(`link:${link.a}:${link.b}`, `${link.a} ↔ ${link.b} · ${link.enabled ? "enabled" : "disconnected"}\n${link.a} → ${link.b}: ${allowance(link.ab)}\n${link.b} → ${link.a}: ${allowance(link.ba)}`);
        }
        for (const message of peers.messages) add(`peer-message:${message.id}`, `${message.time} · ${message.senderName.toLowerCase()} → ${message.recipientName.toLowerCase()} · ${message.status}${message.error ? ` · ${message.error}` : ""}\n${message.message}`, ["unknown", "interrupted", "rejected"].includes(message.status) ? "warning" : "text");
        if (location.since === undefined && peers.retained > peers.messages.length) rows.push({ id: "peer-history", text: "browse retained peer history (oldest first)", target: { kind: "agent-peers", id: agent.id, since: 0 } });
        if (peers.hasMore) rows.push({ id: `peer-next:${peers.nextCursor}`, text: "next peer exchanges →", target: { kind: "agent-peers", id: agent.id, since: peers.nextCursor } });
        if (!peers.links.length && !peers.messages.length) add("none", "no peer connections or recent exchanges.", "dim");
      }
      return { title: `${agent.name.toLowerCase()} / peers`, subtitle: `${location.since === undefined ? "recent retained exchanges" : "retained history · oldest first"} · accepted does not prove receipt or model response`, rows };
    }
    if (location.kind === "agent-details") {
      add("identity", `${agent.id} · ${agent.model ?? agent.config.model ?? "model unknown"} · ${agent.thinking ?? "thinking unknown"}`, "dim");
      const stats = formatFooterStats(agent.usage);
      add("usage", `${stats.includes("$") ? stats : `${cost(agent)} · ${stats || "usage unavailable"}`} · created ${age(agent.createdAt, now)} ago`, "dim");
      add("cwd", `working directory: ${agent.config.cwd}`, "dim");
      const selection = agent.config.selection;
      add("tools", `selected tools: ${(selection?.tools ?? agent.config.tools)?.join(", ") || "none / unavailable"}`, "dim");
      for (const kind of ["extensions", "skills", "promptTemplates", "themes"] as const) {
        if (selection?.[kind]?.length) add(kind, `${kind === "promptTemplates" ? "prompt templates" : kind}: ${selection[kind]!.join(", ")}`, "dim");
      }
      add("task-full", `task: ${agent.task}`);
      if (agent.assignment && agent.assignment.task !== agent.task) add("assignment-task", `assignment task: ${agent.assignment.task}`);
      if (agent.pid) add("pid", `process: ${agent.pid}`, "dim");
      if (agent.hold) add("hold-full", `hold: ${agent.hold.kind} ${agent.hold.outcome} at ${agent.hold.at}${agent.hold.detail ? ` · ${agent.hold.detail}` : ""}`, "warning");
      if (agent.config.coordination?.owns?.length) add("owns", `owns: ${agent.config.coordination.owns.join(", ")}`, "dim");
      if (agent.config.coordination?.outputs?.length) add("outputs", `outputs: ${agent.config.coordination.outputs.join(", ")}`, "dim");
      add("session", `saved session: ${agent.sessionFile}`, "dim");
      add("log", `event log: ${agent.logFile}`, "dim");
      return { title: `${agent.name.toLowerCase()} / details`, subtitle: `${label(agent.status)} · metadata`, rows };
    }
    const stats = formatFooterStats(agent.usage);
    const active = assignment(agent);
    if (agent.hold) add("hold", `${agent.hold.kind} ${agent.hold.outcome} at ${agent.hold.at}${agent.hold.detail ? ` · ${preview(agent.hold.detail, 300)}` : ""} · held for explicit parent recovery`, agent.hold.outcome === "failed" ? "error" : "warning");
    add("purpose", `purpose: ${preview(active?.task ?? agent.task, 400)}`);
    const terminal = !!active && active.status !== "running";
    const until = terminal ? Date.parse(active.finishedAt ?? agent.updatedAt) : agent.status === "working" ? now : Date.parse(agent.updatedAt);
    add("current", `now: ${preview(live.phase ?? agent.activity ?? label(agent.status), 160)} · ${label(agent.status)} · elapsed ${age(active?.at ?? agent.startedAt ?? agent.createdAt, until)}${terminal && !active.finishedAt ? " (last observed)" : ""} · last observed ${age(agent.updatedAt, now)} ago`);
    add("result", `latest result · ${preview(latestResult(agent), 600)}`, unread(agent) ? "warning" : "text");
    if (active) {
      const review = agent.resultReview?.assignmentId === active.id ? agent.resultReview.status : undefined;
      add("assignment", `assignment ${active.id}: ${active.status}${review ? ` · parent review ${review}` : ""}`, active.status === "failed" ? "error" : "text");
    }
    add("usage", `${stats.includes("$") ? stats : `${cost(agent)} · ${stats || "usage unavailable"}`} · created ${age(agent.createdAt, now)} ago`, "dim");
    rows.push({ id: "details", text: "details · model, tools, paths and process", tone: "dim", target: { kind: "agent-details", id: agent.id } });
    if (source.peers) rows.push({ id: "peers", text: "peer connections and recent exchanges", tone: "dim", target: { kind: "agent-peers", id: agent.id } });
    if (agent.error) add("error", agent.error, "error");
    if (agent.lastError) add("last-error", `previous error: ${agent.lastError}`, "dim");
    for (const [index, request] of agent.uiRequests.entries()) add(`request:${index}`, `input requested: ${request.title ?? request.method} — respond outside this viewer`, "warning");
    add("activity-heading", "activity · retained updates + transient tools; end follows new output", "dim");
    const events: { id: string; time: string; text: string; tone: Tone }[] = agent.updates.filter(u => u.kind !== "sent").map(u => ({
      id: `update:${u.cursor}`, time: u.time, text: `[${u.time.slice(11, 19)}] ${u.kind}\n${u.text}`, tone: ["error", "failure", "extension_error"].includes(u.kind) ? "error" : "text",
    }));
    for (const tool of live.tools) events.push({ id: `tool:${tool.id}`, time: tool.time,
      text: `[${tool.time.slice(11, 19)}] ${mark(tool.status)} ${tool.name} · ${tool.status}\n${tool.args}${tool.output ? `\n${tool.output}` : ""}`, tone: statusTone(tool.status) });
    events.sort((a, b) => a.time.localeCompare(b.time));
    for (const event of events.slice(-100)) add(event.id, event.text, event.tone);
    if (live.text) add("stream", `writing…\n${live.text}`);
    if (!events.length && !live.text) add("no-output", "no output yet.", "dim");
    return { title: agent.name.toLowerCase(), subtitle: `${label(agent.status)} · parent review: ${unread(agent) ? "needed" : "no unread report"} · ${live.phase ?? agent.activity ?? ""}`, rows, live: true };
  }
  const run = runs.find(r => r.id === location.id);
  if (!run) return { title: "workflow unavailable", subtitle: location.id, rows };
  if (location.kind === "workflow") {
    if (run.interventionHold) add("intervention-hold", `intervention hold at ${run.interventionHold.at}: ${run.interventionHold.reason} · parent recovery required`, "warning");
    add("id", `${run.id} · ${run.definition.cwd}`, "dim");
    add("limits", `${run.usedAttempts}/${run.definition.limits.maxAttempts} attempts · concurrency ${run.definition.limits.concurrency} · deadline ${new Date(run.deadline).toISOString()}`, "dim");
    if (run.reason) add("reason", run.reason, statusTone(run.status));
    const map = workflowMap(run.definition.steps, width);
    add("graph", map.mode === "graph" ? `workflow ↓ · select a step to inspect${map.crossings ? " · ╪ crosses without joining" : ""}` : "prerequisites · compact view · ← names every input", "dim");
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
      if (state.status === "running" && state.activity) add(`activity:${step.id}`, `now · ${step.id}: ${state.activity}`, "accent");
    }
    for (const peer of run.definition.peers ?? []) add(`peer:${peer.a}:${peer.b}`, `peer link: ${peer.a} ↔ ${peer.b} · ${peer.limit} messages/direction`, "dim");
    return { title: run.definition.name.toLowerCase(), subtitle: `${label(run.status)} · ${Object.values(run.steps).filter(s => s.status === "passed").length}/${run.definition.steps.length} steps passed`, rows };
  }
  const step = run.definition.steps.find(s => s.id === location.step), state = run.steps[location.step];
  if (!step || !state) return { title: "step unavailable", subtitle: location.step, rows };
  if (location.kind === "step") {
    add("deps", `prerequisites: ${dependencies(step).join(", ") || "none"}`, "dim");
    if (step.kind !== "check") add("instructions", `instructions: ${step.instructions}`);
    if (step.kind !== "task") add("validator", `validator (${step.validator.kind}): ${step.validator.kind === "command" ? step.validator.command : step.validator.instructions}`);
    if (step.kind === "loop") add("iteration", `${step.mode} · iteration ${state.iteration}/${step.maxIterations}${step.mode === "improve" ? ` · direction ${step.direction} · target ${step.target ?? "none"}` : ""}`);
    if (state.activity && state.status === "running") add("activity", state.activity);
    if (state.feedback) add("feedback", `feedback: ${state.feedback}`, "warning");
    if (state.baselineVerdict) add("baseline-verdict", `best validation: ${state.baselineVerdict.verdict} · score ${state.baselineVerdict.score ?? "n/a"}\n${state.baselineVerdict.findings ?? ""}`, "dim");
    for (const [key, artifact] of [["Output", state.output], ["Best", state.baseline], ["Latest", state.latest]] as const) {
      if (artifact) add(key, `${key.toLowerCase()}: ${artifact.path}\ndigest: ${artifact.digest}\n${artifact.summary}`, "dim");
    }
    add("attempts", "attempts", "dim");
    for (const attempt of state.attempts) rows.push({ id: `attempt:${attempt.number}`,
      text: `${mark(attempt.status)} #${attempt.number} ${attempt.kind} · ${attempt.status}${attempt.verdict ? ` · ${attempt.verdict.verdict}` : ""}${attempt.decision ? ` · ${attempt.decision}` : ""} · ${attempt.children.length} workers`,
      tone: statusTone(attempt.status), target: { kind: "attempt", id: run.id, step: step.id, attempt: attempt.number } });
    if (!state.attempts.length) add("no-attempts", "not attempted yet.", "dim");
    return { title: `${run.definition.name.toLowerCase()} / ${step.id}`, subtitle: `${step.kind} · ${label(state.status)}`, rows };
  }
  const attempt = state.attempts.find(a => a.number === location.attempt);
  if (!attempt) return { title: "attempt unavailable", subtitle: String(location.attempt), rows };
  add("started", `started: ${attempt.started}`, "dim");
  add("directory", `directory / logs: ${attempt.directory}`, "dim");
  if (attempt.error) add("error", attempt.error, "error");
  if (attempt.verdict) add("verdict", `verdict: ${attempt.verdict.verdict} · score ${attempt.verdict.score ?? "n/a"}\n${attempt.verdict.findings ?? ""}`, attempt.verdict.verdict === "pass" ? "success" : "warning");
  if (attempt.decision) add("decision", `decision: ${attempt.decision}`);
  if (attempt.artifact) add("artifact", `artifact: ${attempt.artifact.path}\ndigest: ${attempt.artifact.digest}\n${attempt.artifact.summary}`, "dim");
  add("workers", "workers", "dim");
  for (const id of attempt.children) {
    const agent = agents.find(a => a.id === id);
    if (agent) agentRow(agent); else add(`missing:${id}`, `${id} · worker record unavailable`, "warning");
  }
  if (!attempt.children.length) add("no-workers", "no agent worker (command/human check, or not started).", "dim");
  return { title: `${run.definition.name.toLowerCase()} / ${step.id} / #${attempt.number}`, subtitle: `${attempt.kind} · ${attempt.status}`, rows };
}
