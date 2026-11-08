import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { floorCheck, format, parseDiff } from "../authored/skills/p3stack-mode/scripts/floor-check.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../authored/skills/p3stack-mode/scripts/floor-check.mjs");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() };
// Forbidden tokens are assembled so this file's own diff stays clean under floor-check.
const T = { tsIgnore: "@ts-" + "ignore", tsExpect: "@ts-" + "expect-error", eslint: "eslint-" + "disable-next-line", noqa: "# no" + "qa", skip: "it." + "skip(", only: "describe." + "only(", pyskip: "@pytest.mark." + "skip", notImpl: "throw new Error(\"Not " + "implemented\")", raise: "raise NotImplemented" + "Error" };

function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "floor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  write(root, files);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, git };
}
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
const categories = result => result.findings.map(item => `${item.category} ${item.path}:${item.line}`);

test("a clean change has no findings and exits 0", t => {
  const { root } = repo(t, { "src/a.ts": "export const a = 1;\n" });
  write(root, { "src/a.ts": "export const a = 2;\n" });
  const result = floorCheck({ cwd: root });
  assert.deepEqual(result.findings, []);
  const run = spawnSync(process.execPath, [script, "--cwd", root], { env, encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "floor-check: 0 finding(s), 0 explained\n");
});

test("suppressions, skipped tests, stubs and swallowed errors are reported at their added lines", t => {
  const { root, git } = repo(t, { "src/a.ts": "export const a = 1;\n", "keep.txt": "x\n" });
  git("checkout", "-q", "-b", "work");
  write(root, { "src/a.ts": [
    "export const a = 1;",
    `// ${T.tsIgnore}`,
    `// ${T.tsExpect}`,
    `// ${T.tsExpect} -- upstream types are wrong`,
    `// ${T.eslint} no-console`,
    `${T.skip}"x", () => {});`,
    `${T.only}"y", () => {});`,
    `canvas.fit(1);`,
    `function f() { ${T.notImpl}; }`,
    "try { f(); } catch (e) {" + "}",
    "",
  ].join("\n") });
  git("add", "-A");
  git("commit", "-q", "-m", "work");
  write(root, { "py/b.py": [`x = 1  ${T.noqa}`, T.pyskip, "def g():", `    ${T.raise}`, "try:", "    g()", "except Exception:", "    pass", ""].join("\n") });
  const result = floorCheck({ cwd: root });
  assert.deepEqual(categories(result), [
    "suppression py/b.py:1", "skipped-test py/b.py:2", "stub py/b.py:4", "swallowed-error py/b.py:7",
    "suppression src/a.ts:2", "suppression src/a.ts:3", "suppression src/a.ts:5", "skipped-test src/a.ts:6", "skipped-test src/a.ts:7", "stub src/a.ts:9", "swallowed-error src/a.ts:10",
  ]);
  assert.equal(result.base, git("rev-parse", "main").trim(), "the base is the merge-base with main");
  assert.match(format(result), /^floor-check: 11 finding\(s\), 0 explained\nsuppression py\/b\.py:1 /);
});

test("a floor-ok reason explains a finding; an empty one does not", t => {
  const { root } = repo(t, { "a.ts": "1;\n" });
  write(root, { "a.ts": `1;\n// ${T.tsIgnore} floor-ok: generated file\n// ${T.tsIgnore} floor-ok:\n` });
  const result = floorCheck({ cwd: root });
  assert.deepEqual(categories(result), ["suppression a.ts:3"]);
  assert.deepEqual(result.explained.map(item => item.line), [2]);
});

test("deleted tests and weakened constraints are reported", t => {
  const { root } = repo(t, {
    "test/a.test.ts": "ok\n",
    "pkg/b_test.go": "ok\n",
    "CONSTRAINTS.md": "# Constraints\n\n| Coverage | changed lines >= 80% |\n| Lint | zero errors |\n- No secrets in source\n",
    "vitest.config.ts": "coverage: { thresholds: { lines: 80 } }\n",
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
  });
  unlinkSync(join(root, "test/a.test.ts"));
  unlinkSync(join(root, "pkg/b_test.go"));
  write(root, {
    "CONSTRAINTS.md": "# Constraints\n\n| Coverage | changed lines >= 60% |\n| Lint | zero errors |\n",
    "vitest.config.ts": "coverage: { thresholds: { lines: 70 } }\n",
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": false } }\n",
  });
  const result = floorCheck({ cwd: root });
  assert.deepEqual(categories(result), [
    "weakened-threshold CONSTRAINTS.md:3", "weakened-threshold CONSTRAINTS.md:5",
    "deleted-test pkg/b_test.go:0", "deleted-test test/a.test.ts:0",
    "weakened-threshold tsconfig.json:1", "weakened-threshold vitest.config.ts:1",
  ]);
  assert.match(result.findings[0].text, /80% \| -> .*60%/);
});

test("raising a threshold is not a finding", t => {
  const { root } = repo(t, { "vitest.config.ts": "coverage: { thresholds: { lines: 70 } }\n" });
  write(root, { "vitest.config.ts": "coverage: { thresholds: { lines: 90 } }\n" });
  assert.deepEqual(floorCheck({ cwd: root }).findings, []);
});

test("the CLI exits 1 with findings, prints JSON, and exits 2 on a bad base", t => {
  const { root } = repo(t, { "a.ts": "1;\n" });
  write(root, { "a.ts": `1;\n// ${T.tsIgnore}\n` });
  const text = spawnSync(process.execPath, [script, "--cwd", root], { env, encoding: "utf8" });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^floor-check: 1 finding\(s\), 0 explained\nsuppression a\.ts:2 /);
  const json = spawnSync(process.execPath, [script, "--cwd", root, "--json"], { env, encoding: "utf8" });
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).findings[0].category, "suppression");
  const bad = spawnSync(process.execPath, [script, "--cwd", root, "--base", "no-such-ref"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown base no-such-ref/);
  const flag = spawnSync(process.execPath, [script, "--nope"], { env, encoding: "utf8" });
  assert.equal(flag.status, 2);
});

test("parseDiff tracks line numbers for removed and added lines", () => {
  const files = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,1 @@\n-old\n-gone\n+new\n");
  assert.deepEqual(files.get("x"), [{ removed: [{ line: 3, text: "old" }, { line: 4, text: "gone" }], added: [{ line: 3, text: "new" }], oldLine: 5, newLine: 4 }]);
});
