import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Capacity } from "./child-limit.js";

export interface Coordination { owns?: string[]; outputs?: string[] }
interface Worker {
  id: string; name: string; cwd: string; status: string; pid?: number;
  hold?: unknown; uncertainSubmission?: unknown; coordination?: Coordination; uiRequests?: unknown[];
}

/** Canonicalize existing ancestors too, so missing output files behind symlinks compare correctly. */
function canonical(path: string): string {
  let probe = resolve(path);
  const missing: string[] = [];
  while (true) {
    try { return resolve(realpathSync.native(probe), ...missing.reverse()); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = dirname(probe);
      if (parent === probe) return resolve(path);
      missing.push(basename(probe)); probe = parent;
    }
  }
}

/** Advisory declarations only: no locks, permission changes, worktrees or file creation. */
export function normalizeCoordination(value: Coordination | undefined, cwd: string): Coordination | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(cwd)) throw new Error("Coordination requires an absolute cwd");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "owns" && key !== "outputs")) throw new Error("Invalid coordination declaration");
  const result: Coordination = {};
  for (const kind of ["owns", "outputs"] as const) {
    const paths = value[kind];
    if (paths === undefined) continue;
    if (!Array.isArray(paths) || paths.length > 32 || paths.some(path => typeof path !== "string" || !path.trim() || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) throw new Error(`coordination.${kind} requires at most 32 nonempty paths`);
    result[kind] = [...new Set(paths.map(path => canonical(resolve(cwd, path))))];
  }
  return result;
}
function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
const live = (worker: Worker) => typeof worker.pid === "number" && worker.pid > 0;

export function coordinationWarnings(candidate: Coordination | undefined, workers: readonly Worker[], excludeId?: string) {
  const warnings: { id: string; name: string; path: string; declaredPath: string }[] = [];
  const requested = [...new Set([...(candidate?.owns ?? []), ...(candidate?.outputs ?? [])])];
  for (const worker of workers) {
    if (!live(worker) || worker.id === excludeId) continue;
    let existing: Coordination | undefined;
    try { existing = normalizeCoordination(worker.coordination, worker.cwd); }
    catch { continue; } // A legacy declaration must not prevent spawning.
    for (const path of requested) for (const declaredPath of new Set([...(existing?.owns ?? []), ...(existing?.outputs ?? [])])) {
      if (contains(path, declaredPath) || contains(declaredPath, path)) warnings.push({ id: worker.id, name: worker.name, path, declaredPath });
    }
  }
  return warnings;
}

/** Eligibility hints, not authorization: policy, process state and reservations are rechecked at invocation. */
export function recoverySummary(workers: readonly Worker[], capacity: Capacity) {
  const ids = (predicate: (worker: Worker) => boolean) => workers.filter(predicate).map(worker => worker.id);
  return {
    capacity,
    idleIds: ids(worker => live(worker) && worker.status === "idle" && !worker.hold && !worker.uncertainSubmission),
    heldIds: ids(worker => !!worker.hold),
    uncertainIds: ids(worker => !!worker.uncertainSubmission),
    guidance: "Held work requires discussion with the user before explicit release; never automatically replace or route around it. Capacity is a snapshot, not a reservation.",
    candidates: {
      send: ids(worker => live(worker) && worker.status === "idle" && !worker.hold && !worker.uncertainSubmission),
      wait: ids(worker => ["starting", "working"].includes(worker.status) && !worker.hold),
      respond: ids(worker => live(worker) && worker.status === "waiting_input" && !worker.hold && !worker.uncertainSubmission && !!worker.uiRequests?.length),
      resume: ids(worker => !live(worker) && worker.status === "stopped" && !worker.hold && !worker.uncertainSubmission),
    },
  };
}
