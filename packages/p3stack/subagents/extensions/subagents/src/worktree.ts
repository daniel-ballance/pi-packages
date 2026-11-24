import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

let repoGitEnv: string[] | undefined;

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!repoGitEnv) {
    try {
      repoGitEnv = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .trim().split(/\s+/).filter(name => name !== "GIT_CONFIG_COUNT" && name !== "GIT_CONFIG_PARAMETERS");
    } catch {
      // Git may be unavailable; still prevent children from inheriting the caller's repository.
      repoGitEnv = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];
    }
  }
  const env = { ...base };
  for (const name of repoGitEnv) delete env[name];
  return env;
}

// Git output ends with one newline; paths may legitimately end in other whitespace.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).replace(/\n$/, "");

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  return String(stderr || (error as Error).message || error).trim().split("\n").at(-1) || "git failed";
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

// Claim the branch separately: a failed worktree add (including a checkout hook)
// can leave either a registration or just the branch. Never adopt a raced branch.
export function createWorktree(request: WorktreeRequest | WorktreePlan): Worktree {
  const plan = "commit" in request ? request : planWorktree(request);
  const lock = `subagent creation ${randomBytes(16).toString("hex")}`;
  let branchCreated = false;
  try {
    if (existsSync(plan.path)) throw new Error(`destination already exists: ${plan.path}`);
    git(plan.root, "branch", "--no-track", "--", plan.branch, plan.commit);
    branchCreated = true;
    // If a checkout hook fails, distinguish our partial registration from a competing add.
    git(plan.root, "worktree", "add", "--lock", "--reason", lock, "--", plan.path, plan.branch);
    const ignored = succeeds(() => git(plan.root, "check-ignore", "-q", plan.path));
    const head = git(plan.path, "rev-parse", "HEAD");
    git(plan.root, "worktree", "unlock", "--", plan.path);
    return { ...plan, head, ignored };
  } catch (error) {
    const failure = new Error(`Cannot create a worktree on branch ${plan.branch} from ${plan.base}: ${gitError(error)}`);
    if (branchCreated) removeWorktree(plan, failure, lock);
    throw failure;
  }
}

/** Roll back our unchanged checkout and branch. Let git refuse dirty or locked checkouts. */
export function removeWorktree({ root, path, branch, commit }: WorktreePlan, failure?: unknown, creationLock?: string): void {
  try {
    const ref = `refs/heads/${branch}`;
    const entry = git(root, "worktree", "list", "--porcelain", "-z").split("\0\0")
      .map(block => block.split("\0")).find(lines => lines[0] === `worktree ${path}`);
    if (entry) {
      if (!entry.includes(`branch ${ref}`) || !entry.includes(`HEAD ${commit}`)) throw new Error("checkout branch or commit changed");
      if (creationLock) {
        if (!entry.includes(`locked ${creationLock}`)) throw new Error("checkout was not registered by this creation");
        git(root, "worktree", "unlock", "--", path);
      }
      git(root, "worktree", "remove", "--", path);
    } else if (existsSync(path)) throw new Error("path is not a registered worktree");
    if (git(root, "rev-parse", "--verify", ref) !== commit) throw new Error("branch no longer points at its starting commit");
    // Unlike update-ref -d, branch refuses to delete a branch in use in another checkout.
    git(root, "branch", "-D", "--", branch);
  } catch (error) {
    throw new Error(`${failure ? `${failure}; ` : ""}Cleanup failed for worktree ${path} (branch ${branch}): ${gitError(error)}. Inspect it before manual cleanup.`, { cause: error });
  }
}
