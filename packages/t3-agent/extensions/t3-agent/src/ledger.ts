// The handle ledger remembers the T3 objects this session created (delegated tasks,
// schedules, watched pull requests, launched threads, preview tabs, devices). T3 tool
// results carry the identifiers only once; after compaction the model would otherwise
// lose the taskId it needs for task_cancel, or forget the tab it must close.

import { createHash } from "node:crypto";

const KINDS = ["delegate", "schedule", "pr", "thread", "preview", "device"] as const;
export type HandleKind = (typeof KINDS)[number];

const TERMINAL = ["completed", "failed", "cancelled", "canceled", "interrupted", "stopped"] as const;
const STATES = [...TERMINAL, "queued", "starting", "running", "waiting", "working", "waiting_for_children",
  "result_available", "cancelling", "enabled", "paused", "deleted", "watching", "unwatched"] as const;
type State = (typeof STATES)[number];

export interface Handle {
  kind: HandleKind;
  id: string;
  target?: Target;
  hostId?: string; // part of a device's identity
  explicitTitle?: string; // Old `title` fields could contain prompt text; never replay them.
  link?: string;
  status?: State;
  open: boolean;
}

interface Target { threadId?: string; environmentId?: string }
export interface ReceiptScope extends Target { sessionId: string }

export const ENTRY_TYPE = "t3-agent.handle";
const MAX_LINES = 24;
const MAX_THREADS = 5;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
// IDs must survive verbatim for later tool calls. Reject unsafe or overlong IDs rather than truncate.
const safeId = (value: unknown) => typeof value === "string" && /^[\w][\w.:-]{0,255}$/.test(value) ? value : undefined;

// T3 uses encodeURIComponent on the command id inside the delegated node id.
function taskId(value: string): string | undefined {
  return value.length <= 256 && /^node:delegated-task:(?:[\w.!~*'()-]|%[\da-fA-F]{2})+$/.test(value) ? value : safeId(value);
}

function safeTitle(value: unknown): string | undefined {
  const line = text(value)?.split(/[\r\n]/, 1)[0];
  // Drop URL-like titles rather than copying even part of a credential or webhook path.
  if (!line || /[\/\\?@#=]/.test(line)) return undefined;
  const clean = line.replace(/[^\p{L}\p{M}\p{N} .,:'()-]+/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > 70 ? `${clean.slice(0, 69)}…` : clean || undefined;
}

function threadLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  // T3 returns bare URLs, autolinks and Markdown links. Never retain the supplied label.
  const href = value.match(/^\[[^\n]*\]\((.+)\)$/)?.[1] ?? value;
  const url = URL.parse(href.replace(/^<(.+)>$/, "$1"));
  if (!url || url.pathname.length > 480) return undefined;
  if (url.protocol === "t3-thread:" && !url.port) {
    const path = url.hostname === "v1" ? /^\/[\w.%:-]+$/ : url.hostname === "v2" ? /^\/[\w.%:-]+\/[\w.%:-]+$/ : undefined;
    if (path?.test(url.pathname)) return `<t3-thread://${url.hostname}${url.pathname}>`;
  }
  if (url.origin === "https://app.t3.codes" && /^\/threads\/[\w%-]+\/[\w%-]+$/.test(url.pathname)) return url.origin + url.pathname;
  return undefined;
}

const forgeRoutes = new Map([
  ["github.com", "pull"], ["gitlab.com", "-/merge_requests"], ["bitbucket.org", "pull-requests"],
  ["codeberg.org", "pulls"], ["dev.azure.com", "pullrequest"],
]);

function repoNumber(repository: unknown, number: unknown): string | undefined {
  if (typeof repository !== "string" || repository.length > 256 || !/^(?:[\w.-]+\/)+[\w.-]+$/.test(repository) ||
    repository.split("/").some(part => part === "." || part === "..") ||
    typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
  return `${repository.toLowerCase()}#${number}`;
}

function forgeKey(host: unknown, repository: unknown, number: unknown): string | undefined {
  if (typeof host !== "string" || host.length > 253 || !/^[\w-]+(?:\.[\w-]+)*(?::\d{1,5})?$/.test(host) ||
    typeof repository !== "string" || !repoNumber(repository, number)) return undefined;
  const authority = host.toLowerCase(), repo = repository.toLowerCase();
  const route = forgeRoutes.get(authority);
  if (!route) return `${repo}#${number}@${authority}`; // Reported self-hosted target, not a verified web link.
  if (authority === "dev.azure.com" ? !/\/_git\/[\w.-]+$/.test(repo) : authority !== "gitlab.com" && repo.split("/").length !== 2) return undefined;
  return `https://${authority}/${repo}/${route}/${number}`;
}

function keyFromForgeUrl(value: string): string | undefined {
  if (value.length > 2048) return undefined;
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || !forgeRoutes.has(url.host)) return undefined;
  const match = /^\/(.+?)\/(pull|pulls|pull-requests|-\/merge_requests|pullrequest)\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  return match && match[2] === forgeRoutes.get(url.host) ? forgeKey(url.host, match[1], Number(match[3])) : undefined;
}

// The old URL-only writer could mistake a callback path for a repository. Match a later
// structured result by digest without copying that path into another prompt or entry.
function legacyAlias(key: string): string {
  return `legacy:${createHash("sha256").update(key).digest("hex").slice(0, 24)}${key.slice(key.indexOf("#"))}`;
}

function prId(value: string, oldWatch: boolean): string | undefined {
  if (value.length > 2048) return undefined;
  const scoped = /^([\w./-]+)#([1-9]\d*)(?:@([\w.:-]+))?$/.exec(value);
  if (scoped) return scoped[3] ? forgeKey(scoped[3], scoped[1], Number(scoped[2])) : repoNumber(scoped[1], Number(scoped[2]));
  if (/^legacy:[a-f\d]{24}#[1-9]\d{0,15}@[\w.:-]{1,253}$/.test(value)) return value;
  const known = keyFromForgeUrl(value);
  if (known || !oldWatch) return known;
  const url = URL.parse(value);
  // Old entries stored canonical HTTPS links, without userinfo, suffix, query or fragment.
  if (url?.protocol !== "https:" || forgeRoutes.has(url.host) || url.origin + url.pathname !== value) return undefined;
  const match = /^\/(.+?)\/(?:pull|pulls|pull-requests|-\/merge_requests|pullrequest)\/([1-9]\d*)$/.exec(url.pathname);
  const key = match && forgeKey(url.host, match[1], Number(match[2]));
  return key ? legacyAlias(key) : undefined;
}

/** The same allowlist gates live writes and replay of untrusted, older session entries. */
function receipt(data: unknown): Handle | undefined {
  const raw = record(data);
  if (!raw || !KINDS.includes(raw.kind as HandleKind) || typeof raw.id !== "string") return undefined;
  if (raw.open !== undefined && typeof raw.open !== "boolean") return undefined;
  const kind = raw.kind as HandleKind;
  const id = kind === "pr" ? prId(raw.id, raw.status === "watching" || raw.open === false) : kind === "delegate" ? taskId(raw.id) : safeId(raw.id);
  if (!id) return undefined;
  const explicitTitle = safeTitle(raw.explicitTitle);
  const link = kind === "delegate" || kind === "thread" ? threadLink(raw.link) : undefined;
  const status = STATES.find(state => state === raw.status);
  const hostId = kind === "device" ? safeId(raw.hostId) : undefined;
  if (kind === "device" && raw.hostId !== undefined && !hostId) return undefined;
  // Older receipts confused pausing a schedule with deleting it.
  const open = kind === "schedule" && status === "paused" ? true : raw.open ?? true;
  return { kind, id, open, ...(hostId && { hostId }), ...(explicitTitle && { explicitTitle }), ...(link && { link }), ...(status && { status }) };
}

const scopeId = (id: unknown) => typeof id === "string" && id.length <= 256 && /^(?:[\w.:-]|%[\da-fA-F]{2})+$/.test(id) ? id : undefined;

// These results identify the caller. Child links, schedule destinations and remote catalogs do not.
export function observeScope(scope: ReceiptScope, tool: string, input: Json, result?: Json): ReceiptScope {
  if (!result || input.environmentId !== undefined) return scope;
  const thread = tool === "orchestrator_capabilities" ? result.parentThreadId : tool === "t3_thread_list" ? result.currentThreadId : undefined;
  const threadId = scopeId(thread);
  const environmentId = (tool === "t3_environment_read" || tool === "t3_environment_links") ? safeId(result.environmentId) : undefined;
  if (threadId && threadId !== scope.threadId) return { ...scope, threadId };
  if (environmentId && environmentId !== scope.environmentId) return { ...scope, environmentId };
  return scope;
}

// Undefined is the caller; false is malformed, never a fallback to the caller.
function relativeTarget(scope: ReceiptScope, raw: Json): Target | undefined | false {
  const env = scopeId(raw.environmentId), thread = scopeId(raw.threadId);
  if ((raw.environmentId !== undefined && !env) || (raw.threadId !== undefined && !thread)) return false;
  const environmentId = env !== scope.environmentId ? env : undefined;
  const threadId = environmentId || thread !== scope.threadId ? thread : undefined;
  return environmentId || threadId ? { ...(environmentId && { environmentId }), ...(threadId && { threadId }) } : undefined;
}

export function observationTarget(scope: ReceiptScope, tool: string, input: Json) {
  // A PR watch belongs to its target thread. A delegate taskId belongs to its parent,
  // not the child it launched. Its nested target selects where that child runs.
  const pr = ["watch_pull_request", "unwatch_pull_request", "list_thread_pull_requests"].includes(tool);
  return relativeTarget(scope, { environmentId: input.environmentId, threadId: pr ? input.threadId : undefined });
}

/** T3 returns its result as JSON text; prefer structured content when a newer bridge supplies it. */
export function resultPayload(content: ReadonlyArray<{ type: string; text?: string }>, structured?: unknown): Json | undefined {
  const outer = record(structured);
  const inner = record(outer?.structuredContent) ?? (outer && !("content" in outer) ? outer : undefined);
  if (inner) return inner;
  for (const part of content) {
    if (part.type !== "text" || !part.text?.trimStart().startsWith("{")) continue;
    try {
      const parsed = record(JSON.parse(part.text));
      if (parsed) return parsed;
    } catch { /* not JSON */ }
  }
  return undefined;
}

function previewId(result?: Json): string | undefined {
  const tab = record(result?.tab);
  return safeId(result?.tabId ?? tab?.tabId ?? tab?.id);
}

/** Run-local provenance, never inferred from a replayed handle or a tab URL. */
export function trackRunTab(opened: Set<string>, tool: string, input: Json, result?: Json): void {
  if (tool === "t3_preview_close") {
    if (typeof input.tabId === "string") opened.delete(input.tabId);
    return;
  }
  if (!tool.startsWith("preview_")) return;
  const id = previewId(result);
  const control = record(result?.control);
  const owned = control?.ownedByCaller === true && (control.owner === undefined || control.owner === "agent");
  if (id && tool === "preview_open") {
    // Current bridges reuse by default and do not always return a reused flag.
    const fresh = !input.tabId && (result?.reused === false || (result?.reused === undefined && input.reuseExistingTab === false));
    if (result?.available !== false && owned && fresh) opened.add(id);
  }
  if (id && (control?.ownedByCaller === false || control?.owner === "human" || control?.owner === "unclaimed")) {
    opened.delete(id);
  }
  // Status can also report a takeover of another tab, not just the current one.
  for (const entry of Array.isArray(result?.tabs) ? result.tabs : []) {
    const tab = record(entry);
    if (typeof tab?.tabId === "string" && (tab.ownedByCaller === false || tab.owner === "human" || tab.owner === "unclaimed")) opened.delete(tab.tabId);
  }
}

function prKey(input: Json, result?: Json) {
  const host = result?.host ?? input.host;
  if (host !== undefined) return forgeKey(host, result?.repository ?? input.repository, result?.number ?? input.number);
  const url = text(result?.url) ?? text(input.url);
  return url && keyFromForgeUrl(url);
}

/** Translate one successful T3 tool call into ledger updates. Pure, so it is easy to test. */
export function observe(tool: string, input: Json, result: Json | undefined, ledger?: Ledger, target?: Target): Handle[] {
  return observations(tool, input, result, ledger, target).flatMap(raw => {
    const update = receipt(raw);
    return update ? [{ ...update, ...(target && { target }) }] : [];
  });
}

function observations(tool: string, input: Json, result: Json | undefined, ledger?: Ledger, target?: Target): Json[] {
  switch (tool) {
    case "delegate_task":
    case "t3_thread_send": // Only a send that started a fresh child task returns a taskId.
    case "task_status": {
      const id = result?.taskId ?? (tool === "task_status" ? input.taskId : undefined);
      if (!id || !result) return [];
      const delivered = result.workState === "result_available" && TERMINAL.some(state => state === result.status);
      return [{ kind: "delegate", id, open: !delivered, explicitTitle: tool === "delegate_task" ? input.title : undefined,
        link: result.link, status: delivered ? result.status : result.workState ?? result.status }];
    }
    case "task_cancel": {
      const id = result?.taskId ?? input.taskId;
      const status = result?.status;
      if (status === "cancel_requested") return [{ kind: "delegate", id, open: true, status: "cancelling" }];
      return TERMINAL.some(state => state === status) ? [{ kind: "delegate", id, open: false, status }] : [];
    }
    case "schedule_task":
    case "update_scheduled_task": {
      const id = text(result?.scheduledTaskId) ?? text(input.scheduledTaskId);
      if (!id) return [];
      const enabled = (result?.enabled ?? input.enabled) !== false;
      return [{ kind: "schedule", id, explicitTitle: input.title, open: true, status: enabled ? "enabled" : "paused" }];
    }
    case "delete_scheduled_task": {
      const id = result?.scheduledTaskId ?? input.scheduledTaskId;
      return result?.deleted === true ? [{ kind: "schedule", id, status: "deleted", open: false }] : [];
    }
    case "list_scheduled_tasks": {
      // Lists are project-filtered. Absence alone doesn't establish deletion.
      const tasks = result?.tasks;
      if (!Array.isArray(tasks)) return [];
      return (ledger?.open("schedule", target) ?? []).flatMap(h => {
        const task = tasks.find(t => record(t)?.scheduledTaskId === h.id);
        if (typeof task?.enabled !== "boolean") return [];
        const status = task.enabled ? "enabled" : "paused";
        return h.status === status ? [] : [{ kind: h.kind, id: h.id, open: true, status }];
      });
    }
    case "list_thread_pull_requests": {
      const prs = result?.pullRequests;
      if (!Array.isArray(prs)) return [];
      const watching = new Map<string, boolean>();
      const hostless = new Set<string>();
      for (const pr of prs) {
        const id = forgeKey(pr?.host, pr?.repository, pr?.number);
        if (!id || typeof pr.watching !== "boolean") return [];
        watching.set(id, pr.watching);
        if (id.includes("@")) watching.set(legacyAlias(id), pr.watching);
        if (pr.watching) hostless.add(repoNumber(pr.repository, pr.number)!);
      }
      const complete = input.cursor === undefined && input.states === undefined && result?.nextCursor === null;
      return (ledger?.open("pr", target) ?? []).filter(h => watching.has(h.id) ? !watching.get(h.id) : complete && !hostless.has(h.id)).map(h => ({ kind: h.kind, id: h.id, open: false, status: "unwatched" }));
    }
    case "t3_preview_list": {
      const tabs = result?.sessions;
      if (!Array.isArray(tabs) || tabs.some(tab => !safeId(tab?.tabId)) || result?.nextCursor !== null || (input.cursor ?? 0) !== 0) return [];
      const listed = new Set(tabs.map(tab => tab.tabId));
      return (ledger?.open("preview", target) ?? []).filter(h => !listed.has(h.id)).map(h => ({ kind: h.kind, id: h.id, open: false }));
    }
    case "watch_pull_request":
    case "unwatch_pull_request": {
      const id = prKey(input, result);
      const open = result?.watching;
      return id && typeof open === "boolean" ? [{ kind: "pr", id, status: open ? "watching" : "unwatched", open }] : [];
    }
    case "t3_thread_launch": {
      const id = text(result?.threadId);
      return id ? [{ kind: "thread", id, explicitTitle: input.title, link: text(result?.link), open: true }] : [];
    }
    case "create_threads": {
      const threads = Array.isArray(result?.threads) ? result.threads : [];
      const requests = Array.isArray(input.threads) ? input.threads : [];
      return threads.flatMap((thread, index) => {
        const value = record(thread);
        const id = text(value?.threadId) ?? text(value?.id);
        return id ? [{ kind: "thread" as const, id, explicitTitle: record(requests[index])?.title, link: text(value?.link), open: true }] : [];
      });
    }
    case "preview_open": {
      const id = result?.available !== false ? previewId(result) : undefined;
      return id ? [{ kind: "preview", id, open: true }] : [];
    }
    case "t3_preview_close": {
      const id = text(input.tabId);
      return id ? [{ kind: "preview", id, open: false }] : [];
    }
    case "device_open":
    case "device_close": {
      const device = record(result?.device);
      const id = device?.id ?? result?.deviceId ?? input.deviceId;
      const hostId = device?.hostId ?? result?.hostId ?? input.hostId;
      if (tool === "device_open") return id ? [{ kind: "device", id, hostId, open: true }] : [];
      return (ledger?.open("device", target) ?? []).filter(h => (id === undefined || h.id === id) && (hostId === undefined || h.hostId === hostId))
        .map(h => ({ kind: "device", id: h.id, hostId: h.hostId, open: false }));
    }
    default:
      return [];
  }
}

const targetKey = (t?: Target) => [t?.environmentId && `env=${t.environmentId}`, t?.threadId && `thread=${t.threadId}`].filter(Boolean).join(",");
export const scopedId = (h: Handle) => [targetKey(h.target), h.hostId, h.id].filter(Boolean).join("/");

export class Ledger {
  private readonly handles = new Map<string, Handle>();

  apply(update: Handle): void {
    const key = `${update.kind}:${scopedId(update)}`;
    if (update.kind === "pr" && update.id.includes("@") && !update.id.startsWith("legacy:")) {
      this.handles.delete(`pr:${scopedId({ ...update, id: legacyAlias(update.id) })}`);
    }
    const previous = this.handles.get(key);
    // Re-insert open receipts so iteration order is most recent last. Closed IDs need no cache.
    this.handles.delete(key);
    if (update.open) this.handles.set(key, { ...previous, ...update });
  }

  clear(): void {
    this.handles.clear();
  }

  open(kind?: HandleKind, target?: Target): Handle[] {
    const key = targetKey(target);
    return [...this.handles.values()].filter(h => (kind === undefined || h.kind === kind) && targetKey(h.target) === key);
  }

  /** Drop matching handles locally; the caller persists just their closing receipts. */
  forget(target: string): Handle[] {
    const closing = [...this.handles.values()].filter(handle => target === "all" || scopedId(handle) === target)
      .map(({ kind, id, hostId, target }) => ({ kind, id, ...(hostId && { hostId }), ...(target && { target }), open: false }));
    for (const update of closing) this.apply(update);
    return closing;
  }

  /** Compact text for the system prompt, or undefined when nothing is open. */
  render(): string | undefined {
    const open = this.open();
    const threads = this.open("thread").slice(-MAX_THREADS);
    const shown = [...open.filter(handle => handle.kind !== "thread"), ...threads].slice(0, MAX_LINES).map(handleLine);
    const omitted = open.length - shown.length;
    if (omitted) shown.push(`- … ${omitted} more; run /t3-agent ledger`);
    if (this.handles.size > open.length) shown.push(`- ${this.handles.size - open.length} in other targets; run /t3-agent ledger`);
    return shown.join("\n") || undefined;
  }

  /** Human listing: page the output, not the underlying set of handles. */
  pages(): string[] {
    const open = [...this.handles.values()];
    const pages: string[] = [];
    for (let i = 0; i < open.length; i += MAX_LINES) {
      const header = open.length > MAX_LINES ? `T3 handles (${1 + i / MAX_LINES}/${Math.ceil(open.length / MAX_LINES)})\n` : "";
      pages.push(header + open.slice(i, i + MAX_LINES).map(h => handleLine(h) + (h.target ? ` [${scopedId(h)}]` : "")).join("\n"));
    }
    return pages;
  }
}

function handleLine(handle: Handle): string {
  const { kind, explicitTitle, id, status, link, hostId } = handle;
  const label = explicitTitle ? ` "${explicitTitle}"` : "";
  const state = status ? `, status ${status}` : "";
  switch (kind) {
    case "delegate": return `- delegate${label} taskId=${id}${state}${link ? ` link ${link}` : ""}`;
    case "schedule": return `- schedule${label} scheduledTaskId=${id}${state}`;
    case "pr": return `- watching PR ${id}`;
    case "preview": return `- preview tab tabId=${id}`;
    case "device": return `- device deviceId=${id}${hostId ? ` on hostId=${hostId}` : ""}`;
    case "thread": return `- thread${label} ${link ?? id}`;
  }
}

/** Rebuild from the custom entries on the current branch. */
export function rebuild(ledger: Ledger, entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>, scope?: ReceiptScope, allowLegacy = true): void {
  ledger.clear();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = record(entry.data);
    if (!data) continue;
    const update = receipt(data);
    if (!update) continue;
    if (data.version === undefined && data.scope === undefined) {
      if (allowLegacy && data.target === undefined) ledger.apply(update);
      continue;
    }
    const saved = record(data.scope);
    if (data.version !== 1 || !scope || saved?.sessionId !== scope.sessionId) continue;
    if (data.target !== undefined) {
      const raw = record(data.target);
      if (!raw || (raw.threadId === undefined && raw.environmentId === undefined)) continue;
      const target = relativeTarget(scope, raw);
      if (target === false) continue;
      if (target) update.target = target;
    }
    const fields = ["threadId", "environmentId"] as const;
    if (fields.some(k => saved[k] !== undefined && (!scopeId(saved[k]) || (scope[k] !== undefined && saved[k] !== scope[k])))) continue;
    // Withhold a scoped observation (and any older, less specific one for the same id)
    // until the caller is known. Reading T3 just to discover that scope would be polling.
    const confirmed = fields.every(k => saved[k] === undefined || saved[k] === scope[k]);
    ledger.apply(confirmed ? update : { ...update, open: false });
  }
}
