import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chmodSync } from "node:fs";
import { createWorktree, planWorktree, removeWorktree } from "../extensions/subagents/src/worktree.js";
import { git as runGit } from "./git.js";

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-repo-")));
  const git = (...args: string[]) => runGit(["-C", root, ...args], { encoding: "utf8" }).trim();
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

test("the base is resolved to a commit first, so a different base really is the starting point", () => {
  const { root, git, dispose } = repo();
  try {
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(root, "later.md"), "later\n");
    git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "later");
    const created = createWorktree({ cwd: root, name: "old", base: first });
    assert.equal(created.head, first);
    assert.equal(existsSync(join(created.path, "later.md")), false);
  } finally { dispose(); }
});

test("option-shaped or malformed bases and branches are refused before git runs", () => {
  const { root, git, dispose } = repo();
  try {
    for (const base of ["--lock", "--no-checkout", "-b"]) assert.throws(() => createWorktree({ cwd: root, name: "x", base }), /base/, base);
    for (const branch of ["--orphan", "-x", "bad..name", "with space"]) assert.throws(() => createWorktree({ cwd: root, name: "x", branch }), /branch/, branch);
    assert.equal(git("worktree", "list").split("\n").length, 1);
  } finally { dispose(); }
});

test("a git failure after git has written the checkout still leaves nothing behind", () => {
  const { root, git, dispose } = repo();
  try {
    const hook = join(root, ".git/hooks/post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
    assert.throws(() => createWorktree({ cwd: root, name: "hooked" }), /Cannot create a worktree/);
    assert.equal(git("worktree", "list").split("\n").length, 1, "no checkout left");
    assert.equal(git("branch", "--list", "subagent/*"), "", "no branch left");
  } finally { dispose(); }
});

test("the plan names the destination before anything is created, keeping whitespace in paths", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "worktree-space-")));
  const root = join(parent, "trailing ");
  mkdirSync(root);
  const git = (...args: string[]) => runGit(["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main"); writeFileSync(join(root, "a"), "a\n"); git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a");
    const plan = planWorktree({ cwd: root, name: "spacey" });
    assert.ok(plan.path.startsWith(`${root}/.pi/worktrees/spacey-`));
    assert.equal(existsSync(plan.path), false, "planning creates nothing");
    assert.equal(createWorktree(plan).path, plan.path);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("cleanup removes only what this attempt created, never another process's branch or checkout", () => {
  const { root, git, dispose } = repo();
  try {
    const plan = planWorktree({ cwd: root, name: "raced", branch: "work/raced" });
    git("branch", "work/raced"); // another process wins the race for the branch
    assert.throws(() => createWorktree(plan), /work\/raced/);
    assert.equal(git("branch", "--list", "work/raced").trim(), "work/raced", "their branch survives");
    const other = planWorktree({ cwd: root, name: "occupied" });
    git("worktree", "add", "-b", "theirs", other.path); // and for the checkout path
    writeFileSync(join(other.path, "uncommitted.txt"), "theirs\n");
    assert.throws(() => createWorktree(other));
    assert.equal(existsSync(join(other.path, "uncommitted.txt")), true, "their checkout survives");
  } finally { dispose(); }
});

test("branch shorthand that git would expand is refused", () => {
  const { root, git, dispose } = repo();
  try {
    git("checkout", "-q", "-b", "old"); git("checkout", "-q", "main"); git("branch", "-D", "old");
    for (const branch of ["@{-1}", "@", "feature@{1}"]) assert.throws(() => createWorktree({ cwd: root, name: "x", branch }), /branch/, branch);
  } finally { dispose(); }
});
