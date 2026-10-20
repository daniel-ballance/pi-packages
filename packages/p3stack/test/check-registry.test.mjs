import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../generator/check-registry.mjs", import.meta.url));
const cache = "/home/danballance/.cache/p3stack-swarm/pr-07";
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

test("registry check reports emitted, dropped, and zero unclassified skills", t => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1 emitted, 0 dropped, 0 unclassified");
});

for (const [name, mutate, diagnostic] of [
  ["unclassified skill", f => f.write("vendor/demo/skills/unclassified/SKILL.md", f.skill("unclassified")), /unclassified.*skills\/unclassified\/SKILL.md/i],
  ["duplicate name", f => { f.write("vendor/demo/skills/second/SKILL.md", f.skill("second")); f.write("registry/skills.json", [...f.skills, { ...f.skills[0], path: "skills/second/SKILL.md" }]); }, /duplicate emitted name.*first/i],
  ["missing route target", f => f.write("registry/routes.json", [{ request: "broken", grant: "any", target: "absent" }]), /route.*broken.*absent/i],
  ["doubled anchor", f => f.write("skills/poteto-mode/playbooks/feature.md", "Implement the sketch.\nImplement the sketch.\n"), /chain.*first-chain.*anchor.*2/i],
  ["missing anchor", f => f.write("skills/poteto-mode/playbooks/feature.md", "Implement the revised sketch.\n"), /chain.*first-chain.*anchor.*0/i],
  ["missing chain skill", f => f.write("registry/chains.json", [{ id: "absent-chain", playbook: "playbooks/feature.md", anchor: "Implement the sketch.", position: "before", skill: "absent", when: "Always." }]), /chain.*absent-chain.*absent/i],
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
