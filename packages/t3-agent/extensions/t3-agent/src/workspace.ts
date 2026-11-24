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

/** Keep topology per extension instance. Ask Git about refs, not file mtimes: config includes,
 * packed refs and a change of upstream without a checkout all affect the answer. */
export function workspaceReader(exec: Exec) {
  let layoutKey: string | undefined;
  let layout: Workspace | undefined;
  return async (cwd: string): Promise<Workspace | undefined> => {
    const git = (args: string[]) => exec("git", args, { cwd, timeout: 3_000 }).catch(() => undefined);
    const read = async (args: string[]) => {
      const result = await git(args);
      return result?.code === 0 ? result.stdout.trim() : undefined;
    };
    // rev-parse emits the checkout and branch even when its last argument (the upstream) fails.
    const head = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--symbolic-full-name", "HEAD", "--abbrev-ref", "@{u}"]);
    const [root, gitDir, commonDir, ref, tracking] = head?.stdout.trimEnd().split("\n") ?? [];
    if (!root || !gitDir || !commonDir) {
      layoutKey = undefined;
      return undefined;
    }
    const key = JSON.stringify([root, gitDir, commonDir]);
    if (key !== layoutKey || !layout) {
      const linked = gitDir !== commonDir;
      const list = linked ? await read(["worktree", "list", "--porcelain"]) : undefined;
      const mainCheckout = list?.split("\n").find(line => line.startsWith("worktree "))?.slice("worktree ".length);
      layout = { root, linked, ...(mainCheckout && { mainCheckout }), t3Managed: linked && root.includes(`${sep}.t3${sep}worktrees${sep}`) };
      layoutKey = !linked || mainCheckout ? key : undefined;
    }
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : await read(["branch", "--show-current"]);
    const upstream = head?.code === 0 ? tracking : undefined;
    const defaultBranch = await read(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    return { ...layout, ...(branch && { branch }), ...(upstream && { upstream }), ...(defaultBranch && { defaultBranch }) };
  };
}
