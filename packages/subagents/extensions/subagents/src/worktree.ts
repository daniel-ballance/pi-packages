import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface WorktreeRequest { cwd: string; name: string; base?: string; branch?: string }
/** A checked request: nothing exists yet, and git only ever sees the resolved commit. */
export interface WorktreePlan { root: string; path: string; branch: string; base: string; commit: string }
export interface Worktree extends WorktreePlan {
  head: string;
  /** Whether the repository ignores the new checkout; if not, the parent checkout shows it as untracked. */
  ignored: boolean;
}

// Git output ends with one newline; paths may legitimately end in other whitespace.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  return String(stderr ?? (error as Error).message ?? error).trim().split("\n").at(-1) ?? "git failed";
}

const succeeds = (run: () => unknown) => { try { run(); return true; } catch { return false; } };
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "child";

// The checkout goes under the repository containing cwd, following the
// collection's `.pi/worktrees/` convention. Nothing is written here.
export function planWorktree(request: WorktreeRequest): WorktreePlan {
  let root: string;
  try { root = git(request.cwd, "rev-parse", "--show-toplevel"); }
  catch { throw new Error(`Cannot create a worktree: ${request.cwd} is not inside a git repository.`); }
  const directory = `${slug(request.name)}-${randomBytes(3).toString("hex")}`;
  const branch = request.branch ?? `subagent/${directory}`;
  // A literal full ref: `--branch` would expand shorthand such as @{-1} to another branch.
  if (branch.startsWith("-") || branch.includes("@{") || branch === "@" || !succeeds(() => git(root, "check-ref-format", `refs/heads/${branch}`))) throw new Error(`Invalid worktree branch name: ${JSON.stringify(branch)}`);
  if (succeeds(() => git(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`))) throw new Error(`Worktree branch ${branch} already exists; choose another.`);
  const base = request.base ?? "HEAD";
  let commit: string;
  try {
    if (base.startsWith("-")) throw new Error("option-shaped");
    commit = git(root, "rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`);
  } catch { throw new Error(`Worktree base ${JSON.stringify(base)} is not a commit in ${root}.`); }
  return { root, path: join(root, ".pi", "worktrees", directory), branch, base, commit };
}

// Creation only: merging, and removing a finished checkout, stay with the parent.
// Any failure, including one after git wrote the checkout, removes what it made.
export function createWorktree(request: WorktreeRequest | WorktreePlan): Worktree {
  const plan = "commit" in request ? request : planWorktree(request);
  try {
    git(plan.root, "worktree", "add", "-b", plan.branch, plan.path, plan.commit);
    const ignored = succeeds(() => git(plan.root, "check-ignore", "-q", plan.path));
    return { ...plan, head: git(plan.path, "rev-parse", "HEAD"), ignored };
  } catch (error) {
    // Only what this attempt made: a checkout registered at the planned path on the
    // planned branch. A branch or checkout another process created stays.
    if (registeredBranch(plan) === `refs/heads/${plan.branch}`) removeWorktree(plan);
    throw new Error(`Cannot create a worktree on branch ${plan.branch} from ${plan.base}: ${gitError(error)}`);
  }
}

/** The branch git has registered for a checkout at the plan's path, if any. */
function registeredBranch(plan: WorktreePlan): string | undefined {
  let listing: string;
  try { listing = git(plan.root, "worktree", "list", "--porcelain"); } catch { return undefined; }
  const entry = listing.split("\n\n").map(block => block.split("\n")).find(lines => lines[0] === `worktree ${plan.path}`);
  return entry?.find(line => line.startsWith("branch "))?.slice("branch ".length);
}

/** Undo a creation this package made: the checkout and its branch. */
export function removeWorktree(worktree: WorktreePlan): void {
  succeeds(() => git(worktree.root, "worktree", "remove", "--force", "--force", worktree.path));
  succeeds(() => git(worktree.root, "worktree", "prune"));
  if (succeeds(() => git(worktree.root, "show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`))) git(worktree.root, "branch", "-D", worktree.branch);
}
