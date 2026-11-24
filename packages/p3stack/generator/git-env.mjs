import { execFileSync } from "node:child_process";

let repoGitEnv;

export function gitEnv(base = process.env) {
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

export function gitAt(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).trimEnd();
}

export function requireCleanCheckout(checkout, subtree = ".") {
  const status = gitAt(checkout, "-c", "core.fileMode=true", "status", "--porcelain=v1", "--untracked-files=all", "--ignored", "--ignore-submodules=none", "--", subtree);
  const flags = gitAt(checkout, "ls-files", "-v", "-z", "--", subtree).split("\0").filter(entry => /^[a-zS] /.test(entry));
  if (!status && !flags.length) return;
  const details = [status && `Git status (including ignored files):\n${status}`, flags.length && `Index flags (skip-worktree or assume-unchanged):\n${flags.join("\n")}`].filter(Boolean);
  throw new Error(`${checkout} has local changes; clean upstream inputs are required.\n${details.join("\n")}\nCopy local work, including ignored files, outside the checkout before restoring clean inputs and clearing any listed index flags.`);
}
