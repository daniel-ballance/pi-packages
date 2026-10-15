import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./sync-shared.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-shared-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "shared"));
  copyFileSync(script, join(root, "scripts/sync-shared.mjs"));
  writeFileSync(join(root, "shared/host.ts"), "export const host = 1;\n");
  writeFileSync(join(root, "shared/copies.json"), JSON.stringify({ "host.ts": ["packages/a/src/host.ts", "packages/b/src/host.ts"] }));
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/sync-shared.mjs"), ...args], { encoding: "utf8" });
  return { root, run, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("sync writes a marked copy of each shared file into every consuming package", () => {
  const { root, run, dispose } = fixture();
  try {
    assert.equal(run().status, 0);
    for (const target of ["packages/a/src/host.ts", "packages/b/src/host.ts"]) {
      const text = readFileSync(join(root, target), "utf8");
      assert.match(text, /^\/\/ Generated from shared\/host\.ts by scripts\/sync-shared\.mjs\. Do not edit\.\n/);
      assert.ok(text.endsWith("export const host = 1;\n"));
    }
    assert.equal(run("--check").status, 0, "a fresh sync has no drift");
  } finally { dispose(); }
});

test("check fails and names every copy that was hand-edited or is missing", () => {
  const { root, run, dispose } = fixture();
  try {
    run();
    writeFileSync(join(root, "packages/a/src/host.ts"), "edited\n");
    rmSync(join(root, "packages/b/src/host.ts"));
    const result = run("--check");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/a\/src\/host\.ts/);
    assert.match(result.stderr, /packages\/b\/src\/host\.ts/);
    assert.equal(readFileSync(join(root, "packages/a/src/host.ts"), "utf8"), "edited\n", "check never writes");
  } finally { dispose(); }
});

test("a copy of an unknown shared file is rejected", () => {
  const { root, run, dispose } = fixture();
  try {
    writeFileSync(join(root, "shared/copies.json"), JSON.stringify({ "missing.ts": ["packages/a/src/missing.ts"] }));
    mkdirSync(dirname(join(root, "packages/a/src/x")), { recursive: true });
    const result = run("--check");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shared\/missing\.ts/);
  } finally { dispose(); }
});
