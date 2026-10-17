// The two Bun process APIs the upstream script tests use, on node:child_process.
// Hand-written for pistack (extra/).
import { execFileSync, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { basename } from "node:path";

type Options = { readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>> };

let repoGitEnv: string[] | undefined;

function commandEnv(file: string, env: Options["env"]): NodeJS.ProcessEnv | undefined {
  if (basename(file) !== "git") return env as NodeJS.ProcessEnv | undefined;
  if (!repoGitEnv) {
    try {
      repoGitEnv = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .trim().split(/\s+/).filter(name => name !== "GIT_CONFIG_COUNT" && name !== "GIT_CONFIG_PARAMETERS");
    } catch {
      // Git may be unavailable; still prevent children from inheriting the caller's repository.
      repoGitEnv = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];
    }
  }
  const next: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  for (const name of repoGitEnv) delete next[name];
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
