import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LiveActivity } from "./activity.js";
import { cardFromRecord, duration, latestResult, LEGEND, railLine, runCard, STATES, workStyle, type Card, type Group, type Span } from "./card.js";
import type { AgentRecord, SubagentManager } from "./manager.js";
import { dependencies } from "./workflow-definition.js";
import { workflowMap } from "./workflow-map.js";
import type { WorkflowRun, Workflows } from "./workflows.js";
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
export interface Row { id: string; text: string; tone?: Tone; target?: Location; wrap?: boolean; prefix?: string; spans?: readonly Span[] }
export interface Page { title: string | readonly Span[]; subtitle: string; rows: Row[]; live?: boolean }
// Worker output and task names are untrusted terminal content, not ANSI or OSC links.
export const cleanText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
export const oneLine = (text: string) => cleanText(text).replace(/[\r\n]/g, " ");
function label(status: string) { return status === "approval" ? "approval needed" : status.replaceAll("_", " "); }
// Preview only: original task and update bodies remain in details/activity and saved logs.
function preview(text: string, limit: number) {
  const safe = oneLine(text);
  return safe.length > limit ? `${safe.slice(0, limit)}… (more in details / activity)` : safe;
}
const GROUPS: { readonly [G in Group]: { readonly id: string; readonly tone: Tone } } = {
  attention: { id: "attention", tone: "warning" }, working: { id: "working", tone: "dim" },
  results: { id: "results", tone: "warning" }, history: { id: "history-group", tone: "dim" },
};

/** Each agent after its nearest ancestor in the same list, otherwise in list order. */
export function treeOrder<T extends { id: string; parentId?: string }>(list: readonly T[], everyone: readonly { id: string; parentId?: string }[] = list): T[] {
  const byId = new Map(list.map(agent => [agent.id, agent]));
  const all = new Map(everyone.map(agent => [agent.id, agent]));
  const anchor = (agent: T) => {
    const seen = new Set<string>();
    for (let id = agent.parentId; id && !seen.has(id); id = all.get(id)?.parentId) { seen.add(id); if (byId.has(id)) return id; }
    return undefined;
  };
  const below = new Map<string, T[]>();
  const roots: T[] = [];
  for (const agent of list) {
    const parent = anchor(agent);
    if (parent) below.set(parent, [...(below.get(parent) ?? []), agent]); else roots.push(agent);
  }
  const ordered: T[] = [];
  const visit = (agent: T) => { ordered.push(agent); for (const child of below.get(agent.id) ?? []) visit(child); };
  roots.forEach(visit);
  return ordered;
}

/** Pure presentation projection. In particular, never call inspect(id) or read(id). */
export function inspectorPage(source: InspectorSource, location: Location, now = Date.now(), width = 80): Page {
  const agents = source.agents(), runs = source.workflows();
  const rows: Row[] = [];
  const add = (id: string, text: string, tone: Tone = "text", wrap = true) => rows.push({ id, text, tone, wrap });
  const ago = (time: string) => duration(now - Date.parse(time));
  const agentCard = (agent: AgentRecord, live = source.activity(agent.id)) => cardFromRecord(agent,
    { live, delegator: agent.parentId ? agents.find(candidate => candidate.id === agent.parentId)?.name : undefined, now });
  const cardRow = (card: Card) => rows.push({ id: `${card.kind}:${card.id}`, ...railLine(card, width),
    target: card.kind === "workflow" ? { kind: "workflow", id: card.id } : { kind: "agent", id: card.id } });
  const rule = (id: string, label: string, tone: Tone) => add(id, `── ${label} ${"─".repeat(Math.max(0, width - visibleWidth(label) - 4))}`, tone, false);
  if (location.kind === "overview") {
    const runIds = new Set(runs.map(r => r.id));
    const runCards = runs.map(run => runCard(run, agents.filter(a => a.workflow === run.id)));
    const agentCards = agents.filter(a => !a.workflow).map(agent => agentCard(agent));
    const orphans = agents.filter(a => a.workflow && !runIds.has(a.workflow));
    for (const group of location.history ? ["history"] as const : ["attention", "working", "results"] as const) {
      const inGroup = (card: Card) => STATES[card.state].group === group;
      const members = [...runCards.filter(inGroup), ...treeOrder(agentCards.filter(inGroup), agents)];
      if (members.length) { rule(GROUPS[group].id, group, GROUPS[group].tone); members.forEach(cardRow); }
    }
    if (orphans.length) { rule("orphans", "workers · workflow record unavailable", "warning"); orphans.forEach(agent => cardRow(agentCard(agent))); }
    if (!rows.length) add("empty", location.history ? "no completed work." : "no current background work.", "dim");
    if (!location.history) {
      const count = [...runCards, ...agentCards].filter(card => STATES[card.state].group === "history").length;
      if (count) rows.push({ id: "history", text: `history · ${count} reviewed / stopped entries`, target: { kind: "overview", history: true }, tone: "dim" });
    }
    return { title: location.history ? "subagents / history" : "subagents", subtitle: LEGEND, rows };
  }
  if (location.kind === "agent" || location.kind === "agent-details" || location.kind === "agent-peers") {
    const agent = agents.find(a => a.id === location.id);
    if (!agent) return { title: "worker unavailable", subtitle: location.id, rows };
    const live = source.activity(agent.id);
    const card = agentCard(agent, live);
    const word = STATES[card.state].word;
    const usage = `${card.stats.includes("$") ? card.stats : `${card.cost === undefined ? "cost unknown" : `$${card.cost.toFixed(3)}`} · ${card.stats || "usage unavailable"}`} · created ${ago(agent.createdAt)} ago`;
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
      add("usage", usage, "dim");
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
    const active = agent.assignment;
    if (agent.hold) add("hold", `${agent.hold.kind} ${agent.hold.outcome} at ${agent.hold.at}${agent.hold.detail ? ` · ${preview(agent.hold.detail, 300)}` : ""} · held for explicit parent recovery`, agent.hold.outcome === "failed" ? "error" : "warning");
    add("purpose", `purpose: ${preview(active?.task ?? agent.task, 400)}`);
    add("current", `now: ${preview(live.phase ?? agent.activity ?? word, 160)} · ${word} · elapsed ${card.elapsed ? duration(card.elapsed.ms) : "unknown"}${card.elapsed?.lastObserved ? " (last observed)" : ""} · last observed ${ago(agent.updatedAt)} ago`);
    add("result", `latest result · ${preview(latestResult(agent), 600)}`, card.review === "unread" ? "warning" : "text");
    if (active) {
      const review = agent.resultReview?.assignmentId === active.id ? agent.resultReview.status : undefined;
      add("assignment", `assignment ${active.id}: ${active.status}${review ? ` · parent review ${review}` : ""}`, active.status === "failed" ? "error" : "text");
    }
    add("usage", usage, "dim");
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
      text: `[${tool.time.slice(11, 19)}] ${workStyle(tool.status).glyph} ${tool.name} · ${tool.status}\n${tool.args}${tool.output ? `\n${tool.output}` : ""}`, tone: workStyle(tool.status).role });
    events.sort((a, b) => a.time.localeCompare(b.time));
    for (const event of events.slice(-100)) add(event.id, event.text, event.tone);
    if (live.text) add("stream", `writing…\n${live.text}`);
    if (!events.length && !live.text) add("no-output", "no output yet.", "dim");
    return { title: railLine(card, width, true).spans, rows, live: true,
      subtitle: `${card.model ? `${card.model.full}:${card.model.effort ?? "unknown"}` : "model unknown"} · ${word} · parent review: ${card.review === "unread" ? "needed" : "no unread report"}` };
  }
  const run = runs.find(r => r.id === location.id);
  if (!run) return { title: "workflow unavailable", subtitle: location.id, rows };
  if (location.kind === "workflow") {
    if (run.interventionHold) add("intervention-hold", `intervention hold at ${run.interventionHold.at}: ${run.interventionHold.reason} · parent recovery required`, "warning");
    add("id", `${run.id} · ${run.definition.cwd}`, "dim");
    add("limits", `${run.usedAttempts}/${run.definition.limits.maxAttempts} attempts · concurrency ${run.definition.limits.concurrency} · deadline ${new Date(run.deadline).toISOString()}`, "dim");
    if (run.reason) add("reason", run.reason, workStyle(run.status).role);
    const map = workflowMap(run.definition.steps, width);
    add("graph", map.mode === "graph" ? `workflow ↓ · select a step to inspect${map.crossings ? " · ╪ crosses without joining" : ""}` : "prerequisites · compact view · ← names every input", "dim");
    for (const row of map.rows) {
      const step = row.step;
      if (!step) { rows.push({ id: row.key, text: row.prefix, tone: "dim" }); continue; }
      const state = run.steps[step.id];
      const detail = step.kind === "loop" ? `${step.mode} loop ${state.iteration}/${step.maxIterations}` : step.kind === "check" ? `${step.validator.kind} check` : "task";
      const style = workStyle(state.status);
      rows.push({ id: row.key, text: `${map.mode === "list" ? `${style.glyph} ` : ""}${step.id} · ${label(state.status)} · ${detail}`,
        prefix: map.mode === "graph" ? row.prefix.replace("●", style.glyph) + "  " : undefined,
        tone: style.role, target: { kind: "step", id: run.id, step: step.id } });
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
      text: `${workStyle(attempt.status).glyph} #${attempt.number} ${attempt.kind} · ${attempt.status}${attempt.verdict ? ` · ${attempt.verdict.verdict}` : ""}${attempt.decision ? ` · ${attempt.decision}` : ""} · ${attempt.children.length} workers`,
      tone: workStyle(attempt.status).role, target: { kind: "attempt", id: run.id, step: step.id, attempt: attempt.number } });
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
    if (agent) cardRow(agentCard(agent)); else add(`missing:${id}`, `${id} · worker record unavailable`, "warning");
  }
  if (!attempt.children.length) add("no-workers", "no agent worker (command/human check, or not started).", "dim");
  return { title: `${run.definition.name.toLowerCase()} / ${step.id} / #${attempt.number}`, subtitle: `${attempt.kind} · ${attempt.status}`, rows };
}
