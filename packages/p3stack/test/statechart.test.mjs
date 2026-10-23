import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import "../vendor/pstack/pstack/skills/statechart/scripts/test/statechart.test.mjs";

const upstream = new URL("../vendor/pstack/pstack/skills/statechart/scripts/", import.meta.url);
const emitted = new URL("../skills/statechart/scripts/", import.meta.url);

test("statechart runtime resources match upstream without shipping test fixtures", () => {
  const sourceFiles = readdirSync(upstream, { recursive: true }).filter(path =>
    !path.startsWith("test/") && /\.(?:mjs|cfg|tla)$/.test(path)
  ).sort();
  const outputFiles = readdirSync(emitted, { recursive: true }).filter(path =>
    /\.(?:mjs|cfg|tla|mmd)$/.test(path)
  ).sort();
  assert.deepEqual(outputFiles, sourceFiles);
  assert.ok(!readdirSync(emitted).includes("test"));
  for (const path of sourceFiles) {
    assert.deepEqual(readFileSync(new URL(path, emitted)), readFileSync(new URL(path, upstream)), path);
  }
});
