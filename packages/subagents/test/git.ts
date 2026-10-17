import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { gitEnv } from "../extensions/subagents/src/worktree.js";

export { gitEnv };

export function git(args: readonly string[], options: ExecFileSyncOptions & { encoding: BufferEncoding }): string;
export function git(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function git(args: readonly string[], options: ExecFileSyncOptions = {}) {
  return execFileSync("git", [...args], { ...options, env: gitEnv({ ...process.env, ...options.env }) });
}
