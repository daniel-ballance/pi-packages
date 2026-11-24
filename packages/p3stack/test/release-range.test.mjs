import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test from "node:test";

test("release PR lookup walks the release branch even when main advances and dates coincide", t => {
  const doc = readFileSync(new URL("../skills/release/SKILL.md", import.meta.url), "utf8");
  assert.doesNotMatch(doc, /merged:>=|defaultBranchRef/);
  const lookup = doc.match(/```sh\n([\s\S]*?gh api[\s\S]*?)\n```/)?.[1];
  assert.ok(lookup, "commit-to-PR lookup command");
  const root = mkdtempSync(join(tmpdir(), "release-range-")), bin = join(root, "bin");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@b", GIT_COMMITTER_DATE: "2020-04-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-04-01T00:00:00Z" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const commit = msg => { git("commit", "--allow-empty", "-qm", msg); return git("rev-parse", "HEAD"); };
  git("init", "-qb", "main"); const first = commit("base"); git("tag", "lib-1.0");
  commit("main only"); git("switch", "-qc", "release/1.x", "lib-1.0");
  const backport = commit("backport"), direct = commit("direct fix"); git("switch", "-q", "main");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$calls"\nprintf "[]\\n"\n', { mode: 0o755 });
  const calls = join(root, "calls");
  for (const [tag, shas] of [["lib-1.0", [backport, direct]], ["", [first, backport, direct]]]) {
    writeFileSync(calls, "");
    const run = spawnSync("bash", ["-c", lookup], { cwd: root, encoding: "utf8", env: { ...env, PATH: bin + delimiter + env.PATH, tag, release_head: direct, repo: "org/lib", calls } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").map(line => line.match(/repos\/org\/lib\/commits\/(\w+)\/pulls/)?.[1]), shas);
  }
});
