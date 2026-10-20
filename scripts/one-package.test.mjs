import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const moved = ["claude-subscription", "computer-use", "self-reload", "subagents", "todo", "web-search"];

test("p3stack owns the runtime manifest and the repository only owns workspaces", () => {
  const repository = json("package.json");
  assert.equal(repository.pi, undefined);
  assert.ok(repository.workspaces.includes("packages/p3stack/*"));
  const manifest = json("packages/p3stack/package.json");
  assert.deepEqual(manifest.pi.extensions.slice().sort(), [
    "./extensions/p3stack/index.ts",
    ...moved.map(name => `./${name}/extensions/${name}/index.ts`),
  ].sort());
  assert.deepEqual(manifest.pi.skills, ["./skills", "./subagents/skills"]);
  for (const name of moved) assert.equal(json(`packages/p3stack/${name}/package.json`).name, name);
  assert.equal(json("packages/mcp-client/package.json").name, "mcp-client");
});

test("global settings select only p3stack and project settings do not add a second identity", () => {
  assert.deepEqual(json("global/settings.json").packages, ["../../Code/pi-packages/packages/p3stack"]);
  assert.deepEqual(json(".pi/settings.json").packages ?? [], []);
});
