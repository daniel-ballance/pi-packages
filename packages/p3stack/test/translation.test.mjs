import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../generator/generate.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(pkg, path), "utf8");
const rules = name => JSON.parse(read(`rules/${name}.json`));

// Exercise the shipping rewrites in order. Only the whole pin, not a single
// example, is required to meet their aggregate match counts.
function translate(t, source, files) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-translation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  };
  for (const [path, contents] of Object.entries(files)) write("vendor/" + path, contents);
  const map = ["skills/", "agents/"].map(path => ({ from: path, to: path }));
  write("rules/manifest.json", JSON.stringify({ sources: [{ name: source, vendor: "vendor", map }] }));
  write("rules/tokens.json", JSON.stringify(rules("tokens")
    .filter(rule => !rule.source || rule.source === source).map(rule => ({ ...rule, min: 0 }))));
  write("rules/sections.json", JSON.stringify(rules("sections").filter(rule => Object.hasOwn(files, rule.file))));
  symlinkSync(join(pkg, "overlays"), join(root, "overlays"), "dir");
  write("rules/lint.json", JSON.stringify({ deny: rules("lint").deny }));
  const outDir = join(root, "out");
  generate({ packageDir: root, outDir });
  return path => readFileSync(join(outDir, path), "utf8");
}

for (const name of ["AskQuestion", "create-skill"]) {
  test(`an uncatalogued use of ${name} needs a translation, not a catch-all substitution`, t => {
    const path = "skills/example/SKILL.md";
    assert.throws(() => translate(t, "cursor-plugins", { [path]: `Call \`${name}\` with these arguments.\n` }),
      error => error.message.includes(`${path}:1: ${name}`));
  });
}
