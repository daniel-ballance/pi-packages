import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { instantiate, placeholders } from "../authored/skills/p3stack-mode/scripts/workflow-template.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "../authored/skills/p3stack-mode/workflows");
const subagents = join(here, "../subagents");
const definition = pathToFileURL(join(subagents, "extensions/subagents/src/workflow-definition.ts")).href;
const numbers = { timeoutSeconds: "900", maxAttempts: "20", minImprovement: "0.01", iterations: "5" };
const sample = name => numbers[name] ?? (name === "direction" ? "min" : name === "cwd" ? "/tmp/project" : `sample ${name} with "quotes" and \\ slashes`);

function parseWithEngine(value) {
  const program = `import(${JSON.stringify(definition)}).then(m => { m.parseWorkflow(JSON.parse(process.argv[1])); console.log("ok"); }).catch(e => { console.error(e.message); process.exit(1); })`;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, JSON.stringify(value)], { cwd: subagents, encoding: "utf8" });
}

for (const file of readdirSync(templates).filter(name => name.endsWith(".json"))) {
  test(`${file} instantiates and passes the subagents workflow parser`, () => {
    const template = readFileSync(join(templates, file), "utf8");
    JSON.parse(template);
    const names = placeholders(template);
    assert.ok(names.includes("cwd") && names.includes("name"), names.join(", "));
    const value = instantiate(template, Object.fromEntries(names.map(name => [name, sample(name)])));
    assert.doesNotMatch(JSON.stringify(value), /\{\{/);
    assert.equal(typeof value.limits.timeoutSeconds, "number");
    const parsed = parseWithEngine(value);
    assert.equal(parsed.status, 0, parsed.stderr);
  });
}

test("instantiate rejects unfilled, unknown, and non-numeric placeholders and escapes text", () => {
  const template = '{ "a": "{{x}}", "n": "{{count:number}}" }';
  assert.throws(() => instantiate(template, { x: "1" }), /Unfilled placeholders: count/);
  assert.throws(() => instantiate(template, { x: "1", count: "2", extra: "3" }), /Unknown placeholders: extra/);
  assert.throws(() => instantiate(template, { x: "1", count: "lots" }), /count must be a number/);
  assert.deepEqual(instantiate(template, { x: 'say "hi"\n', count: "2" }), { a: 'say "hi"\n', n: 2 });
});

test("the interrogate rerun check keeps only findings whose repro observes the failure", () => {
  const template = JSON.parse(readFileSync(join(templates, "interrogate.json"), "utf8"));
  const command = template.steps.find(step => step.id === "rerun").validator.command;
  assert.match(command, /timeout 300 bash "\$d\/repro\.sh"/);
  assert.match(command, /proven:%s; not reproduced:%s/);
  const root = mkdtempSync(join(tmpdir(), "interrogate-")), candidate = join(root, "candidate");
  try {
    for (const [name, exit] of [["a-1", 0], ["b-1", 1]]) {
      mkdirSync(join(candidate, "findings", name), { recursive: true });
      writeFileSync(join(candidate, "findings", name, "repro.sh"), `test -d "${root}" && exit ${exit}\n`);
    }
    const filled = instantiate(readFileSync(join(templates, "interrogate.json"), "utf8"), Object.fromEntries(placeholders(readFileSync(join(templates, "interrogate.json"), "utf8")).map(name => [name, name === "cwd" ? root : sample(name)])));
    const run = spawnSync("bash", ["-c", filled.steps.find(step => step.id === "rerun").validator.command], { cwd: root, encoding: "utf8", env: { ...process.env, WORKFLOW_CANDIDATE: candidate } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), { verdict: "pass", findings: "proven: a-1; not reproduced: b-1" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
