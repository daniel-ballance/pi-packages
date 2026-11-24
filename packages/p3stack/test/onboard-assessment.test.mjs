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

test("each write-producing subprocedure stops at its assessment boundary", () => {
  const doc = readFileSync(new URL("playbooks/onboard-brownfield.md", mode), "utf8");
  assert.doesNotMatch(doc, /git status --short|produce its HTML candidate report|follow its procedure\./i);
  assert.match(doc, /checkout-fingerprint\.mjs/);
  for (const focus of [/label/i, /feature map/i, /update.*glossary|glossary.*update/i, /browser/i]) assert.match(doc, focus);
});
