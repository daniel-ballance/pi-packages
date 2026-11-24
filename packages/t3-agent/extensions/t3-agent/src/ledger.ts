// The handle ledger remembers the T3 objects this session created (delegated tasks,
// schedules, watched pull requests, launched threads, preview tabs, devices). T3 tool
// results carry the identifiers only once; after compaction the model would otherwise
// lose the taskId it needs for task_cancel, or forget the tab it must close.

const KINDS = ["delegate", "schedule", "pr", "thread", "preview", "device"] as const;
export type HandleKind = (typeof KINDS)[number];

const TERMINAL = ["completed", "failed", "cancelled", "canceled", "interrupted", "stopped"] as const;
const STATES = [...TERMINAL, "queued", "starting", "running", "waiting", "working", "waiting_for_children",
  "result_available", "cancelling", "enabled", "paused", "deleted", "watching", "unwatched"] as const;
type State = (typeof STATES)[number];

export interface Handle {
  kind: HandleKind;
  id: string;
  hostId?: string; // part of a device's identity
  explicitTitle?: string; // Old `title` fields could contain prompt text; never replay them.
  link?: string;
  status?: State;
  open: boolean;
}

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

function forgeKey(host: unknown, repository: unknown, number: unknown): string | undefined {
  if (typeof host !== "string" || host.length > 253 || !/^[\w-]+(?:\.[\w-]+)*(?::\d{1,5})?$/.test(host) ||
    typeof repository !== "string" || repository.length > 256 || !/^(?:[\w.-]+\/)+[\w.-]+$/.test(repository) ||
    repository.split("/").some(part => part === "." || part === "..") ||
    typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
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

function prId(value: string): string | undefined {
  if (value.length > 2048) return undefined;
  const scoped = /^([\w./-]+)#([1-9]\d*)@([\w.:-]+)$/.exec(value);
  return scoped ? forgeKey(scoped[3], scoped[1], Number(scoped[2])) : keyFromForgeUrl(value);
}

/** The same allowlist gates live writes and replay of untrusted, older session entries. */
function receipt(data: unknown): Handle | undefined {
  const raw = record(data);
  if (!raw || !KINDS.includes(raw.kind as HandleKind) || typeof raw.id !== "string") return undefined;
  if (raw.open !== undefined && typeof raw.open !== "boolean") return undefined;
  const kind = raw.kind as HandleKind;
  const id = kind === "pr" ? prId(raw.id) : kind === "delegate" ? taskId(raw.id) : safeId(raw.id);
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
export function observe(tool: string, input: Json, result: Json | undefined, ledger?: Ledger): Handle[] {
  return observations(tool, input, result, ledger).flatMap(raw => receipt(raw) ?? []);
}

function observations(tool: string, input: Json, result: Json | undefined, ledger?: Ledger): Json[] {
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
      return (ledger?.open("device") ?? []).filter(h => (id === undefined || h.id === id) && (hostId === undefined || h.hostId === hostId))
        .map(h => ({ kind: "device", id: h.id, hostId: h.hostId, open: false }));
    }
    default:
      return [];
  }
}

export const scopedId = (handle: Handle) => handle.hostId ? `${handle.hostId}/${handle.id}` : handle.id;

export class Ledger {
  private readonly handles = new Map<string, Handle>();

  apply(update: Handle): void {
    const key = `${update.kind}:${scopedId(update)}`;
    const previous = this.handles.get(key);
    // Re-insert open receipts so iteration order is most recent last. Closed IDs need no cache.
    this.handles.delete(key);
    if (update.open) this.handles.set(key, { ...previous, ...update });
  }

  clear(): void {
    this.handles.clear();
  }

  open(kind?: HandleKind): Handle[] {
    return [...this.handles.values()].filter(handle => kind === undefined || handle.kind === kind);
  }

  /** Drop matching handles locally; the caller persists just their closing receipts. */
  forget(target: string): Handle[] {
    const closing = this.open().filter(handle => target === "all" || scopedId(handle) === target)
      .map(({ kind, id, hostId }) => ({ kind, id, ...(hostId && { hostId }), open: false }));
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
    return shown.join("\n") || undefined;
  }

  /** Human listing: page the output, not the underlying set of handles. */
  pages(): string[] {
    const open = this.open();
    const pages: string[] = [];
    for (let i = 0; i < open.length; i += MAX_LINES) {
      const header = open.length > MAX_LINES ? `T3 handles (${1 + i / MAX_LINES}/${Math.ceil(open.length / MAX_LINES)})\n` : "";
      pages.push(header + open.slice(i, i + MAX_LINES).map(handleLine).join("\n"));
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
export function rebuild(ledger: Ledger, entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): void {
  ledger.clear();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const update = receipt(entry.data);
    if (update) ledger.apply(update);
  }
}
