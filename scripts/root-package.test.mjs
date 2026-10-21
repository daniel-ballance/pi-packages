import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("root-package.mjs", import.meta.url));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "root-package-")));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = path => JSON.parse(readFileSync(join(root, path), "utf8"));
  cpSync(script, join(root, "scripts/root-package.mjs"));
  put("package.json", {
    name: "fixture-root", private: true, workspaces: ["packages/*", "packages/b/*"],
    piBundle: ["packages/b", "packages/a"],
  });
  put("packages/a/package.json", {
    name: "a", pi: { extensions: ["./extensions/a/index.ts"], skills: ["./skills", "!./skills/private"], prompts: [], themes: [] },
  });
  put("packages/b/package.json", {
    name: "b", pi: {
      extensions: ["./extensions/b/index.ts", "./nested/extensions/nested/index.ts"],
      skills: ["./skills"], prompts: ["./prompts/**/*.md"], themes: ["./themes/**/*.json"],
    },
  });
  put("packages/b/nested/package.json", { name: "nested", pi: { extensions: ["./extensions/nested/index.ts"] } });
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/root-package.mjs"), ...args], { encoding: "utf8" });
  return { root, put, read, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the root pi block is each piBundle member's own entries, rebased onto the member, in piBundle order", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.read("package.json").pi, {
      extensions: ["./packages/b/extensions/b/index.ts", "./packages/b/nested/extensions/nested/index.ts", "./packages/a/extensions/a/index.ts"],
      skills: ["./packages/b/skills", "./packages/a/skills", "!./packages/a/skills/private"],
      prompts: ["./packages/b/prompts/**/*.md"],
      themes: ["./packages/b/themes/**/*.json"],
    });
    assert.deepEqual(f.read("package.json").piBundle, ["packages/b", "packages/a"]);
  } finally { f.cleanup(); }
});

test("--check fails without writing when a member manifest changed and the root was not regenerated", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    assert.equal(f.run("--check").status, 0);
    const member = f.read("packages/a/package.json");
    f.put("packages/a/package.json", { ...member, pi: { ...member.pi, extensions: [...member.pi.extensions, "./extensions/second/index.ts"] } });
    const before = readFileSync(join(f.root, "package.json"), "utf8");
    const stale = f.run("--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /\.\/packages\/a\/extensions\/second\/index\.ts/);
    assert.equal(readFileSync(join(f.root, "package.json"), "utf8"), before);
    assert.equal(f.run().status, 0);
    assert.equal(f.run("--check").status, 0);
  } finally { f.cleanup(); }
});

test("a member that is not a workspace, has no pi block, or uses another entry form is rejected", () => {
  const f = fixture();
  try {
    const root = f.read("package.json");
    f.put("tools/c/package.json", { name: "c", pi: { extensions: ["./index.ts"] } });
    f.put("package.json", { ...root, piBundle: ["packages/a", "tools/c"] });
    const outside = f.run();
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /tools\/c is not a workspace/);
    f.put("package.json", { ...root, piBundle: ["packages/a", "packages/b/nested"] });
    f.put("packages/b/nested/package.json", { name: "nested" });
    const bare = f.run();
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /packages\/b\/nested has no pi block/);
    f.put("package.json", root);
    f.put("packages/a/package.json", { name: "a", pi: { extensions: ["extensions/a/index.ts"] } });
    const form = f.run();
    assert.equal(form.status, 1);
    assert.match(form.stderr, /extensions\/a\/index\.ts must start with/);
    assert.equal(f.read("package.json").pi, undefined);
  } finally { f.cleanup(); }
});
