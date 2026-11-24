import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lintAuthored } from "../generator/lint-authored.mjs";

test("authored lint flags model slugs and passes roles and capabilities", t => {
  const root = mkdtempSync(join(tmpdir(), "lint-authored-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills/x"), { recursive: true });
  writeFileSync(join(root, "skills/x/SKILL.md"), ["Use the judgment and prose role.", "Delegate per **Delegate** in the host capabilities.", "Run it on " + "claude-" + "opus-5-5."].join("\n"));
  assert.deepEqual(lintAuthored(root), [
    "skills/x/SKILL.md:3: model slug claude-opus-5-5",
  ]);
});

test("the shipped authored files pass", () => {
  assert.deepEqual(lintAuthored(new URL("../authored", import.meta.url).pathname), []);
});
