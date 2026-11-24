import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../skills/maintain-p3stack/", import.meta.url));
const read = path => readFileSync(join(dir, path), "utf8");

test("a ref selects an audit; bump, landing and revert steps are disclosed separately", () => {
  const main = read("SKILL.md");
  for (const mode of ["audit", "bump", "land", "revert"]) assert.ok(main.includes(`(references/${mode}.md)`), mode);
  assert.match(main, /ref alone[^\n]*audit/i);
  for (const doc of [main, read("references/audit.md")]) assert.doesNotMatch(doc, /gh pr merge|git revert --no-edit|gh pr close|read .*references\/land\.md.*before audit/i);
  assert.match(read("references/audit.md"), /ls-remote|rev-parse/);
});

test("revert verifies repository, main, merge ancestry, changed paths and bump receipt first", () => {
  const doc = read("references/revert.md"), revert = doc.indexOf("git revert --no-edit");
  assert.ok(revert > 0);
  const before = doc.slice(0, revert);
  for (const evidence of [/base\.repo\.full_name/, /base\.ref/, /main/, /merged/, /merge-base --is-ancestor/, /git diff/, /docs\/bumps/, /gitlink/, /stop|blocked/i]) assert.match(before, evidence);
});

test("maintenance sources share one durable note; nightly resolves a role", () => {
  const docs = ["SKILL.md", "references/nightly.md", "references/bump-note.md", "references/bump.md"].map(read);
  docs.forEach(doc => assert.doesNotMatch(doc, /note (?:for|per) each (?:affected )?source|per affected source|operator-selected Sonnet/i));
  assert.match(docs[2], /commit.*pull request.*CI/i);
  assert.match(docs[2], /every source/i);
  assert.match(docs[2], /docs\/bumps\/README.md/);
  assert.match(docs[1], /role/i);
});

test("smoke credentials stay private and are removed after success, failure or interruption", t => {
  const base = mkdtempSync(join(tmpdir(), "smoke-guard-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tmp = join(base, "tmp"), auth = join(base, "agent");
  mkdirSync(tmp); mkdirSync(auth); writeFileSync(join(auth, "auth.json"), "fixture credential", { mode: 0o644 });
  for (const [finish, expected] of [["process.exit(0)", 0], ["process.exit(17)", 17], ["process.kill(process.ppid, 'SIGTERM')", 143]]) {
    const probe = `const fs = require('node:fs'), dir = process.env.PI_CODING_AGENT_DIR; console.log(JSON.stringify([dir, ...[dir, dir+'/auth.json', dir+'/settings.json'].map(f => fs.statSync(f).mode & 0o777)])); ${finish}`;
    const run = spawnSync("bash", [join(dir, "scripts/with-smoke-dir.sh"), process.execPath, "-e", probe], { cwd: new URL("../../../", import.meta.url), encoding: "utf8", env: { ...process.env, TMPDIR: tmp, PI_CODING_AGENT_DIR: auth } });
    assert.equal(run.status, expected, run.stderr);
    const [fixture, ...modes] = JSON.parse(run.stdout);
    assert.deepEqual(modes, [0o700, 0o600, 0o600]);
    assert.notEqual(fixture, auth); assert.equal(existsSync(fixture), false);
    assert.equal(readFileSync(join(auth, "auth.json"), "utf8"), "fixture credential");
  }
});
