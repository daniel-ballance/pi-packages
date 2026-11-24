import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../generator/git-env.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(pkg, path), "utf8");
const playbook = name => read(`skills/poteto-mode/playbooks/${name}.md`);
const skill = name => read(`skills/${name}/SKILL.md`);
const audit = join(pkg, "skills/poteto-mode/scripts/worktree-audit.sh");

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p3stack-procedures-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function auditFixture(t, name = "worker") {
  const root = scratch(t), repo = join(root, "main tree"), wt = join(root, name);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // No real forge, remote, session history, global config or hooks.
  for (const tool of ["origin", "gh"]) writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = gitEnv({ ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: "",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=test@example.org", "commit", "-qm", "base");
  git("-C", repo, "worktree", "add", "--detach", wt, "HEAD");
  function rows() {
    const result = execFileSync("bash", [audit, "-b", "main", repo], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return result.trimEnd().split("\n").slice(2).map(line => line.split("\t"));
  }
  return { repo, wt, env, git, rows };
}

test("audit preserves whole worktree paths and omits the main checkout", t => {
  const { wt, rows } = auditFixture(t, "worker with spaces");
  assert.deepEqual(rows().map(row => [row[8], row[7]]), [[wt, "safe"]]);
});

for (const [file, description] of [["new-module.ts", "only copy of new source"], ["build/output", "ignored build output"]]) {
  test(`audit holds ${description}, even when user settings hide untracked files`, t => {
    const { wt, git, rows } = auditFixture(t);
    git("-C", wt, "config", "status.showUntrackedFiles", "no");
    mkdirSync(join(wt, "build"));
    writeFileSync(join(wt, file), "only copy\n");
    assert.equal(rows()[0][7], "hold-untracked");
  });
}

test("a failed status inspection cannot make a merged worktree safe", t => {
  const { wt, git, rows } = auditFixture(t);
  writeFileSync(join(git("-C", wt, "rev-parse", "--absolute-git-dir"), "index"), "broken index");
  assert.equal(rows()[0][7], "unknown");
});

test("a recent Pi session started in a worktree subdirectory holds the worktree", t => {
  const { wt, env, rows } = auditFixture(t);
  const cwd = join(wt, "src");
  mkdirSync(cwd);
  const dir = join(env.PI_CODING_AGENT_DIR, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ type: "session", cwd }) + "\n");
  assert.equal(rows()[0][7], "verify-recent-chat");
});

test("audit help discloses the fetch rather than promising a read-only operation", () => {
  const help = execFileSync("bash", [audit, "--help"], { encoding: "utf8" });
  assert.match(help, /fetch/i);
  assert.doesNotMatch(help, /read-only/i);
});

test("cleanup requires approval for the named non-versioned files and holds unknown owners", () => {
  const text = playbook("worktree-cleanup");
  assert.match(text, /hold-untracked/);
  assert.match(text, /list[^\n]*untracked[^\n]*ignored[^\n]*operator[^\n]*approv/i);
  assert.match(text, /owner you cannot establish counts as in use/);
  assert.doesNotMatch(text, /throwaway|rm -rf|remove --force|delete all/i);
});

test("PR delivery has an explicit trigger and never resets a checkout between children", () => {
  const text = playbook("opening-a-pr");
  assert.match(text, /request.*playbook.*delivery step/i);
  assert.match(text, /never after a read-only investigation, review, design or plan/i);
  assert.doesNotMatch(text, /end of every other playbook|reset --hard|reset from main/);
});
