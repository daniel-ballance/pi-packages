import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("audit and host repair reach the installed live check; the landing guide links to its source", () => {
  const ref = "references/verify-host.md";
  for (const caller of ["audit", "host-repair"]) assert.ok(read(`references/${caller}.md`).includes(`(${ref})`));
  const live = read(ref);
  for (const gate of [/PI_CODING_AGENT_DIR.*(?:throwaway|disposable)/, /p3stack doctor/, /check-t3-contract\.mjs --doctor <dump>/, /--installed/, /behavior/]) assert.match(live, gate);
  const guide = read("../../docs/landing/t3-settings.md");
  assert.ok(guide.includes(`(../../authored/skills/maintain-p3stack/${ref})`));
  assert.doesNotMatch(guide, /--doctor <dump>/);
  const fixes = read("references/failure-classes.md");
  assert.match(fixes, /Host lint[^\n]*host-terminal\.md[^\n]*host-t3\.md/);
  assert.match(fixes, /unclassified host map operation[^\n]*t3-contract\.json[^\n]*host-t3\.md/);
});

test("reference failures have repairs and all three classifications have examples", () => {
  const guide = read("references/failure-classes.md");
  for (const diagnostic of ["removed skill command", "must be an emitted skill", "both land at", "nested SKILL.md", "reference needs its registered name and description", "Missing reference", "unrebased resource path"]) {
    assert.ok(guide.split("\n").some(line => line.startsWith("|") && line.includes(diagnostic)), diagnostic);
  }
  const examples = [...guide.matchAll(/```json\n([^`]+)\n```/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(examples.map(row => row.action).sort(), ["drop", "emit", "reference"]);
  assert.ok(examples.find(row => row.action === "reference").owner);
});

test("a shared checkout moves once, to the checked SHA even on a tip run", () => {
  const bump = read("references/bump.md");
  assert.match(bump, /ls-remote[^\n]*full (?:commit )?SHA/i);
  assert.match(bump, /npm run bump -- <source> <checked-sha>` once per checkout/i);
  assert.doesNotMatch(bump, /bump for each source/);
});

test("audit and candidate consume the root check, not a second set of its component commands", () => {
  for (const phase of ["audit", "bump", "verify-host"]) {
    const guide = read(`references/${phase}.md`);
    assert.doesNotMatch(guide, /`(?:npm (?:run check|test)|node generator\/(?:generate\.mjs --check|check-registry\.mjs|check-t3-[\w-]+\.mjs))`/, phase);
  }
  assert.match(read("references/bump.md"), /pre-push/);
  const landing = read("references/land.md");
  assert.match(landing, /merge commit[^\n]*\.\/scripts\/check\.sh/);
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

test("smoke rejects the physical selected agent directory and descendants before mktemp", t => {
  const home = mkdtempSync(join(tmpdir(), "smoke-guard-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = join(home, "custom agent"), child = join(agent, "sub"), alias = join(home, "linked agent");
  mkdirSync(child, { recursive: true }); symlinkSync(agent, alias);
  // Stop before any creation or credential access if the guard fails.
  writeFileSync(join(home, "mktemp"), '#!/bin/sh\necho reached-mktemp >&2\nexit 23\n', { mode: 0o755 });
  for (const TMPDIR of [agent, child]) {
    const run = spawnSync("bash", [join(dir, "scripts/with-smoke-dir.sh"), "true"], { cwd: new URL("../../../", import.meta.url), encoding: "utf8",
      env: { ...process.env, PATH: home + ":" + process.env.PATH, HOME: home, TMPDIR, PI_CODING_AGENT_DIR: alias } });
    assert.equal(run.status, 2, run.stderr);
    assert.doesNotMatch(run.stderr, /reached-mktemp/);
  }
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
