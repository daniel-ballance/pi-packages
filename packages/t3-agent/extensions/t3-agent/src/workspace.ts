import { sep } from "node:path";

export interface Workspace {
  root: string;
  /** Undefined when HEAD is detached. */
  branch?: string;
  /** A linked worktree, not the repository's main checkout. */
  linked: boolean;
  /** Path of the main checkout, when `linked`. */
  mainCheckout?: string;
  /** Lives under a `.t3/worktrees` directory, where T3 creates thread worktrees. */
  t3Managed: boolean;
  /** `origin/main`, from the remote's HEAD. */
  defaultBranch?: string;
  /** Upstream of the current branch, e.g. `origin/feat/x`. */
  upstream?: string;
}

export type Exec = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ stdout: string; code: number }>;

const git = async (exec: Exec, cwd: string, args: string[]) => {
  try {
    const result = await exec("git", args, { cwd, timeout: 3_000 });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
};

/** Stable facts about the checkout. Volatile state (dirty files) is left out so the prompt stays cacheable. */
export async function readWorkspace(exec: Exec, cwd: string): Promise<Workspace | undefined> {
  const head = await git(exec, cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  const [root, gitDir, commonDir] = head?.split("\n") ?? [];
  if (!root || !gitDir || !commonDir) return undefined;
  const linked = gitDir !== commonDir;
  // `branch --show-current` also names an unborn branch, and prints nothing when HEAD is detached.
  const [branch, list, defaultBranch, upstream] = await Promise.all([
    git(exec, cwd, ["branch", "--show-current"]),
    linked ? git(exec, cwd, ["worktree", "list", "--porcelain"]) : Promise.resolve(undefined),
    git(exec, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    git(exec, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);
  const mainCheckout = list?.split("\n").find(line => line.startsWith("worktree "))?.slice("worktree ".length);
  return {
    root,
    ...(branch ? { branch } : {}),
    linked,
    ...(linked && mainCheckout ? { mainCheckout } : {}),
    t3Managed: linked && root.includes(`${sep}.t3${sep}worktrees${sep}`),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(upstream ? { upstream } : {}),
  };
}
