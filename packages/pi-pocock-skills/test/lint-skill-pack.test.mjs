import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the packed package runs its published bin with staged local dependencies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lint-skill-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", root],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);

  const archive = join(root, packed.stdout.trim().split(/\r?\n/).at(-1));
  const unpacked = join(root, "unpacked");
  mkdirSync(unpacked);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", unpacked], {
    encoding: "utf8",
  });
  assert.equal(extracted.status, 0, extracted.stderr);

  const packagePath = join(unpacked, "package");
  const packageJson = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
  assert.equal(packageJson.bin["lint-skill"], "scripts/lint-skill.mjs");
  for (const resource of [
    "scripts/lint-skill.mjs",
    "scripts/lint-skill-config.mjs",
    "lib/lint-skill.mjs",
    "docs/lint-skill.md",
  ]) {
    assert.equal(typeof readFileSync(join(packagePath, resource), "utf8"), "string");
  }

  // npm normally creates this link during installation. Recreate only the bin
  // link; dependencies come solely from this package's already-installed tree.
  cpSync(join(packageRoot, "node_modules"), join(packagePath, "node_modules"), { recursive: true });
  const binDirectory = join(packagePath, "node_modules", ".bin");
  mkdirSync(binDirectory, { recursive: true });
  const bin = join(binDirectory, "lint-skill");
  symlinkSync("../../scripts/lint-skill.mjs", bin);

  const fixtureRoot = join(root, "fixture");
  const skill = join(fixtureRoot, "packed-skill");
  const unrelatedCwd = join(root, "unrelated-cwd");
  mkdirSync(skill, { recursive: true });
  mkdirSync(unrelatedCwd);
  writeFileSync(join(skill, "SKILL.md"), [
    "---",
    "name: packed-skill",
    "description: A packed fixture skill.",
    "---",
    "",
    "This is a packed-package smoke fixture.",
    "",
  ].join("\n"));

  const result = spawnSync(process.execPath, [bin, skill, "--format", "json"], {
    cwd: unrelatedCwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.complete, true);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].skill, skill);
});
