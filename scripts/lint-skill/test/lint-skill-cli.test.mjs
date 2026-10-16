import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "lint-skill.mjs");

function run(args, options = {}) {
  return runExecutable(cli, args, options);
}

function runExecutable(executable, args, options = {}) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function tempDirectory(t, name) {
  const root = mkdtempSync(join(tmpdir(), `lint-skill-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeSkill(parent, name, body = "A useful skill.\n") {
  const skill = join(parent, name);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), [
    "---",
    `name: ${name}`,
    "description: A useful skill for testing.",
    "---",
    "",
    body,
  ].join("\n"));
  return skill;
}

test("help is available without importing the core linter", () => {
  const result = run(["--help"], { cwd: "/" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lint-skill <directory>/);
  assert.match(result.stdout, /Exit codes/);
  assert.match(result.stdout, /lint-skill \.\/skills\/example/);
  assert.equal(result.stderr, "");
});

test("the npm-style symlink still executes the CLI", (t) => {
  const root = tempDirectory(t, "bin-link");
  const link = join(root, "lint-skill");
  symlinkSync(cli, link);

  const result = runExecutable(link, ["--help"], { cwd: "/" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: lint-skill/);
});

test("an option cannot consume another option as its value", () => {
  const result = run(["/tmp", "--format", "--config", "/tmp/no-config", "--format", "json"], { cwd: "/" });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).errors[0], /--format requires a value/);
});

test("an empty config option is rejected before filesystem access", () => {
  const result = run(["/tmp", "--config", "", "--format", "json"], { cwd: "/" });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).errors[0], /--config requires a value/);
});

test("invalid JSON invocation returns the frozen envelope and exit 2", () => {
  const result = run(["/tmp", "--format", "json", "--unknown"], { cwd: "/" });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    complete: false,
    results: [],
    counts: { error: 0, warning: 0 },
    errors: ["unknown option: --unknown"],
  });
});

test("config selectors are relative to the config and exceptions stay skill-local", (t) => {
  const root = tempDirectory(t, "valid-config");
  const skills = join(root, "skills");
  const skill = makeSkill(skills, "example");
  const other = makeSkill(skills, "other");
  writeFileSync(join(skill, "LICENSE"), "Attribution.\n");
  const configPath = join(root, "lint-skill.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    skills: [{
      path: "./skills/example",
      exceptions: [
        { rule: "orphan", path: "LICENSE", reason: "Legal attribution" },
      ],
    }],
  }));

  const selected = run([skill, "--config", configPath, "--format", "json"], { cwd: "/" });
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).results[0].appliedExceptions, [
    { rule: "orphan", path: "LICENSE", reason: "Legal attribution" },
  ]);

  const unselected = run([other, "--config", configPath, "--format", "json"], { cwd: "/" });
  assert.equal(unselected.status, 0, unselected.stderr);
  assert.deepEqual(JSON.parse(unselected.stdout).results[0].appliedExceptions, []);
});

test("config validation rejects the frozen schema violations through the CLI", (t) => {
  const root = tempDirectory(t, "invalid-config");
  const skill = makeSkill(root, "example");
  const cases = [
    [{ version: 1, skills: [], extra: true }, /unknown key/],
    [{ version: 1, skills: [{ path: "./a", exceptions: [] }, { path: "a", exceptions: [] }] }, /duplicates/],
    [{ version: 1, skills: [{ path: "./a", exceptions: [{ rule: "orphan", path: "LICENSE", reason: " " }] }] }, /non-empty string/],
    [{ version: 1, skills: [{ path: "./a", exceptions: [{ rule: "orphan", path: "/LICENSE", reason: "why" }] }] }, /must be relative/],
    [{ version: 1, skills: [{ path: "./a", exceptions: [{ rule: "orphan", path: "../LICENSE", reason: "why" }] }] }, /must not contain \.\./],
    [{ version: 1, skills: [{ path: "./a", exceptions: [{ rule: "depth", path: "x", maxDepth: 2, reason: "why" }] }] }, /from 3 to 100/],
  ];

  for (const [index, [value, pattern]] of cases.entries()) {
    const config = join(root, `invalid-${index}.json`);
    writeFileSync(config, JSON.stringify(value));
    const result = run([skill, "--config", config, "--format", "json"], { cwd: "/" });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(JSON.parse(result.stdout).errors.some((message) => pattern.test(message)));
  }
});

test("duplicate skill arguments produce one deterministic JSON result", (t) => {
  const root = tempDirectory(t, "duplicates");
  const skill = makeSkill(root, "example");
  const result = run([skill, skill, "--format", "json"], { cwd: "/" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].skill, skill);
});

test("warnings are allowed normally and fail under strict mode", (t) => {
  const root = tempDirectory(t, "strict");
  const skill = makeSkill(root, "warning-skill");
  writeFileSync(join(skill, "SKILL.md"), [
    "---",
    "name: warning-skill",
    "description: A useful skill for testing.",
    "custom-field: true",
    "---",
    "",
    "Body.",
    "",
  ].join("\n"));

  const normal = run([skill, "--format", "json"], { cwd: "/" });
  const strict = run([skill, "--strict", "--format", "json"], { cwd: "/" });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(strict.status, 1, strict.stderr);
  assert.equal(JSON.parse(normal.stdout).counts.warning, JSON.parse(strict.stdout).counts.warning);
  assert.ok(JSON.parse(normal.stdout).counts.warning > 0);
});

test("oversized input is incomplete and exits 2 before lint errors can pass", (t) => {
  const root = tempDirectory(t, "incomplete");
  const skill = makeSkill(root, "large-skill");
  writeFileSync(join(skill, "SKILL.md"), `${"x".repeat(1024 * 1024 + 1)}\n`);

  const result = run([skill, "--format", "json"], { cwd: "/" });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, false);
});

test("broken references are errors in both JSON and text output", (t) => {
  const root = tempDirectory(t, "broken");
  const skill = makeSkill(root, "broken-skill");
  writeFileSync(join(skill, "B.md"), "See [the missing guide](missing-b.md).\n");
  writeFileSync(join(skill, "a.md"), "See [the missing guide](missing-a.md).\n");

  const json = run([skill, "--format", "json"], { cwd: "/" });
  assert.equal(json.status, 1, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.ok(report.counts.error > 0);
  assert.equal(report.complete, true);

  const text = run([skill], { cwd: "/" });
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, new RegExp(`Summary: ${report.counts.error} error\\(s\\)`));
  assert.ok(text.stdout.indexOf("B.md") < text.stdout.indexOf("a.md"));
});

test("resource roots that omit a skill fail instead of being silently skipped", (t) => {
  const root = tempDirectory(t, "resource-root");
  const scope = join(root, "scope");
  mkdirSync(scope);
  const skill = makeSkill(root, "outside");
  const result = run([skill, "--resource-root", scope, "--format", "json"], { cwd: "/" });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, false);
  assert.match(report.errors[0], /does not contain skill root/);
});

test("resolved skill roots must also be inside the resource root", (t) => {
  const root = tempDirectory(t, "resolved-resource-root");
  const scope = join(root, "scope");
  const outside = join(root, "outside");
  mkdirSync(scope);
  const skill = makeSkill(outside, "linked-skill");
  const lexicalSkill = join(scope, "linked-skill");
  symlinkSync(skill, lexicalSkill, "dir");

  const result = run([lexicalSkill, "--resource-root", scope, "--format", "json"], { cwd: "/" });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.match(report.errors[0], /resolved skill root/);
});

test("text output preserves dependency status and exception reasons", (t) => {
  const root = tempDirectory(t, "text-details");
  const skills = join(root, "skills");
  const skill = makeSkill(skills, "text-skill", [
    "See [the shared guide](../guide.md) and [the website](https://example.test/docs).",
    "",
  ].join("\n"));
  writeFileSync(join(skills, "guide.md"), "Guide.\n");
  writeFileSync(join(skill, "LICENSE"), "Attribution.\n");
  const config = join(root, "lint-skill.json");
  writeFileSync(config, JSON.stringify({
    version: 1,
    skills: [{ path: "./skills/text-skill", exceptions: [{ rule: "orphan", path: "LICENSE", reason: "Legal attribution" }] }],
  }));

  const result = run([skill, "--resource-root", root, "--config", config], { cwd: "/" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /guide\.md/);
  assert.match(result.stdout, /https:\/\/example\.test\/docs/);
  assert.match(result.stdout, /unverified/i);
  assert.match(result.stdout, /Legal attribution/);
});

test("configured exact-file exceptions are passed through and reported as applied", (t) => {
  const root = tempDirectory(t, "exceptions");
  const skill = makeSkill(root, "exception-skill");
  writeFileSync(join(skill, "LICENSE"), "Attribution\n");
  const config = join(root, "lint-skill.json");
  writeFileSync(config, JSON.stringify({
    version: 1,
    skills: [{
      path: "./exception-skill",
      exceptions: [{ rule: "orphan", path: "LICENSE", reason: "Legal attribution" }],
    }],
  }));

  const result = run([skill, "--config", config, "--format", "json"], { cwd: "/" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.results[0].appliedExceptions, [
    { rule: "orphan", path: "LICENSE", reason: "Legal attribution" },
  ]);
});

test("non-regular config paths fail without blocking", (t) => {
  const root = tempDirectory(t, "config-type");
  const configDirectory = join(root, "config");
  mkdirSync(configDirectory);

  const result = run(["/tmp", "--config", configDirectory, "--format", "json"], {
    cwd: "/",
    timeout: 2000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).errors[0], /regular file/);
});

test("oversized config files are rejected before parsing", (t) => {
  const root = tempDirectory(t, "large-config");
  const config = join(root, "large.json");
  writeFileSync(config, JSON.stringify({ version: 1, skills: [], padding: "x".repeat(1024 * 1024) }));

  const result = run(["/tmp", "--config", config, "--format", "json"], { cwd: "/" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).errors[0], /exceeds/);
});

test("a malformed config is a clean JSON configuration failure", (t) => {
  const root = tempDirectory(t, "config");
  const skill = join(root, "example");
  mkdirSync(skill);
  writeFileSync(join(root, "bad.json"), '{"version":1,"skills":[]} trailing');

  const result = run([
    skill,
    "--config",
    join(root, "bad.json"),
    "--format",
    "json",
  ], { cwd: "/" });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.complete, false);
  assert.deepEqual(report.results, []);
  assert.deepEqual(report.counts, { error: 0, warning: 0 });
  assert.match(report.errors[0], /invalid JSON/);
});
