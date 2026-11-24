import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mode = new URL("../skills/p3stack-mode/", import.meta.url);
test("the assessment detects different tracked and untracked bytes under identical status labels", t => {
  const cwd = mkdtempSync(join(tmpdir(), "assessment-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q"); writeFileSync(join(cwd, "tracked"), "base"); git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "base");
  const state = () => execFileSync(process.execPath, [fileURLToPath(new URL("scripts/checkout-fingerprint.mjs", mode))], { cwd, encoding: "utf8" });
  const edit = (name, text) => writeFileSync(join(cwd, name), text);
  edit("tracked", "one"); edit("new\nfile", Buffer.from([0, 1]));
  const status = git("status", "--short"), before = state();
  assert.equal(state(), before);
  edit("tracked", "two"); assert.equal(git("status", "--short"), status); assert.notEqual(state(), before);
  edit("tracked", "one"); edit("new\nfile", Buffer.from([0, 2])); assert.equal(git("status", "--short"), status); assert.notEqual(state(), before);
  edit("new\nfile", Buffer.from([0, 1])); renameSync(join(cwd, "new\nfile"), join(cwd, "new name")); assert.notEqual(state(), before);
  renameSync(join(cwd, "new name"), join(cwd, "new\nfile")); assert.equal(state(), before);
  git("add", "tracked"); assert.notEqual(state(), before, "staging alone changes the reviewed state");
});

test("the local review's fingerprint detects a second edit in a dirty populated submodule", t => {
  const review = readFileSync(new URL("playbooks/review-local.md", mode), "utf8");
  const operand = review.match(/node "<p3stack-mode directory>\/(scripts\/checkout-fingerprint\.mjs)"/)?.[1];
  assert.ok(operand);
  assert.match(review, /each populated submodule/);
  const root = mkdtempSync(join(tmpdir(), "review-submodule-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", ["--no-optional-locks", "-c", "user.name=t", "-c", "user.email=t@example.org", ...args], { cwd, encoding: "utf8" });
  const dep = join(root, "dep"), repo = join(root, "repo"), child = join(repo, "sub dir");
  git(root, "init", "-q", dep);
  writeFileSync(join(dep, "value"), "original");
  git(dep, "add", "."); git(dep, "commit", "-qm", "base");
  git(root, "init", "-q", repo);
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dep, "sub dir");
  git(repo, "commit", "-qm", "pin");
  const baseline = () => execFileSync(process.execPath, [fileURLToPath(new URL(operand, mode))], { cwd: child, encoding: "utf8" });
  writeFileSync(join(child, "value"), "one");
  const before = baseline(), status = git(repo, "status", "--porcelain");
  writeFileSync(join(child, "value"), "two");
  assert.equal(git(repo, "status", "--porcelain"), status);
  assert.notEqual(baseline(), before);
});

test("each write-producing subprocedure stops at its assessment boundary", () => {
  const doc = readFileSync(new URL("playbooks/onboard-brownfield.md", mode), "utf8");
  assert.doesNotMatch(doc, /git status --short|produce its HTML candidate report|follow its procedure\./i);
  assert.match(doc, /checkout-fingerprint\.mjs/);
  for (const focus of [/label/i, /feature map/i, /update.*glossary|glossary.*update/i, /browser/i]) assert.match(doc, focus);
});
