// The handle ledger remembers the T3 objects this session created (delegated tasks,
// schedules, watched pull requests, launched threads, preview tabs, devices). T3 tool
// results carry the identifiers only once; after compaction the model would otherwise
// lose the taskId it needs for task_cancel, or forget the tab it must close.

export type HandleKind = "delegate" | "schedule" | "pr" | "thread" | "preview" | "device";

export interface Handle {
  kind: HandleKind;
  id: string;
  title?: string;
  link?: string;
  status?: string;
  detail?: string;
  open: boolean;
}

/** One change, persisted as a custom session entry so it follows the branch. */
export type HandleUpdate = Partial<Handle> & Pick<Handle, "kind" | "id">;

export const ENTRY_TYPE = "t3-agent.handle";
const MAX_LINES = 24;
const MAX_THREADS = 5;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
const shorten = (value: string | undefined, length = 70) => {
  const line = value?.split("\n").find(part => part.trim().length > 0)?.trim();
  return line === undefined ? undefined : line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

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

const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "interrupted", "stopped"]);

function prKey(input: Json, result?: Json) {
  const url = text(result?.url) ?? text(input.url);
  if (url) return url;
  const repository = text(result?.repository) ?? text(input.repository);
  const number = result?.number ?? input.number;
  return repository && typeof number === "number" ? `${repository}#${number}` : undefined;
}

/** Translate one successful T3 tool call into ledger updates. Pure, so it is easy to test. */
export function observe(tool: string, input: Json, result: Json | undefined): HandleUpdate[] {
  switch (tool) {
    case "delegate_task": {
      const id = text(result?.taskId);
      if (!id) return [];
      return [{
        kind: "delegate", id, open: true,
        title: shorten(text(input.title) ?? text(input.task)),
        link: text(result?.link), status: text(result?.workState) ?? text(result?.status), detail: text(result?.model),
      }];
    }
    case "task_status": {
      const id = text(result?.taskId) ?? text(input.taskId);
      if (!id) return [];
      const status = text(result?.status);
      const delivered = result?.workState === "result_available" && status !== undefined && TERMINAL.has(status);
      return [{ kind: "delegate", id, status: delivered ? `${status}, result read` : text(result?.workState) ?? status, open: !delivered, ...(text(result?.link) ? { link: text(result?.link) } : {}) }];
    }
    case "t3_thread_send": {
      // A send to a finished child thread starts a fresh delegated task.
      const id = text(result?.taskId);
      return id ? [{ kind: "delegate", id, open: true, title: shorten(text(input.message)), link: text(result?.link), status: text(result?.workState) ?? text(result?.status) }] : [];
    }
    case "task_cancel": {
      const id = text(input.taskId);
      return id ? [{ kind: "delegate", id, status: "cancelled", open: false }] : [];
    }
    case "schedule_task": {
      const id = text(result?.scheduledTaskId) ?? text(input.scheduledTaskId);
      if (!id) return [];
      const enabled = (result?.enabled ?? input.enabled) !== false;
      const next = text(result?.nextRunAt);
      const webhook = text(result?.webhookUrl);
      return [{ kind: "schedule", id, title: shorten(text(result?.title) ?? text(input.title) ?? text(input.prompt)), open: enabled,
        status: enabled ? "enabled" : "paused", ...(next || webhook ? { detail: next ? `next ${next}` : `webhook ${webhook}` } : {}) }];
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
      return id ? [{ kind: "thread", id, title: shorten(text(input.title) ?? text(input.message)), link: text(result?.link), open: true }] : [];
    }
    case "create_threads": {
      const threads = Array.isArray(result?.threads) ? result.threads : [];
      return threads.flatMap(thread => {
        const value = record(thread);
        const id = text(value?.threadId) ?? text(value?.id);
        return id ? [{ kind: "thread" as const, id, title: shorten(text(value?.title)), link: text(value?.link), open: true }] : [];
      });
    }
    case "preview_open": {
      const tab = record(result?.tab);
      const id = text(result?.tabId) ?? text(tab?.tabId) ?? text(tab?.id) ?? text(input.tabId);
      return id ? [{ kind: "preview", id, detail: text(result?.url) ?? text(input.url), open: true }] : [];
    }
    case "t3_preview_close": {
      const id = text(input.tabId);
      return id ? [{ kind: "preview", id, open: false }] : [];
    }
    case "device_open": {
      const device = text(input.deviceId) ?? text(result?.deviceId);
      return device ? [{ kind: "device", id: device, detail: text(input.hostId) ?? text(result?.hostId), open: true }] : [];
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

  apply(update: HandleUpdate): void {
    const key = `${update.kind}:${update.id}`;
    const previous = this.handles.get(key);
    const next = { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) } as Handle;
    next.open ??= true;
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
      ...this.open("delegate").map(handle => `- delegate${quote(handle.title)} taskId=${handle.id}${part("status", handle.status)}${part("model", handle.detail)}${handle.link ? ` link ${handle.link}` : ""}`),
      ...this.open("schedule").map(handle => `- schedule${quote(handle.title)} scheduledTaskId=${handle.id}${handle.detail ? `, ${handle.detail}` : ""}`),
      ...this.open("pr").map(handle => `- watching PR ${handle.id}`),
      ...this.open("preview").map(handle => `- preview tab tabId=${handle.id}${handle.detail ? ` (${handle.detail})` : ""}, opened by you`),
      ...this.open("device").map(handle => `- device deviceId=${handle.id}${handle.detail ? ` on hostId=${handle.detail}` : ""}, opened by you`),
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
    const update = record(entry.data);
    if (update && typeof update.kind === "string" && typeof update.id === "string") ledger.apply(update as unknown as HandleUpdate);
  }
}
