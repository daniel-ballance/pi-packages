import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

// `git rev-parse --local-env-vars`. These select a repository and override `-C`.
const REPO_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of REPO_GIT_ENV) delete env[name];
  return env;
}

export function git(args: readonly string[], options: ExecFileSyncOptions & { encoding: BufferEncoding }): string;
export function git(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function git(args: readonly string[], options: ExecFileSyncOptions = {}) {
  return execFileSync("git", [...args], { ...options, env: gitEnv({ ...process.env, ...options.env }) });
}
