import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { instantiate, placeholders } from "../skills/p3stack-mode/scripts/workflow-template.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "../skills/p3stack-mode/workflows");
const scripts = join(templates, "../scripts");
const doc = () => readFileSync(join(templates, "README.md"), "utf8");
const template = (name, values = {}) => {
  const source = readFileSync(join(templates, `${name}.json`), "utf8");
  return instantiate(source, Object.fromEntries(placeholders(source).map(key => [key, values[key] ?? sample(key)])));
};
function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), "workflow-templates-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
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

test("a repro that checks only a directory exists exits 0 even with correct code; interrogate collects, not verifies", t => {
  const root = scratch(t);
  writeFileSync(join(root, "repro.sh"), 'test -d "$PWD"\n');
  for (const body of ["return 2 + 2", "return 5"]) {
    writeFileSync(join(root, "add.js"), `function addTwoAndTwo() { ${body}; }\n`);
    assert.equal(spawnSync("bash", ["repro.sh"], { cwd: root }).status, 0);
  }
  const steps = template("interrogate").steps;
  assert.ok(steps.every(step => step.kind === "task" && !step.worker.tools.includes("bash")));
  const collector = steps.at(-1);
  assert.deepEqual(collector.dependsOn, steps.slice(0, -1).map(s => s.id));
  assert.match(collector.instructions, /finding\.md.*repro\.sh|repro\.sh.*finding\.md/);
  assert.match(doc(), /disposable checkout/i);
  for (const state of ["verified", "contradicted", "could not run"]) assert.ok(doc().includes(state));
});

test("the skill variants get neutral assignments on one model; grading behavior requires transcripts", () => {
  const { name, steps: [left, right, grade] } = template("skill-eval", { name: "workspace", prompt: "Build the widget.", cwd: "/src", base: "0123456" });
  for (const s of [left, right]) assert.doesNotMatch(`${name} ${s.id} ${s.instructions}`, /candidate|eval|rubric|grader|variant/i);
  assert.equal(left.instructions, right.instructions);
  assert.equal(left.worker.model, right.worker.model);
  assert.notDeepEqual(left.worker.skills, right.worker.skills);
  assert.deepEqual(grade.dependsOn, [left.id, right.id]);
  assert.match(grade.instructions, /transcript/i);
  assert.match(grade.instructions, /null/);
  assert.doesNotMatch(doc(), /two blinded candidates/i);
});

test("the handoff patch reconstructs committed, staged, unstaged, deleted and untracked files", t => {
  const root = scratch(t), work = join(root, "work");
  mkdirSync(work);
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@example.org");
  for (const path of ["one", "two", "three", "gone"]) writeFileSync(join(work, path), "initial\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(work, "one"), "committed\n"); git("commit", "-qam", "one");
  writeFileSync(join(work, "two"), "staged\n"); git("add", "two");
  writeFileSync(join(work, "three"), "unstaged\n"); unlinkSync(join(work, "gone"));
  writeFileSync(join(work, "new asset"), Buffer.from([0, 42, 255]));
  const command = template("skill-eval", { base }).steps[0].instructions.match(/`(git add [^`]+)`/)?.[1];
  assert.ok(command, "handoff command in the brief");
  const run = spawnSync("bash", ["-c", command], { cwd: work, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  git("reset", "--hard", base); git("apply", "--index", join(root, "changes.diff"));
  assert.equal(git("diff", "--cached", "--name-status").trim(), "D\tgone\nA\tnew asset\nM\tone\nM\tthree\nM\ttwo");
  assert.deepEqual(readFileSync(join(work, "new asset")), Buffer.from([0, 42, 255]));
});

test("the hillclimb loop depends on an independent equality check of the submitted seed", t => {
  const root = scratch(t), seed = join(root, "seed"), artifact = join(root, "artifact");
  for (const p of [seed, artifact]) { mkdirSync(p); writeFileSync(join(p, "a file"), "base\n"); }
  writeFileSync(join(artifact, "response.md"), "Worker reply added by the runtime\n");
  const hashTool = join(scripts, "seed-hash.mjs");
  const seedHash = execFileSync(process.execPath, [hashTool, seed], { encoding: "utf8" }).trim();
  const { steps } = template("hillclimb", { seedHash, hashTool: `'${hashTool}'` });
  const loop = steps.find(s => s.kind === "loop"), gate = steps.find(s => s.id === loop.seed);
  assert.equal(gate.kind, "check");
  assert.equal(gate.input, steps[0].id);
  const run = () => spawnSync("bash", ["-c", gate.validator.command], { cwd: root, env: { ...process.env, WORKFLOW_CANDIDATE: artifact } });
  assert.equal(run().status, 0);
  writeFileSync(join(artifact, "a file"), "edit\n"); assert.notEqual(run().status, 0);
  writeFileSync(join(artifact, "a file"), "base\n"); writeFileSync(join(artifact, "extra"), "surprise"); assert.notEqual(run().status, 0);
  assert.match(doc(), /WORKFLOW_CANDIDATE/);
  assert.match(doc(), /finite.*score|score.*finite/i);
});

test("arena's reviewer receives the design handoff, not the picker's decision record", () => {
  const steps = template("arena").steps;
  const review = steps.find(s => s.kind === "check" && s.validator.kind === "agent");
  const submission = steps.find(s => s.id === review.input);
  assert.match(submission.instructions, /design\.md/);
  assert.doesNotMatch(submission.instructions, /write[^.]*decision\.md/i);
  assert.ok(steps.some(s => s !== submission && /decision\.md/i.test(s.instructions)));
  assert.doesNotMatch(review.validator.instructions, /ignore decision/i);
});

test("--out creates missing run directories", t => {
  const path = join(scratch(t), "runs", "run id", "workflow.json"), name = join(templates, "interrogate.json");
  const settings = placeholders(readFileSync(name, "utf8")).flatMap(key => ["--set", `${key}=${sample(key)}`]);
  const run = spawnSync(process.execPath, [join(scripts, "workflow-template.mjs"), name, ...settings, "--out", path], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), template("interrogate"));
});
