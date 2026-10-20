import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generate } from "../generator/generate.mjs";

const cli = fileURLToPath(new URL("../generator/lint-hosts.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-host-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const run = (...args) => spawnSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8" });
  return { root, write, run };
}

for (const token of ["mcp__t3", "delegate_task", "task_status", "schedule_task", "watch_pull_request", "t3_thread_read"]) {
  test(`host lint names the fixture skill containing ${token}`, t => {
    const f = fixture(t);
    f.write("skills/fixture/SKILL.md", `# Fixture\n\nCall ${token}.\n`);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`skills/fixture/SKILL.md:3: ${token}`), result.stderr);
  });
}

test("host lint permits tool names only in the exact host map", t => {
  const f = fixture(t);
  f.write("skills/poteto-mode/references/host-capabilities.md", "delegate_task\n");
  f.write("skills/fixture/SKILL.md", "Read the host capabilities.\n");
  assert.equal(f.run().status, 0);
  f.write("skills/fixture/host-capabilities.md", "delegate_task\n");
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /skills\/fixture\/host-capabilities.md:1: delegate_task/);
});

test("host lint also scans emitted agents and resources", t => {
  const f = fixture(t);
  f.write("agents/fixture.md", "mcp__t3-code__task_status\n");
  f.write("skills/fixture/scripts/check.ts", "schedule_task\n");
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /agents\/fixture.md:1: mcp__t3/);
  assert.match(result.stderr, /skills\/fixture\/scripts\/check.ts:1: schedule_task/);
});

test("generation rejects a host-specific token in a staged fixture skill", t => {
  const f = fixture(t);
  f.write("rules/manifest.json", JSON.stringify({ sources: [{ name: "fixture", vendor: "vendor/fixture", map: [{ from: "skills/", to: "skills/" }] }] }));
  f.write("vendor/fixture/skills/fixture/SKILL.md", "# Fixture\n\nCall delegate_task.\n");
  assert.throws(() => generate({ packageDir: f.root, outDir: join(f.root, "out") }), /skills\/fixture\/SKILL.md:3: delegate_task/);
});

test("host lint rejects missing roots and invalid arguments", t => {
  const f = fixture(t);
  const missing = spawnSync(process.execPath, [cli, "--root", join(f.root, "missing")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing/);
  const invalid = f.run("--unknown");
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage/);
});
