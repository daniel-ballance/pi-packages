import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const rows = () => JSON.parse(readFileSync(new URL("../registry/skills.json", import.meta.url), "utf8"));

test("registry admits 21 Pocock, 55 pstack, and five owner skills with reasons for every drop", () => {
  const skills = rows();
  for (const [source, count] of [["matt-pocock", 21], ["cursor-plugins", 55], ["owner-plugins", 5]]) {
    assert.equal(skills.filter(row => row.source === source && row.action === "emit").length, count, source);
  }
  assert.equal(skills.filter(row => row.action === "drop").length, 24);
  for (const row of skills) assert.ok(row.reason.trim(), `${row.source}/${row.path}`);
  assert.equal(skills.find(row => row.source === "matt-pocock" && row.name === "implement").invocation, "user");
  assert.equal(skills.find(row => row.name === "code-review").invocation, "model");
});
