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
