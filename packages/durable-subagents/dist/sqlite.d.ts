import { DurableSubagents, type HostOptions } from './runtime.js';
/** Fail-closed process ownership, intentionally no timed stale-lock takeover.
 * A killed owner leaves this directory behind. An operator must verify that no process owns
 * the database and remove the lock directory before recovery. PID reuse is not proof of ownership.
 * The lock is advisory: all hosts must use this opener; raw SQLite clients can ignore it. */
export declare function openSqliteSubagents(path: string, options: Omit<HostOptions, 'storage'>): Promise<DurableSubagents>;
