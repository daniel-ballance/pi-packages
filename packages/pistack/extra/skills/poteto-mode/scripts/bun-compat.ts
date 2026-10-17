// The two Bun process APIs the upstream script tests use, on node:child_process.
// Hand-written for pistack (extra/).
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { basename } from "node:path";

type Options = { readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>> };

// `git rev-parse --local-env-vars`. A hook exports these, and they override `-C`.
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
];

function commandEnv(file: string, env: Options["env"]): NodeJS.ProcessEnv | undefined {
  if (basename(file) !== "git") return env as NodeJS.ProcessEnv | undefined;
  const next: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  for (const name of REPO_GIT_ENV) delete next[name];
  return next;
}

export const Bun = {
  spawnSync(command: readonly string[], options: Options = {}) {
    const [file, ...args] = command;
    const result = nodeSpawnSync(file!, args, { cwd: options.cwd, env: commandEnv(file!, options.env) });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, success: result.status === 0 };
  },
  spawn(command: readonly string[], options: Options = {}) {
    const [file, ...args] = command;
    const child = nodeSpawn(file!, args, { cwd: options.cwd, env: commandEnv(file!, options.env), stdio: "ignore" });
    // Bun throws when the executable is missing; Node reports it asynchronously.
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", code => resolve(code));
      child.once("error", reject);
    });
    return { pid: child.pid, exited };
  },
};
