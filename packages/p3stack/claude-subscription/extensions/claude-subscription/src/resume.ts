import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Thinking } from "./models.js";
import type { Entry, Transcript } from "./transcript.js";

/** What one persisted Claude Code session has absorbed from Pi. */
export interface SessionRecord {
  sessionId: string;
  cwd: string;
  leadingKey: string;
  toolsKey: string;
  /** Like AgentSession.continues: effort is mutable, the thinking configuration is not. */
  thinkingKey: string;
  keys: string[];
  lastUuid: string;
  paused: boolean;
  /** Claude Code's running usage totals for the session when this was written; a resumed process counts on from them. */
  totals?: unknown;
}

export type SessionReader = (sessionId: string, options: { dir: string }) => Promise<readonly SessionMessage[]>;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SWEEP_MS = 24 * 60 * 60 * 1_000;
const RECORD_FILE = /^[a-f0-9]{64}\.json$/;

/** The whole ordered list names the record, including repeated entries. */
export function keysDigest(keys: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

function prefixFiles(keys: readonly string[]): string[] {
  const hash = createHash("sha256").update("[");
  const files: string[] = [];
  for (let length = 0; length < keys.length; length++) {
    if (length > 0) hash.update(`${length > 1 ? "," : ""}${JSON.stringify(keys[length - 1])}`);
    // Copy the growing JSON array's hash instead of serializing every prefix again.
    files.push(`${hash.copy().update("]").digest("hex")}.json`);
  }
  return files.reverse();
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is SessionRecord {
  return object(value)
    && ["sessionId", "cwd", "leadingKey", "toolsKey", "thinkingKey", "lastUuid"].every(key =>
      typeof value[key] === "string" && value[key].length > 0)
    && Array.isArray(value.keys) && value.keys.every(key => typeof key === "string" && key.length > 0)
    && typeof value.paused === "boolean";
}

/**
 * Private, disposable hints; Claude Code's chain is always verified separately.
 * A store serializes its own writes. Different processes can safely publish complete
 * files; a crash between publishing and removing the old hint leaves a stale candidate
 * that chain verification rejects.
 */
export class SessionStore {
  private ready: Promise<boolean> | undefined;
  private disabled = false;
  private sweptAt = -Infinity;
  private readonly filesBySession = new Map<string, Set<string>>();
  private readonly sessionByFile = new Map<string, string>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string, private readonly now: () => number = Date.now) {}

  private remember(file: string, record: SessionRecord): void {
    // Two Claude Code sessions can have the same Pi prefix. Only the current occupant
    // of its digest file is owned by that session.
    const previous = this.sessionByFile.get(file);
    if (previous) this.filesBySession.get(previous)?.delete(file);
    this.sessionByFile.set(file, record.sessionId);
    let files = this.filesBySession.get(record.sessionId);
    if (!files) this.filesBySession.set(record.sessionId, files = new Set());
    files.add(file);
  }

  private async read(file: string): Promise<SessionRecord | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, file), "utf8"));
      if (!object(value) || value.version !== 1 || typeof value.updatedAt !== "number"
        || !Number.isFinite(value.updatedAt) || !isRecord(value.record)
        || file !== `${keysDigest(value.record.keys)}.json`) return undefined;
      if (this.now() - value.updatedAt > RETENTION_MS) {
        await unlink(join(this.directory, file)).catch(() => {});
        return undefined;
      }
      this.remember(file, value.record);
      return value.record;
    } catch {
      return undefined;
    }
  }

  private async files(): Promise<Set<string>> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    return new Set(entries.filter(entry => entry.isFile() && RECORD_FILE.test(entry.name)).map(entry => entry.name));
  }

  private async sweep(files: Set<string>): Promise<void> {
    if (this.now() - this.sweptAt < SWEEP_MS) return;
    this.filesBySession.clear();
    this.sessionByFile.clear();
    for (const file of files) await this.read(file);
    this.sweptAt = this.now();
  }

  private async initialize(): Promise<boolean> {
    let probe: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory);
      if (!info.isDirectory() || !(info.mode & 0o200)) return false;
      if ((info.mode & 0o777) !== 0o700) await chmod(this.directory, 0o700);
      // Reading hints is no use if we cannot replace them after the resumed turn.
      probe = join(this.directory, `.probe-${randomUUID()}`);
      await open(probe, "wx", 0o600).then(handle => handle.close());
      await unlink(probe);
      probe = undefined;
      await this.sweep(await this.files());
      return true;
    } catch {
      return false;
    } finally {
      if (probe) await unlink(probe).catch(() => {});
    }
  }

  private async usable(): Promise<boolean> {
    return !this.disabled && await (this.ready ??= this.initialize());
  }

  /** Atomic publication, then removal of this Claude Code session's previous hints. */
  async save(record: SessionRecord): Promise<boolean> {
    // Snapshot before waiting on another response's write.
    const snapshot = { ...record, keys: [...record.keys] };
    const work = this.writing.then(() => this.write(snapshot));
    this.writing = work.catch(() => {});
    return work;
  }

  private async write(record: SessionRecord): Promise<boolean> {
    if (!isRecord(record) || !await this.usable()) return false;
    const file = `${keysDigest(record.keys)}.json`;
    const temp = join(this.directory, `.record-${randomUUID()}.tmp`);
    let published = false;
    try {
      if (this.now() - this.sweptAt >= SWEEP_MS) await this.sweep(await this.files());
      const previous = [...(this.filesBySession.get(record.sessionId) ?? [])];
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, updatedAt: this.now(), record }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, join(this.directory, file));
      published = true;
      this.remember(file, record);
      for (const old of previous) {
        if (old !== file && (await this.read(old))?.sessionId === record.sessionId) {
          await unlink(join(this.directory, old)).catch(() => {});
          this.filesBySession.get(record.sessionId)?.delete(old);
          this.sessionByFile.delete(old);
        }
      }
      return true;
    } catch {
      this.disabled = true;
      return false;
    } finally {
      if (!published) await unlink(temp).catch(() => {});
    }
  }

  /** Strict prefixes, longest first. Foreign files and absent digests cost no reads. */
  async *candidates(keys: readonly string[]): AsyncGenerator<SessionRecord> {
    if (!await this.usable()) return;
    try {
      await access(this.directory, constants.W_OK | constants.X_OK);
      const files = await this.files();
      await this.sweep(files);
      for (const file of prefixFiles(keys)) {
        if (!files.has(file)) continue;
        const record = await this.read(file);
        if (record) yield record;
      }
    } catch {
      // An unavailable hint store must never fail a Pi request.
    }
  }
}

/** Same fresh-input rule as AgentSession.continues, with no tool results owed after restart. */
export function resumable(record: SessionRecord, transcript: Transcript, thinking: Thinking, cwd: string): Entry[] | undefined {
  if (record.paused || record.cwd !== cwd || record.leadingKey !== transcript.leadingKey
    || record.toolsKey !== transcript.toolsKey || record.thinkingKey !== JSON.stringify(thinking.thinking)) return undefined;
  const { entries } = transcript;
  if (entries.length <= record.keys.length || record.keys.some((key, index) => entries[index].key !== key)) return undefined;
  const fresh = entries.slice(record.keys.length);
  if (fresh.some(entry => entry.kind === "assistant" || entry.kind === "toolResult")) return undefined;
  return fresh.some(entry => entry.kind === "user") ? fresh : undefined;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => object(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

/** No SDK process or model call: inspect the current persisted chain. */
export async function verifySession(record: SessionRecord, reader: SessionReader): Promise<boolean> {
  try {
    const messages = await reader(record.sessionId, { dir: record.cwd });
    if (!messages.length || messages.at(-1)?.uuid !== record.lastUuid) return false;
    const owed = new Set<string>();
    let interrupted = false;
    for (const entry of messages) {
      if (!object(entry.message)) return false;
      const content = entry.message.content;
      if (typeof content !== "string" && !Array.isArray(content)) return false;
      const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      // A genuine new user turn can follow an earlier interruption; synthetic tool
      // closures and the CLI's "No response requested." are not such a turn.
      if (entry.type === "user" && blocks.some(block => object(block) && (block.type === "text" || block.type === "image"))) interrupted = false;
      for (const block of blocks) {
        if (!object(block)) return false;
        if (entry.type === "assistant" && block.type === "tool_use") {
          if (typeof block.id !== "string") return false;
          owed.add(block.id);
        } else if (entry.type === "user" && block.type === "tool_result") {
          if (typeof block.tool_use_id !== "string") return false;
          owed.delete(block.tool_use_id);
          if (/^(?:\[Tool call interrupted:|The tool call was interrupted before a result was received)/.test(text(block.content).trim())) interrupted = true;
        } else if (entry.type === "assistant" && block.type === "text" && typeof block.text === "string"
          && block.text.trim() === "No response requested.") interrupted = true;
      }
    }
    return owed.size === 0 && !interrupted;
  } catch {
    return false;
  }
}

/** Find the longest usable prefix whose Claude Code chain still agrees with the hint. */
export async function lookupResume(
  store: SessionStore, transcript: Transcript, thinking: Thinking, cwd: string, reader: SessionReader,
): Promise<{ record: SessionRecord; fresh: Entry[] } | undefined> {
  for await (const record of store.candidates(transcript.entries.map(entry => entry.key))) {
    const fresh = resumable(record, transcript, thinking, cwd);
    if (fresh && await verifySession(record, reader)) return { record, fresh };
  }
  return undefined;
}
