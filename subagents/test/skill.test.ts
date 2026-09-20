import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { parsePolicy } from "../src/policy.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skill = join(root, "skills/subagents");

test("package explicitly discovers and ships the parent skill without validation warnings", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("skills"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  const loaded = loadSkillsFromDir({ dir: join(root, "skills"), source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0].name, "subagents");
  assert.equal(loaded.skills[0].filePath, join(skill, "SKILL.md"));
});

test("every shipped example is valid whole-policy JSON with unmistakable placeholder models", () => {
  const examples = readdirSync(join(skill, "examples")).filter(name => name.endsWith(".json"));
  assert.equal(examples.length, 4);
  for (const name of examples) {
    const value = JSON.parse(readFileSync(join(skill, "examples", name), "utf8"));
    const policy = parsePolicy(value);
    for (const model of policy.models) assert.match(model.id, /^example-/);
    if (name === "disabled.subagents.json") assert.equal(policy.models.length, 0);
    else for (const field of ["tools", "extensions", "skills", "promptTemplates", "themes", "systemPrompt", "appendSystemPrompt", "contextFiles", "maxChildren", "workingDirectories"]) assert.ok(field in value);
  }
});

test("skill and reference relative links resolve inside the shipped package", () => {
  const docs = [join(skill, "SKILL.md"), ...readdirSync(join(skill, "reference")).filter(n => n.endsWith(".md")).map(n => join(skill, "reference", n))];
  for (const doc of docs) {
    for (const match of readFileSync(doc, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      const target = resolve(dirname(doc), match[1].split("#")[0]);
      assert.ok(target.startsWith(root + "/"), `${doc}: outside package: ${target}`);
      assert.ok(existsSync(target), `${doc}: missing link: ${target}`);
    }
  }
});
