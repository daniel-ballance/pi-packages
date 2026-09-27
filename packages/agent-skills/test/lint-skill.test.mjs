import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, symlink, unlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lintSkill } from "../lib/lint-skill.mjs";

async function fixture(t, files, name = "example") {
  const root = await mkdtemp(path.join(tmpdir(), "lint-skill-"));
  const skill = path.join(root, name);
  await mkdir(skill, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(skill, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return { root, skill };
}

const valid = (body = "Instructions\n") =>
  `---\nname: example\ndescription: A useful skill.\n---\n${body}`;

function rule(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId);
}

function dependency(report, target) {
  return report.dependencies.find((item) => item.target === target);
}

test("lintSkill returns the frozen clean report shape for a valid skill", async (t) => {
  const { skill } = await fixture(t, { "SKILL.md": valid() });
  const report = lintSkill(skill);

  assert.deepEqual(Object.keys(report).sort(), [
    "appliedExceptions", "complete", "dependencies", "findings", "name", "schemaVersion", "skill",
  ].sort());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.skill, path.resolve(skill));
  assert.equal(report.name, "example");
  assert.equal(report.complete, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.dependencies, []);
  assert.deepEqual(report.appliedExceptions, []);
});

test("frontmatter is schema-checked without coercing typed scalars", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": "---\nname: true\ndescription: 42\ndisable-model-invocation: \"true\"\n---\nBody\n",
  });
  const report = lintSkill(skill);

  assert.equal(report.name, null);
  assert.ok(rule(report, "frontmatter/name-type").length);
  assert.ok(rule(report, "frontmatter/description-type").length);
  assert.ok(rule(report, "pi/disable-model-invocation-type").length);
});

test("Markdown links establish shortest routes, while code and bare paths do not", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[guide](guide.md)\n`orphan.md`\n```md\n[ignored](ignored.md)\n```\n"),
    "guide.md": "[deep](deep.md)\n",
    "deep.md": "[third](third.md)\n",
    "third.md": "third\n",
    "orphan.md": "orphan\n",
    "ignored.md": "ignored\n",
  });
  const report = lintSkill(skill);

  assert.equal(rule(report, "resources/depth").length, 1);
  assert.ok(rule(report, "resources/depth")[0].route.includes(path.join(skill, "guide.md")));
  assert.equal(rule(report, "resources/orphan").length, 2);
  assert.ok(rule(report, "resources/orphan").every((finding) => ["orphan.md", "ignored.md"].some((name) => finding.path.endsWith(name))));
});

test("reference links and images retain source locations after frontmatter", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": "\ufeff---\r\nname: example\r\ndescription: desc\r\n---\r\n[missing](missing.txt)\r\n[guide][g]\r\n![asset](asset.txt)\r\n\r\n[g]: guide.md\r\n",
    "guide.md": "guide\n",
    "asset.txt": "asset\n",
  });
  const report = lintSkill(skill);

  const missing = rule(report, "references/missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, path.join(skill, "SKILL.md"));
  assert.equal(missing[0].line, 5);
  assert.equal(missing[0].column, 1);
  assert.deepEqual(report.dependencies, []);
});

test("broken links, fragments, URLs, and invalid escapes have explicit outcomes", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[missing](missing.md)\n[fragment](#heading)\n[web](https://example.test/a)\n[bad](bad%2.md)\n"),
  });
  const report = lintSkill(skill);

  assert.equal(rule(report, "references/missing").length, 1);
  assert.equal(rule(report, "references/invalid-encoding").length, 1);
  assert.equal(report.dependencies.length, 1);
  assert.equal(report.dependencies.find((item) => item.kind === "url").status, "unverified");
});

test("orphan exceptions and depth exceptions are applied and echoed", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[one](one.md)\n"),
    "one.md": "[two](two.md)\n",
    "two.md": "[three](three.md)\n",
    "three.md": "three\n",
    "legal.txt": "legal\n",
  });
  const report = lintSkill(skill, {
    exceptions: [
      { rule: "orphan", path: "legal.txt", reason: "Legal attribution" },
      { rule: "depth", path: "three.md", maxDepth: 3, reason: "Task route" },
    ],
  });

  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.appliedExceptions, [
    { rule: "depth", path: "three.md", maxDepth: 3, reason: "Task route" },
    { rule: "orphan", path: "legal.txt", reason: "Legal attribution" },
  ]);
});

test("symlinks are bounded and aliases remain separate inventory paths", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[alias](alias.md)\n"),
    "real.md": "real\n",
  });
  await symlink("real.md", path.join(skill, "alias.md"));
  await symlink("real.md", path.join(skill, "unlinked-alias.md"));
  await symlink("missing.md", path.join(skill, "broken.md"));

  const report = lintSkill(skill);
  assert.equal(report.dependencies.length, 0);
  assert.ok(rule(report, "resources/orphan").some((finding) => finding.path.endsWith("unlinked-alias.md")));
  assert.ok(rule(report, "resources/orphan").some((finding) => finding.path.endsWith("broken.md")));
  assert.equal(rule(report, "references/missing").length, 0);
});

test("resource roots permit shared files but do not flatten another skill", async (t) => {
  const { root, skill } = await fixture(t, {
    "SKILL.md": valid("[shared](../shared.md)\n[other](../other/SKILL.md)\n"),
  });
  await writeFile(path.join(root, "shared.md"), "shared\n");
  await mkdir(path.join(root, "other"), { recursive: true });
  await writeFile(path.join(root, "other", "SKILL.md"), valid().replaceAll("example", "other"));

  const report = lintSkill(skill, { resourceRoot: root });
  assert.equal(dependency(report, path.join(root, "shared.md")).status, "exists");
  assert.equal(dependency(report, path.join(root, "other", "SKILL.md")).kind, "skill");
  assert.equal(rule(report, "resources/orphan").length, 0);
});

test("limits make the report incomplete rather than silently truncating it", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[one](one.md)\n"),
    "one.md": "one\n",
  });
  const report = lintSkill(skill, { limits: { documents: 1 } });

  assert.equal(report.complete, false);
  assert.ok(report.findings.some((finding) => finding.category === "operational"));
});

test("malformed frontmatter returns findings without throwing", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": "---\nname: example\nname: duplicate\n---\n[missing](x.md)\n",
  });
  const report = lintSkill(skill);

  assert.equal(report.complete, true);
  assert.ok(rule(report, "frontmatter/parse").length);
  assert.equal(rule(report, "references/missing").length, 0);
});

test("metadata inspects YAML key and value types instead of object-coerced keys", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": "---\nname: example\ndescription: desc\nmetadata:\n  1: numeric key\n  count: 3\n---\nBody\n",
  });
  const report = lintSkill(skill);

  assert.ok(rule(report, "frontmatter/metadata-type").length);
  assert.equal(rule(report, "frontmatter/parse").length, 0);
});

test("nested YAML aliases and custom tags are rejected by frontmatter policy", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": "---\nname: example\ndescription: desc\nmetadata:\n  base: &base value\n  copied: *base\n  tagged: !custom value\n---\nBody\n",
  });
  const report = lintSkill(skill);

  assert.ok(rule(report, "frontmatter/alias").length);
  assert.ok(rule(report, "frontmatter/tag").length);
  assert.equal(report.complete, true);
});

test("ordinary frontmatter field errors do not suppress independent link analysis", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": "---\nname: Not-Example\ndescription: desc\n---\n[missing](missing.md)\n",
  });
  const report = lintSkill(skill);

  assert.ok(rule(report, "frontmatter/name-shape").length);
  assert.equal(rule(report, "frontmatter/parse").length, 0);
  assert.equal(rule(report, "references/missing").length, 1);
});

test("markdown and markdown resources are parsed as documents", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[guide](guide.markdown)\n"),
    "guide.markdown": "Guide\n",
  });
  const report = lintSkill(skill);

  assert.equal(report.complete, true);
  assert.deepEqual(report.findings, []);
});

test("document and byte budgets count a canonical symlink target once", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[a](a.md) [b](b.md)\n"),
    "shared.md": "x".repeat(100),
  });
  await symlink("shared.md", path.join(skill, "a.md"));
  await symlink("shared.md", path.join(skill, "b.md"));

  const report = lintSkill(skill, { limits: { documents: 2, totalBytes: 200 } });
  assert.equal(report.complete, true);
  assert.equal(report.findings.some((finding) => finding.category === "operational"), false);
});

test("inventory limits count excluded directory entries, while explicit ignored links are checked", async (t) => {
  const first = await fixture(t, {
    "SKILL.md": valid("Body\n"),
    ".git/ignored": "ignored\n",
    "visible.txt": "visible\n",
  });
  const limited = lintSkill(first.skill, { limits: { entries: 1 } });
  assert.equal(limited.complete, false);

  const second = await fixture(t, {
    "SKILL.md": valid("[git](.git)\n"),
    ".git/config": "config\n",
  });
  const checked = lintSkill(second.skill);
  assert.equal(checked.dependencies.length, 1);
  assert.equal(checked.dependencies[0].kind, "directory");
  assert.equal(checked.dependencies[0].status, "exists");
  assert.equal(rule(checked, "references/directory").length, 1);
});

test("duplicate reference definitions resolve to the first definition", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[guide][g]\n\n[g]: guide.md\n[g]: missing.md\n"),
    "guide.md": "guide\n",
  });
  const report = lintSkill(skill);

  assert.equal(rule(report, "references/missing").length, 0);
  assert.equal(rule(report, "resources/orphan").length, 0);
});

test("percent-decoding happens before absolute-path portability checks", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[absolute](%2Ftmp%2Fnot-a-skill-resource)\n"),
  });
  const report = lintSkill(skill);

  assert.equal(rule(report, "references/nonportable").length, 1);
  assert.equal(rule(report, "references/missing").length, 0);
  assert.equal(report.dependencies[0].status, "unverified");
});

test("external routes and terminal URLs use shortest depth routes", async (t) => {
  const { root, skill } = await fixture(t, {
    "SKILL.md": valid("[one](one.md)\n"),
    "one.md": "[shared](../shared.md)\n",
  });
  await writeFile(path.join(root, "shared.md"), "[asset](../asset.txt)\n[web](https://example.test)\n");
  await writeFile(path.join(root, "asset.txt"), "asset\n");

  const report = lintSkill(skill, { resourceRoot: root });
  const depths = rule(report, "resources/depth");
  assert.equal(depths.length, 2);
  assert.ok(depths.some((finding) => finding.path.endsWith("asset.txt") && finding.depth === 3));
  assert.ok(depths.some((finding) => finding.route.at(-1) === "https://example.test"));
});

test("a SKILL.md symlink outside scope is an incomplete operational result", async (t) => {
  const { root, skill } = await fixture(t, { "SKILL.md": valid("Body\n") });
  await writeFile(path.join(root, "outside.md"), valid("outside\n"));
  await unlink(path.join(skill, "SKILL.md"));
  await symlink("../outside.md", path.join(skill, "SKILL.md"));

  const report = lintSkill(skill);
  assert.equal(report.complete, false);
  assert.ok(report.findings.some((finding) => finding.category === "operational"));
});

test("limit boundaries accept exactly the budget and reject one below it", async (t) => {
  const { skill } = await fixture(t, {
    "SKILL.md": valid("[doc](doc.md)\n"),
    "doc.md": "doc\n",
  });
  const rootBytes = statSync(path.join(skill, "SKILL.md")).size;
  const docBytes = statSync(path.join(skill, "doc.md")).size;
  const cases = [
    ["fileBytes", Math.max(rootBytes, docBytes), Math.max(rootBytes, docBytes) - 1],
    ["totalBytes", rootBytes + docBytes, rootBytes + docBytes - 1],
    ["documents", 2, 1],
    ["entries", 2, 1],
    ["edges", 1, 0],
  ];
  for (const [key, exact, below] of cases) {
    assert.equal(lintSkill(skill, { limits: { [key]: exact } }).complete, true, `${key} exact`);
    assert.equal(lintSkill(skill, { limits: { [key]: below } }).complete, false, `${key} below`);
  }
});

test("symlinked directories are reported as unexpanded resources", async (t) => {
  const { skill } = await fixture(t, { "SKILL.md": valid("Body\n") });
  await mkdir(path.join(skill, "real-dir"));
  await writeFile(path.join(skill, "real-dir", "file.txt"), "file\n");
  await symlink("real-dir", path.join(skill, "linked-dir"), "dir");

  const report = lintSkill(skill);
  assert.equal(rule(report, "resources/symlink-directory").length, 1);
});

test("unlinked outside-scope Markdown symlinks stay unverified and can be orphaned", async (t) => {
  const { root, skill } = await fixture(t, { "SKILL.md": valid("Body\n") });
  await writeFile(path.join(root, "outside.md"), "outside\n");
  await symlink("../outside.md", path.join(skill, "outside.md"));

  const report = lintSkill(skill);
  assert.equal(report.complete, true);
  assert.equal(rule(report, "resources/orphan").length, 1);
  assert.equal(rule(report, "operational/scope").length, 0);
});

test("frontmatter length boundaries and optional field types are exact", async (t) => {
  const exactDescription = await fixture(t, {
    "SKILL.md": `---\nname: example\ndescription: ${"d".repeat(1024)}\ncompatibility: ${"c".repeat(500)}\n---\nBody\n`,
  });
  const overDescription = await fixture(t, {
    "SKILL.md": `---\nname: example\ndescription: ${"d".repeat(1025)}\ncompatibility: ${"c".repeat(501)}\n---\nBody\n`,
  });
  const exactReport = lintSkill(exactDescription.skill);
  const overReport = lintSkill(overDescription.skill);
  assert.equal(rule(exactReport, "frontmatter/description-length").length, 0);
  assert.equal(rule(exactReport, "frontmatter/compatibility-length").length, 0);
  assert.equal(rule(overReport, "frontmatter/description-length").length, 1);
  assert.equal(rule(overReport, "frontmatter/compatibility-length").length, 1);

  const typed = await fixture(t, {
    "SKILL.md": "---\nname: example\ndescription: desc\ncompatibility: 3\nmetadata: []\nlicense: 3\nallowed-tools: 3\ndisable-model-invocation: true\n---\nBody\n",
  });
  const typedReport = lintSkill(typed.skill);
  assert.ok(rule(typedReport, "frontmatter/compatibility-type").length);
  assert.ok(rule(typedReport, "frontmatter/metadata-type").length);
  assert.ok(rule(typedReport, "frontmatter/license-type").length);
  assert.ok(rule(typedReport, "frontmatter/allowed-tools-type").length);
  assert.equal(rule(typedReport, "pi/disable-model-invocation-type").length, 0);
});

test("invalid directory and options inputs are incomplete without linting cwd", () => {
  const invalidDirectory = lintSkill(42);
  assert.equal(invalidDirectory.complete, false);
  assert.ok(invalidDirectory.findings.some((finding) => finding.ruleId === "operational/arguments"));

  const invalidOptions = lintSkill("/definitely-not-a-real-skill", null);
  assert.equal(invalidOptions.complete, false);
  assert.ok(invalidOptions.findings.some((finding) => finding.ruleId === "operational/arguments"));
});
