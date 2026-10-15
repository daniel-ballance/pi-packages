// The two Bun process APIs the upstream script tests use, on node:child_process.
// Hand-written for pistack (extra/).
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";

type Options = { readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>> };

export const Bun = {
  spawnSync(command: readonly string[], options: Options = {}) {
    const [file, ...args] = command;
    const result = nodeSpawnSync(file!, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv | undefined });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, success: result.status === 0 };
  },
  spawn(command: readonly string[], options: Options = {}) {
    const [file, ...args] = command;
    const child = nodeSpawn(file!, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv | undefined, stdio: "ignore" });
    const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
    return { pid: child.pid, exited };
  },
};
