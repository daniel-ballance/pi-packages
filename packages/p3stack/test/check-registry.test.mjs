import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generate } from "../generator/generate.mjs";
import { sourcePathClassifier } from "../generator/source-paths.mjs";

const cli = fileURLToPath(new URL("../generator/check-registry.mjs", import.meta.url));
const cache = process.env.P3STACK_FIXTURE_ROOT ?? tmpdir();
const rows = () => JSON.parse(readFileSync(new URL("../registry/skills.json", import.meta.url), "utf8"));

test("every borrowed upstream idea names an existing upstream path and existing p3stack files", () => {
  const borrowed = JSON.parse(readFileSync(new URL("../rules/borrowed.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../rules/manifest.json", import.meta.url), "utf8"));
  assert.ok(borrowed.length > 0);
  for (const row of borrowed) {
    const source = manifest.sources.find(({ name }) => name === row.source);
    assert.ok(source, row.source);
    assert.ok(existsSync(new URL(`../${source.vendor}/${row.path}`, import.meta.url)), `${row.source}/${row.path}`);
    for (const file of row.by) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
    assert.ok(row.idea.trim(), row.path);
  }
});

test("a changed borrowed upstream path is flagged for review in a bump", async () => {
  const { borrowedNote } = await import("../generator/source-paths.mjs");
  const borrowed = [{ source: "superpowers", path: "skills/a/SKILL.md", by: ["authored/x.md"], idea: "y" }];
  assert.match(borrowedNote(borrowed, "superpowers", "skills/a/SKILL.md"), /borrowed by authored\/x\.md: review/);
  assert.equal(borrowedNote(borrowed, "superpowers", "skills/b/SKILL.md"), "");
  assert.equal(borrowedNote(borrowed, "agent-skills", "skills/a/SKILL.md"), "");
});

test("registry admissions match the shipped skills, including narrow and watch-only sources", () => {
  const skills = rows(), admitted = skills.filter(row => row.action === "emit");
  const shipped = readdirSync(new URL("../skills/", import.meta.url), { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.deepEqual(new Set(admitted.map(row => row.name)), new Set(shipped.map(entry => entry.name)));
  const from = source => new Set(admitted.filter(row => row.source === source).map(row => row.name));
  assert.deepEqual(from("agent-skills"), new Set(["constraints", "source-grounding", "security-hardening", "instrumentation"]));
  assert.deepEqual(from("superpowers"), new Set(), "superpowers is watch only");
  assert.equal(skills.find(row => row.source === "matt-pocock" && row.path === "skills/in-progress/software-factory/SKILL.md").action, "drop");
  for (const row of skills) assert.ok(row.reason.trim(), `${row.source}/${row.path}`);
  assert.equal(skills.find(row => row.source === "matt-pocock" && row.name === "implement").invocation, "user");
  assert.equal(skills.find(row => row.name === "code-review").invocation, "model");
  assert.equal(skills.find(row => row.name === "interactive-prototype").invocation, "model");
});

function fixture(t) {
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof text === "string" ? text : JSON.stringify(text));
  };
  const skill = name => `---\nname: ${name}\ndescription: A fixture skill.\n---\n\n# Fixture\n`;
  write("rules/manifest.json", { registry: true, sources: [{ name: "demo", vendor: "vendor/demo", map: [{ from: "skills/", to: "skills/" }] }] });
  write("vendor/demo/skills/first/SKILL.md", skill("first"));
  write("skills/first/SKILL.md", skill("first"));
  const skills = [{ source: "demo", path: "skills/first/SKILL.md", action: "emit", name: "first", invocation: "model", phases: ["test"], roles: ["owner"], reason: "Fixture admission." }];
  write("registry/skills.json", skills);
  write("registry/routes.json", [{ request: "test", grant: "any", target: "first" }]);
  write("registry/chains.json", [{ id: "first-chain", playbook: "playbooks/feature.md", anchor: "Implement the sketch.", position: "before", skill: "first", when: "Always." }]);
  write("skills/poteto-mode/playbooks/feature.md", "# Feature\n\nImplement the sketch.\n");
  const run = () => spawnSync(process.execPath, [cli], { encoding: "utf8", env: { ...process.env, P3STACK_PACKAGE_DIR: root } });
  return { root, write, skills, skill, run };
}

test("registry admits authored p3stack skills at their emitted paths", t => {
  const f = fixture(t);
  f.write("authored/skills/release/SKILL.md", f.skill("release"));
  f.write("skills/release/SKILL.md", f.skill("release"));
  f.write("registry/skills.json", [...f.skills, { ...f.skills[0], source: "p3stack", path: "skills/release/SKILL.md", name: "release" }]);
  f.write("registry/routes.json", [{ request: "release", grant: "any", target: "release" }]);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "2 emitted, 0 dropped, 0 unclassified");
});

test("registry discovers authored skill templates and requires their registry rows", t => {
  const f = fixture(t);
  f.write("authored/skills/router/SKILL.md.tmpl", f.skill("router"));
  assert.match(f.run().stderr, /Unclassified skill p3stack\/skills\/router\/SKILL\.md/);
  f.write("skills/router/SKILL.md", f.skill("router"));
  f.write("registry/skills.json", [...f.skills, { ...f.skills[0], source: "p3stack", path: "skills/router/SKILL.md", name: "router" }]);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test("registry rejects an authored row whose file is missing", t => {
  const f = fixture(t);
  f.write("skills/release/SKILL.md", f.skill("release"));
  f.write("registry/skills.json", [...f.skills, { ...f.skills[0], source: "p3stack", path: "skills/release/SKILL.md", name: "release" }]);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Missing authored skill authored\/skills\/release\/SKILL\.md/);
});

test("registry requires coverage and exact emitted paths for authored skills", t => {
  const f = fixture(t);
  f.write("authored/skills/release/SKILL.md", f.skill("release"));
  assert.match(f.run().stderr, /Unclassified skill p3stack\/skills\/release\/SKILL\.md/);
  f.write("registry/skills.json", [...f.skills, { ...f.skills[0], source: "p3stack", path: "skills/release/SKILL.md", name: "renamed" }]);
  assert.match(f.run().stderr, /Authored skill.*release.*must emit at skills\/release\/SKILL\.md/);
});

test("generation copies registered authored skills and validates their invocation", t => {
  const f = fixture(t);
  f.write("authored/skills/release/SKILL.md", f.skill("release"));
  f.write("registry/skills.json", [...f.skills, { ...f.skills[0], source: "p3stack", path: "skills/release/SKILL.md", name: "release" }]);
  f.write("registry/chains.json", []);
  const outDir = join(f.root, "out");
  generate({ packageDir: f.root, outDir });
  assert.equal(readFileSync(join(outDir, "skills/release/SKILL.md"), "utf8"), f.skill("release"));
  f.write("authored/skills/release/SKILL.md", f.skill("release").replace("name: release", "name: release\ndisable-model-invocation: true"));
  assert.throws(() => generate({ packageDir: f.root, outDir }), /release\/SKILL.md has a different invocation/);
});

const example = "\n```yaml\n---\nname: first\ndescription: Example, not metadata.\ndisable-model-invocation: true\n---\n```\n";

for (const [field, header] of [
  ["name", "description: Real description."],
  ["description", "name: first"],
  ["invocation", "name: first\ndescription: Real description."],
]) {
  test(`a fenced example cannot supply the registered ${field}`, t => {
    const f = fixture(t);
    if (field === "invocation") f.write("registry/skills.json", [{ ...f.skills[0], invocation: "user" }]);
    const body = field === "invocation" ? example : example.replace("disable-model-invocation: true\n", "");
    f.write("skills/first/SKILL.md", `---\n${header}\n---\n${body}`);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`first/SKILL.md.*${field}`));
  });
}

test("registry accepts quoted and folded frontmatter fields without reading the fenced example", t => {
  const f = fixture(t);
  f.write("skills/first/SKILL.md", "---\nname: 'first' # literal name\ndescription: >-\n  A folded\n  description.\n---\n" + example);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const invocation of ["model", "user"]) {
  test(`generation sets ${invocation} invocation only in frontmatter and preserves the body bytes`, t => {
    const f = fixture(t), path = "skills/first/SKILL.md";
    const fields = "name: first\ndescription: First.\n";
    const header = invocation === "model" ? fields + "disable-model-invocation: true\n" : fields;
    f.write(`vendor/demo/${path}`, (`---\n${header}---\n` + example).replaceAll("\n", "\r\n"));
    f.write("registry/skills.json", [{ ...f.skills[0], invocation }]);
    f.write("registry/chains.json", []);
    const outDir = join(f.root, "out");
    generate({ packageDir: f.root, outDir });
    const text = readFileSync(join(outDir, path), "utf8");
    assert.ok(text.endsWith(example.replaceAll("\n", "\r\n")), "the example should be byte-identical");
    assert.equal(/^disable-model-invocation: true\r?$/m.test(text.slice(0, text.indexOf("\r\n---\r\n"))), invocation === "user");
  });
}

const featurePath = "skills/poteto-mode/playbooks/feature.md";

test("chains surround the whole step, in registry order, without renumbering its neighbors", t => {
  const f = fixture(t), outDir = join(f.root, "out");
  const step = "2. Implement the sketch. Keep this sentence.\n\n   - Keep the nested list.\n\n   Keep this paragraph too.";
  f.write(`extra/${featurePath}`, `1. Design.\n${step}\n3. Ship.\n`);
  const rows = ["before", "after", "before", "after"].map((position, i) => ({
    id: `chain-${i}`, playbook: "playbooks/feature.md", anchor: "Implement the sketch.", position, skill: "first", when: `Condition ${i}.`,
  }));
  f.write("registry/chains.json", rows);
  generate({ packageDir: f.root, outDir });
  const playbook = readFileSync(join(outDir, featurePath), "utf8");
  const tokens = ["1. Design.", "Condition 0.", "Condition 2.", step, "Condition 1.", "Condition 3.", "3. Ship."];
  let start = 0;
  for (const token of tokens) {
    const offset = playbook.indexOf(token, start);
    assert.notEqual(offset, -1, token);
    start = offset + token.length;
  }
  for (const { when } of rows) {
    const lines = playbook.split("\n").filter(line => line.includes(when));
    assert.equal(lines.length, 1, when);
    assert.match(lines[0], /p3stack.*\]\(\.\.\/first\/SKILL\.md\)/i);
  }
});

for (const [location, text] of [
  ["another step's sentence", "1. Hold here: Implement the sketch.\n"],
  ["a continuation paragraph", "1. Review first.\n\n   Implement the sketch.\n"],
  ["a nested step", "1. Review first.\n   - Implement the sketch.\n"],
  ["a fenced example", "```\nImplement the sketch.\n```\n"],
]) {
  test(`generation rejects a chain anchor inside ${location}`, t => {
    const f = fixture(t);
    f.write(`extra/${featurePath}`, text);
    assert.throws(() => generate({ packageDir: f.root, outDir: join(f.root, "out") }), /first-chain.*anchor.*step.*feature\.md/i);
  });
}

test("routes may use the same request under distinct grants", t => {
  const f = fixture(t);
  f.write("registry/routes.json", ["default", "full-autonomy"].map(grant => ({ request: "plan", grant, target: "first" })));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test("an authored file cannot be silently overwritten by the rendered router", t => {
  const f = fixture(t), path = "skills/p3stack-mode/SKILL.md";
  f.write(`authored/${path}`, f.skill("p3stack-mode"));
  f.write(`authored/${path}.tmpl`, f.skill("p3stack-mode") + "{{routes}}\n");
  f.write("registry/skills.json", [...f.skills, { ...f.skills[0], source: "p3stack", path, name: "p3stack-mode" }]);
  f.write("registry/chains.json", []);
  assert.throws(() => generate({ packageDir: f.root, outDir: join(f.root, "out") }), /SKILL\.md:.*authored.*registry/);
});

test("registry admits an explicit router playbook target and rejects a missing one", t => {
  const f = fixture(t);
  f.write("registry/routes.json", [{ request: "onboard", grant: "any", target: "p3stack-mode/playbooks/onboard-brownfield.md" }]);
  f.write("skills/p3stack-mode/playbooks/onboard-brownfield.md", "# Onboard\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  rmSync(join(f.root, "skills/p3stack-mode/playbooks/onboard-brownfield.md"));
  assert.match(f.run().stderr, /Route onboard has missing target p3stack-mode\/playbooks\/onboard-brownfield\.md/);
});

test("route and chain registries contain the admitted owner and TDD routes", () => {
  const read = name => JSON.parse(readFileSync(new URL(`../registry/${name}.json`, import.meta.url), "utf8"));
  const routes = read("routes"), chains = read("chains");
  for (const name of ["triage", "dyl-review", "implement-spec"]) assert.ok(routes.some(row => row.target === name), name);
  assert.ok(chains.some(row => row.skill === "tdd" && row.playbook === "playbooks/feature.md"));
  assert.ok(chains.some(row => row.skill === "diagnosing-bugs" && row.playbook === "playbooks/bug-fix.md"));
  const rules = JSON.parse(readFileSync(new URL("../rules/tokens.json", import.meta.url), "utf8"));
  for (const id of ["tracker-precondition", "tracker-spec-source", "tracker-ticket"]) assert.ok(!rules.some(row => row.id === id), id);
});

test("scope reports distinguish registry drops and unclassified skills", () => {
  const classify = sourcePathClassifier({ name: "demo", map: [{ from: "skills/", to: "skills/" }] }, [
    { source: "demo", path: "skills/first/SKILL.md", action: "emit", name: "renamed" },
    { source: "demo", path: "skills/dropped/SKILL.md", action: "drop" },
  ]);
  assert.deepEqual(classify("skills/first/resource.md"), { kind: "emitted", output: "skills/renamed/resource.md" });
  assert.deepEqual(classify("skills/dropped/resource.md"), { kind: "dropped" });
  assert.deepEqual(classify("skills/new/SKILL.md"), { kind: "unclassified" });
});

test("generation uses registry drops, renamed directories, and invocation", t => {
  const f = fixture(t);
  f.write("vendor/demo/skills/dropped/SKILL.md", f.skill("dropped"));
  f.write("vendor/demo/skills/dropped/private.md", "Do not emit this resource.\n");
  f.write("registry/skills.json", [
    { ...f.skills[0], name: "renamed", invocation: "user" },
    { source: "demo", path: "skills/dropped/SKILL.md", action: "drop", reason: "Not admitted." },
  ]);
  f.write("registry/routes.json", []);
  f.write("registry/chains.json", []);
  f.write("rules/tokens.json", [{ id: "rename", min: 1, find: "name: first", replace: "name: renamed", files: "^skills/renamed/SKILL.md$" }]);
  const outDir = join(f.root, "out");
  generate({ packageDir: f.root, outDir });
  assert.match(readFileSync(join(outDir, "skills/renamed/SKILL.md"), "utf8"), /disable-model-invocation: true/);
  assert.equal(existsSync(join(outDir, "skills/first")), false);
  assert.equal(existsSync(join(outDir, "skills/dropped")), false);
});

test("generation refuses an unclassified upstream skill before writing", t => {
  const f = fixture(t);
  f.write("vendor/demo/skills/new/SKILL.md", f.skill("new"));
  const outDir = join(f.root, "out");
  assert.throws(() => generate({ packageDir: f.root, outDir }), /Unclassified.*skills\/new\/SKILL.md/);
  assert.equal(existsSync(outDir), false);
});

test("pstack regression-test and Pocock tdd keep their distinct procedures", () => {
  const read = path => readFileSync(new URL(`../skills/${path}`, import.meta.url), "utf8");
  assert.match(read("regression-test/SKILL.md"), /^name: regression-test$/m);
  assert.match(read("regression-test/SKILL.md"), /# TDD Bug Fix/);
  assert.match(read("tdd/SKILL.md"), /confirm.*user|confirmed seam/i);
  for (const path of ["poteto-help/SKILL.md", "poteto-help/references/recipes.md", "poteto-mode/playbooks/bug-fix.md"]) {
    assert.match(read(path), /regression-test/);
    assert.doesNotMatch(read(path), /(?:\/tdd|\/skill:tdd)\b/);
  }
});

test("statechart stays user-invoked and its help link resolves", () => {
  const row = rows().find(row => row.source === "cursor-plugins" && row.path === "skills/statechart/SKILL.md");
  assert.equal(row.action, "emit");
  assert.equal(row.name, "statechart");
  assert.equal(row.invocation, "user");
  const skill = readFileSync(new URL("../skills/statechart/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /\/skill:statechart/);
  assert.match(skill, /Keep the entire output tree disposable, including `tlc\/`/);
  assert.match(skill, /Publication can delete unknown nested files/);
  assert.match(skill, /Set `TLA2TOOLS` to an absolute jar path/);
  assert.match(skill, /`JAVA` to an absolute executable path/);
  assert.match(skill, /View modules execute as code, so use only trusted views/);
  const render = readFileSync(new URL("../skills/statechart/references/render.md", import.meta.url), "utf8");
  assert.match(render, /Before fetching or executing the pinned Pele package, get explicit permission/);
  assert.match(skill, /Get explicit permission before any provisioning/);
  assert.match(skill, /require an existing TLC jar and Java binary/);
  assert.match(render, /provide Mermaid text and report rendering as blocked/);
  const help = readFileSync(new URL("../skills/poteto-help/SKILL.md", import.meta.url), "utf8");
  assert.match(help, /\[`\/skill:statechart`\]\(\.\.\/statechart\/SKILL\.md\)/);
});

test("ketchup-video stays user-invoked and links to ketchup", () => {
  const row = rows().find(row => row.source === "cursor-plugins" && row.path === "skills/ketchup-video/SKILL.md");
  assert.equal(row.action, "emit");
  assert.equal(row.invocation, "user");
  const skill = readFileSync(new URL("../skills/ketchup-video/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /\[.*\/skill:ketchup.*\]\(\.\.\/ketchup\/SKILL\.md\)/);
  const help = readFileSync(new URL("../skills/poteto-help/SKILL.md", import.meta.url), "utf8");
  assert.match(help, /\[.*\/skill:ketchup-video.*\]\(\.\.\/ketchup-video\/SKILL\.md\)/);
});

test("registry check reports emitted, dropped, and zero unclassified skills", t => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1 emitted, 0 dropped, 0 unclassified");
});

for (const [name, mutate, diagnostic] of [
  ["unclassified skill", f => f.write("vendor/demo/skills/unclassified/SKILL.md", f.skill("unclassified")), /unclassified.*skills\/unclassified\/SKILL.md/i],
  ["duplicate name", f => { f.write("vendor/demo/skills/second/SKILL.md", f.skill("second")); f.write("registry/skills.json", [...f.skills, { ...f.skills[0], path: "skills/second/SKILL.md" }]); }, /duplicate emitted name.*first/i],
  ["invalid route grant", f => f.write("registry/routes.json", [{ request: "build", grant: "maybe", target: "first" }]), /route.*build.*grant.*maybe/i],
  ["duplicate route key", f => f.write("registry/routes.json", ["first", "playbooks/feature.md"].map(target => ({ request: "build", grant: "default", target }))), /duplicate route.*build.*default/i],
  ["duplicate chain id", f => {
    const chain = JSON.parse(readFileSync(join(f.root, "registry/chains.json"), "utf8"))[0];
    f.write("registry/chains.json", [chain, { ...chain, position: "after" }]);
  }, /duplicate chain.*first-chain/i],
  ["missing route target", f => f.write("registry/routes.json", [{ request: "broken", grant: "any", target: "absent" }]), /route.*broken.*absent/i],
  ["doubled anchor", f => f.write("skills/poteto-mode/playbooks/feature.md", "Implement the sketch.\nImplement the sketch.\n"), /chain.*first-chain.*anchor.*2/i],
  ["missing anchor", f => f.write("skills/poteto-mode/playbooks/feature.md", "Implement the revised sketch.\n"), /chain.*first-chain.*anchor.*0/i],
  ["missing chain skill", f => f.write("registry/chains.json", [{ id: "absent-chain", playbook: "playbooks/feature.md", anchor: "Implement the sketch.", position: "before", skill: "absent", when: "Always." }]), /chain.*absent-chain.*absent/i],
  ["duplicate generated name", f => f.write("skills/extra/SKILL.md", f.skill("first")), /duplicate emitted name.*first/i],
  ["unregistered generated skill", f => f.write("skills/extra/SKILL.md", f.skill("extra")), /unregistered emitted skill.*skills\/extra\/SKILL.md/i],
  ["chain outside a playbook", f => {
    f.write("skills/poteto-mode/not-a-playbook.md", "Implement the sketch.\n");
    f.write("registry/chains.json", [{ id: "outside-chain", playbook: "not-a-playbook.md", anchor: "Implement the sketch.", position: "before", skill: "first", when: "Always." }]);
  }, /chain.*outside-chain.*playbook/i],
  ["duplicate upstream row", f => f.write("registry/skills.json", [...f.skills, f.skills[0]]), /duplicate.*row.*skills\/first\/SKILL.md/i],
  ["stale upstream row", f => f.write("registry/skills.json", [...f.skills, { ...f.skills[0], path: "skills/gone/SKILL.md", name: "gone" }]), /stale.*skills\/gone\/SKILL.md/i],
]) {
  test(`registry rejects ${name} by name`, t => {
    const f = fixture(t);
    mutate(f);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, diagnostic);
  });
}
