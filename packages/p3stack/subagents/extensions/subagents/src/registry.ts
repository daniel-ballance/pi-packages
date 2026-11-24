import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord } from "./manager.js";
import type { PeerState } from "./peers.js";
import type { Notice } from "./report-inbox.js";

export function enforcePrivatePath(path: string, mode: number, directory: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe subagent state path: ${path}`);
  chmodSync(path, mode);
}
export function enforcePrivatePathIfPresent(path: string, mode: number, directory: boolean) {
  try { enforcePrivatePath(path, mode, directory); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function writeJson(path: string, value: unknown) {
  const temp = path + ".tmp";
  enforcePrivatePathIfPresent(temp, 0o600, false);
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  enforcePrivatePath(temp, 0o600, false);
  renameSync(temp, path);
}

/** The registry rename commits records, holds, receipts and notices together. A string row names
 * an immutable archived record. A change to that record goes inline in the same commit as its
 * notice; only AFTER that commit may the archive file be reused for a later snapshot. */
export class RegistryStore {
  private archived = new Set<string>();
  private dirty = new Set<string>();
  constructor(readonly path: string) {}
  private archivePath(id: string) {
    return join(dirname(this.path), `archived-${createHash("sha256").update(id).digest("hex")}.json`);
  }
  load(): { agents: AgentRecord[]; peers?: PeerState; pendingNotices: Notice[] } | undefined {
    if (!enforcePrivatePathIfPresent(this.path, 0o600, false)) return;
    const data = JSON.parse(readFileSync(this.path, "utf8"));
    if (![1, 2].includes(data.version) || !Array.isArray(data.agents)) throw new Error("Unsupported subagent registry");
    const agents = data.agents.map((row: AgentRecord | string) => {
      if (typeof row !== "string") return row;
      if (data.version !== 2) throw new Error("Unexpected archive in v1 registry");
      const file = this.archivePath(row);
      enforcePrivatePath(file, 0o600, false);
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record.id !== row) throw new Error(`Wrong archived child for ${row}`);
      this.archived.add(row);
      return record;
    });
    return { agents, peers: data.peers, pendingNotices: data.pendingNotices ?? [] };
  }
  save(records: Iterable<AgentRecord>, changed: AgentRecord[], canArchive: (r: AgentRecord) => boolean, pendingNotices: Notice[], peers?: PeerState) {
    // Keep invalidations even if the write fails. Never overwrite a referenced snapshot in place.
    for (const r of changed) this.dirty.add(r.id);
    const archived = new Set<string>();
    const agents = Array.from(records, record => {
      if (this.dirty.has(record.id) || !canArchive(record)) return record;
      if (!this.archived.has(record.id)) writeJson(this.archivePath(record.id), record);
      archived.add(record.id);
      return record.id;
    });
    writeJson(this.path, { version: 2, agents, pendingNotices, peers });
    this.archived = archived;
    this.dirty.clear();
  }
}
