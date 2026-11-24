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
  title?: string;
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

function prId(value: string): string | undefined {
  if (value.length > 2048) return undefined;
  // Older/non-URL results can identify a PR by repository and number instead.
  if (value.length <= 256 && /^(?:[\w.-]+\/)+[\w.-]+#[1-9]\d*$/.test(value)) return value;
  const url = URL.parse(value);
  if (url?.protocol !== "https:") return undefined;
  const path = url.pathname.replace(/\/$/, "");
  if (!/^\/(?:[\w.-]+\/)+[\w.-]+\/(?:pull|pulls|pull-requests|pullrequest|-\/merge_requests)\/[1-9]\d*$/.test(path)) return undefined;
  const canonical = url.origin + path; // no userinfo, query or fragment
  return canonical.length <= 512 ? canonical : undefined;
}

/** The same allowlist gates live writes and replay of untrusted, older session entries. */
function receipt(data: unknown): Handle | undefined {
  const raw = record(data);
  if (!raw || !KINDS.includes(raw.kind as HandleKind) || typeof raw.id !== "string") return undefined;
  if (raw.open !== undefined && typeof raw.open !== "boolean") return undefined;
  const kind = raw.kind as HandleKind;
  const id = kind === "pr" ? prId(raw.id) : safeId(raw.id);
  if (!id) return undefined;
  const title = safeTitle(raw.title);
  const link = kind === "delegate" || kind === "thread" ? threadLink(raw.link) : undefined;
  const status = STATES.find(state => state === raw.status);
  return { kind, id, open: raw.open ?? true, ...(title && { title }), ...(link && { link }), ...(status && { status }) };
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

function prKey(input: Json, result?: Json) {
  const url = text(result?.url) ?? text(input.url);
  if (url) return url;
  const repository = text(result?.repository) ?? text(input.repository);
  const number = result?.number ?? input.number;
  return repository && typeof number === "number" ? `${repository}#${number}` : undefined;
}

/** Translate one successful T3 tool call into ledger updates. Pure, so it is easy to test. */
export function observe(tool: string, input: Json, result: Json | undefined): Handle[] {
  return observations(tool, input, result).flatMap(raw => receipt(raw) ?? []);
}

function observations(tool: string, input: Json, result: Json | undefined): Json[] {
  switch (tool) {
    case "delegate_task": {
      const id = text(result?.taskId);
      if (!id) return [];
      return [{
        kind: "delegate", id, open: true,
        title: input.title, link: result?.link, status: result?.workState ?? result?.status,
      }];
    }
    case "task_status": {
      const id = text(result?.taskId) ?? text(input.taskId);
      if (!id) return [];
      const status = text(result?.status);
      const delivered = result?.workState === "result_available" && TERMINAL.some(state => state === status);
      return [{ kind: "delegate", id, status: delivered ? status : text(result?.workState) ?? status, open: !delivered, ...(text(result?.link) ? { link: text(result?.link) } : {}) }];
    }
    case "t3_thread_send": {
      // A send to a finished child thread starts a fresh delegated task.
      const id = text(result?.taskId);
      return id ? [{ kind: "delegate", id, open: true, link: text(result?.link), status: text(result?.workState) ?? text(result?.status) }] : [];
    }
    case "task_cancel": {
      const id = text(input.taskId);
      return id ? [{ kind: "delegate", id, status: "cancelled", open: false }] : [];
    }
    case "schedule_task": {
      const id = text(result?.scheduledTaskId) ?? text(input.scheduledTaskId);
      if (!id) return [];
      const enabled = (result?.enabled ?? input.enabled) !== false;
      return [{ kind: "schedule", id, title: result?.title ?? input.title, open: enabled, status: enabled ? "enabled" : "paused" }];
    }
    case "delete_scheduled_task": {
      const id = text(input.scheduledTaskId);
      return id ? [{ kind: "schedule", id, status: "deleted", open: false }] : [];
    }
    case "watch_pull_request": {
      const id = prKey(input, result);
      return id ? [{ kind: "pr", id, status: "watching", open: true }] : [];
    }
    case "unwatch_pull_request": {
      const id = prKey(input, result);
      return id ? [{ kind: "pr", id, status: "unwatched", open: false }] : [];
    }
    case "t3_thread_launch": {
      const id = text(result?.threadId);
      return id ? [{ kind: "thread", id, title: input.title, link: text(result?.link), open: true }] : [];
    }
    case "create_threads": {
      const threads = Array.isArray(result?.threads) ? result.threads : [];
      return threads.flatMap(thread => {
        const value = record(thread);
        const id = text(value?.threadId) ?? text(value?.id);
        return id ? [{ kind: "thread" as const, id, title: value?.title, link: text(value?.link), open: true }] : [];
      });
    }
    case "preview_open": {
      const tab = record(result?.tab);
      const id = text(result?.tabId) ?? text(tab?.tabId) ?? text(tab?.id) ?? text(input.tabId);
      return id ? [{ kind: "preview", id, open: true }] : [];
    }
    case "t3_preview_close": {
      const id = text(input.tabId);
      return id ? [{ kind: "preview", id, open: false }] : [];
    }
    case "device_open": {
      const device = text(input.deviceId) ?? text(result?.deviceId);
      return device ? [{ kind: "device", id: device, open: true }] : [];
    }
    case "device_close": {
      const id = text(input.deviceId);
      return id ? [{ kind: "device", id, open: false }] : [];
    }
    default:
      return [];
  }
}

export class Ledger {
  private readonly handles = new Map<string, Handle>();

  apply(update: Handle): void {
    const key = `${update.kind}:${update.id}`;
    const previous = this.handles.get(key);
    const next = { ...previous, ...update };
    // Re-insert so iteration order is most recent last.
    this.handles.delete(key);
    this.handles.set(key, next);
  }

  clear(): void {
    this.handles.clear();
  }

  all(): Handle[] {
    return [...this.handles.values()];
  }

  open(kind?: HandleKind): Handle[] {
    return this.all().filter(handle => handle.open && (kind === undefined || handle.kind === kind));
  }

  /** Close one handle by id, or every handle with `all`. Returns how many closed. */
  forget(id: string): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.open && (id === "all" || handle.id === id)) {
        handle.open = false;
        count++;
      }
    }
    return count;
  }

  /** Compact text for the system prompt, or undefined when nothing is open. */
  render(): string | undefined {
    const threads = this.open("thread").slice(-MAX_THREADS);
    const lines = [
      ...this.open("delegate").map(handle => `- delegate${quote(handle.title)} taskId=${handle.id}${part("status", handle.status)}${handle.link ? ` link ${handle.link}` : ""}`),
      ...this.open("schedule").map(handle => `- schedule${quote(handle.title)} scheduledTaskId=${handle.id}${part("status", handle.status)}`),
      ...this.open("pr").map(handle => `- watching PR ${handle.id}`),
      ...this.open("preview").map(handle => `- preview tab tabId=${handle.id}`),
      ...this.open("device").map(handle => `- device deviceId=${handle.id}`),
      ...threads.map(handle => `- thread${quote(handle.title)} ${handle.link ?? handle.id}`),
    ];
    if (lines.length === 0) return undefined;
    const shown = lines.slice(0, MAX_LINES);
    if (lines.length > shown.length) shown.push(`- … ${lines.length - shown.length} more; run /t3-agent ledger`);
    return shown.join("\n");
  }
}

const quote = (title: string | undefined) => title ? ` "${title.replaceAll("\"", "'")}"` : "";
const part = (label: string, value: string | undefined) => value ? `, ${label} ${value}` : "";

/** Rebuild from the custom entries on the current branch. */
export function rebuild(ledger: Ledger, entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): void {
  ledger.clear();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const update = receipt(entry.data);
    if (update) ledger.apply(update);
  }
}
