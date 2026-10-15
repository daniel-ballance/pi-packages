import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorktree, removeWorktree } from "../extensions/subagents/src/worktree.js";

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hello\n");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return { root, git, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("a worktree is created under .pi/worktrees on a new branch from HEAD", () => {
  const { root, git, dispose } = repo();
  try {
    mkdirSync(join(root, "src"));
    const created = createWorktree({ cwd: join(root, "src"), name: "Auth Review!" });
    assert.match(created.path, new RegExp(`^${root}/\\.pi/worktrees/auth-review-[0-9a-f]{6}$`));
    assert.equal(created.branch, `subagent/${created.path.split("/").at(-1)}`);
    assert.equal(created.base, "HEAD");
    assert.equal(created.head, git("rev-parse", "HEAD"));
    assert.ok(existsSync(join(created.path, "README.md")));
    assert.match(git("worktree", "list"), new RegExp(created.path.replace(/[.]/g, "\\.")));
    assert.equal(created.ignored, false, "this repository does not ignore .pi/worktrees");
  } finally { dispose(); }
});

test("a base and branch can be chosen, and a bad one fails without leaving anything behind", () => {
  const { root, git, dispose } = repo();
  try {
    writeFileSync(join(root, ".gitignore"), ".pi/worktrees/\n");
    git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
    git("branch", "feature");
    const created = createWorktree({ cwd: root, name: "fix", base: "feature", branch: "work/fix" });
    assert.equal(created.branch, "work/fix");
    assert.equal(created.base, "feature");
    assert.equal(created.ignored, true);
    assert.throws(() => createWorktree({ cwd: root, name: "again", branch: "work/fix" }), /work\/fix/);
    assert.throws(() => createWorktree({ cwd: root, name: "nowhere", base: "no-such-ref" }), /no-such-ref/);
    assert.equal(git("worktree", "list").split("\n").length, 2, "failed attempts leave no worktree");
  } finally { dispose(); }
});

test("outside a git repository the request fails and says why", () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "not-a-repo-")));
  try {
    assert.throws(() => createWorktree({ cwd: plain, name: "x" }), /not inside a git repository/);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test("removing a worktree created for a failed spawn also deletes its new branch", () => {
  const { root, git, dispose } = repo();
  try {
    const created = createWorktree({ cwd: root, name: "doomed" });
    removeWorktree(created);
    assert.equal(existsSync(created.path), false);
    assert.equal(git("branch", "--list", created.branch), "");
  } finally { dispose(); }
});
