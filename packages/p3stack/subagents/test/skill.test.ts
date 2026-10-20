import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLICY, parsePolicy } from "../extensions/subagents/src/policy.js";
import { parseWorkflow } from "../extensions/subagents/src/workflow-definition.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skill = join(root, "skills/subagents");

test("package explicitly discovers and ships the parent skill without validation warnings", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("skills"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  const loaded = loadSkillsFromDir({ dir: join(root, "skills"), source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map(s => s.name).sort(), ["subagents", "workflows"]);
  assert.equal(loaded.skills.find(s => s.name === "subagents")?.filePath, join(skill, "SKILL.md"));
});

test("documented execution fallback matches the complete shipped policy", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const example = readme.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(example, "README must document the default policy");
  assert.deepEqual(parsePolicy(JSON.parse(example[1])), parsePolicy(DEFAULT_POLICY));
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

test("shipped workflow examples are valid definitions, with explicit placeholder models", () => {
  const directory = join(root, "skills/workflows/examples");
  for (const file of readdirSync(directory)) {
    const def = parseWorkflow(JSON.parse(readFileSync(join(directory, file), "utf8")));
    for (const step of def.steps) if (step.kind !== "check") assert.match(step.worker.model, /^example-provider\//);
  }
});

test("skill and reference relative links resolve inside the shipped package", () => {
  const docs = [join(root, "README.md"), join(root, "skills/workflows/SKILL.md"), join(root, "WORKFLOWS.md"), join(skill, "SKILL.md"), ...readdirSync(join(skill, "reference")).filter(n => n.endsWith(".md")).map(n => join(skill, "reference", n))];
  for (const doc of docs) {
    for (const match of readFileSync(doc, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      // Pi resolves every skill resource link from its SKILL.md directory,
      // including links in nested references. Package docs use Markdown paths.
      const base = doc.startsWith(skill + "/") ? skill : dirname(doc);
      const target = resolve(base, match[1].split("#")[0]);
      assert.ok(target.startsWith(root + "/"), `${doc}: outside package: ${target}`);
      assert.ok(existsSync(target), `${doc}: missing link: ${target}`);
    }
  }
});
