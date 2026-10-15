import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface WorktreeRequest { cwd: string; name: string; base?: string; branch?: string }
export interface Worktree {
  path: string; branch: string; base: string; head: string;
  /** Whether the repository ignores the new checkout; if not, the parent checkout shows it as untracked. */
  ignored: boolean;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  return String(stderr ?? (error as Error).message ?? error).trim().split("\n").at(-1) ?? "git failed";
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "child";

// Creation only: merging, and removing a finished checkout, stay with the parent.
// The checkout goes under the repository containing cwd, following the
// collection's `.pi/worktrees/` convention, so workingDirectories still apply.
export function createWorktree(request: WorktreeRequest): Worktree {
  let root: string;
  try { root = git(request.cwd, "rev-parse", "--show-toplevel"); }
  catch { throw new Error(`Cannot create a worktree: ${request.cwd} is not inside a git repository.`); }
  const directory = `${slug(request.name)}-${randomBytes(3).toString("hex")}`;
  const path = join(root, ".pi", "worktrees", directory);
  const branch = request.branch ?? `subagent/${directory}`;
  const base = request.base ?? "HEAD";
  try { git(root, "worktree", "add", "-b", branch, path, base); }
  catch (error) { throw new Error(`Cannot create a worktree on branch ${branch} from ${base}: ${gitError(error)}`); }
  let ignored = false;
  try { git(root, "check-ignore", "-q", path); ignored = true; } catch { /* not ignored */ }
  return { path, branch, base, head: git(path, "rev-parse", "HEAD"), ignored };
}

/** Undo createWorktree after a failed spawn: the checkout and the branch it created. */
export function removeWorktree(worktree: Worktree): void {
  const root = git(worktree.path, "rev-parse", "--path-format=absolute", "--git-common-dir").replace(/\/\.git$/, "");
  git(root, "worktree", "remove", "--force", worktree.path);
  git(root, "branch", "-D", worktree.branch);
}
