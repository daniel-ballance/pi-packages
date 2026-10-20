import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generate, installGenerated, sectionHash } from "../generator/generate.mjs";
import { gitEnv } from "../generator/git-env.mjs";

const cli = fileURLToPath(new URL("../generator/generate.mjs", import.meta.url));

const manifest = fields => JSON.stringify({ sources: [{
  name: "cursor-plugins", vendor: "vendor/up",
  map: [{ from: "skills/", to: "skills/" }, { from: "LICENSE", to: "LICENSE" }],
  exclude: [], ...fields,
}] });
function fixture(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p3stack-generate-")));
  const defaults = {
    "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\nicon: crown\n---\n\n# Demo\n\nUse the Task tool.\n\n## Subagents\n\nCursor-only text.\n\n## Next\n\nKept.\n",
    "vendor/up/skills/demo/scripts/run.sh": "echo hi\n",
    "vendor/up/README.md": "Not emitted.\n",
    "vendor/up/LICENSE": "MIT\n",
    "rules/manifest.json": manifest(),
    "rules/tokens.json": JSON.stringify([
      { id: "task-tool", min: 1, find: "the Task tool", replace: "a child" },
      { id: "skill-name", min: 1, find: "^name: Demo$", flags: "m", replace: "name: demo", files: "^skills/demo/SKILL\\.md$" },
      { id: "drop-icon", min: 0, find: "^icon: .*\\n", flags: "m", replace: "" },
    ]),
    "rules/sections.json": JSON.stringify([
      { file: "skills/demo/SKILL.md", heading: "## Subagents", overlay: "demo/subagents.md", upstream: "8a5db126d6c5" },
    ]),
    "rules/lint.json": JSON.stringify({ deny: ["Task tool", "Cursor"] }),
    "overlays/demo/subagents.md": "## Subagents\n\nPi delegation.\n",
  };
  for (const [path, text] of Object.entries({ ...defaults, ...files })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const out = join(root, "out");
  const read = path => readFileSync(join(out, path), "utf8");
  return { root, out, read, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function twoSources(files = {}) {
  return fixture({
    "vendor/other/skills/second/SKILL.md": "# Second\n\nUse the Task tool.\n",
    "rules/manifest.json": JSON.stringify({ sources: [
      JSON.parse(manifest()).sources[0],
      { name: "other", vendor: "vendor/other", map: [{ from: "skills/", to: "skills/" }], exclude: ["^skills/omitted/"] },
    ] }),
    ...files,
  });
}

test("two sources emit their mapped skills and keep their exclusions separate", () => {
  const { root, out, read, dispose } = twoSources({ "vendor/other/skills/omitted/SKILL.md": "Cursor\n" });
  try {
    generate({ packageDir: root, outDir: out });
    assert.match(read("skills/demo/SKILL.md"), /Use a child/);
    assert.equal(read("skills/second/SKILL.md"), "# Second\n\nUse a child.\n");
    assert.equal(existsSync(join(out, "skills/omitted/SKILL.md")), false);
  } finally { dispose(); }
});

test("two sources that emit the same path fail before writing and name both sources", () => {
  const { root, out, dispose } = twoSources({ "vendor/other/skills/demo/SKILL.md": "# Collision\n" });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), error => {
      assert.match(error.message, /skills\/demo\/SKILL\.md/);
      assert.match(error.message, /cursor-plugins/);
      assert.match(error.message, /other/);
      return true;
    });
    assert.equal(existsSync(out), false);
  } finally { dispose(); }
});

test("the coupling lint scans the second source", () => {
  const { root, out, dispose } = twoSources({ "vendor/other/skills/second/SKILL.md": "# Second\n\nCursor\n" });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /skills\/second\/SKILL\.md:3: Cursor/);
  } finally { dispose(); }
});

test("source-scoped token rules rewrite only that source and global rules still span sources", () => {
  const { root, out, read, dispose } = twoSources({
    "rules/tokens.json": JSON.stringify([
      { id: "other-task", source: "other", min: 1, find: "the Task tool", replace: "a second child", files: "SKILL\\.md$" },
      { id: "all-task", min: 1, find: "the Task tool", replace: "a first child" },
      { id: "all-use", min: 2, find: "Use", replace: "Run" },
    ]),
    "rules/lint.json": JSON.stringify({ deny: [] }),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.match(read("skills/demo/SKILL.md"), /Run a first child/);
    assert.equal(read("skills/second/SKILL.md"), "# Second\n\nRun a second child.\n");
  } finally { dispose(); }
});

test("a source-scoped token minimum cannot count matches from another source", () => {
  const { root, out, dispose } = twoSources({
    "rules/tokens.json": JSON.stringify([{ id: "only-other", source: "other", min: 1, find: "Cursor-only", replace: "Pi" }]),
  });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /only-other: 0 matches, expected at least 1/);
  } finally { dispose(); }
});

test("source names must be nonempty and unique", () => {
  for (const name of ["", "cursor-plugins"]) {
    const sources = JSON.parse(manifest()).sources;
    sources.push({ name, vendor: "vendor/other", map: [] });
    const { root, out, dispose } = fixture({ "rules/manifest.json": JSON.stringify({ sources }) });
    try {
      assert.throws(() => generate({ packageDir: root, outDir: out }), /source.*name/i);
      assert.equal(existsSync(out), false);
    } finally { dispose(); }
  }
});

test("a token rule with an unknown source fails even without a minimum", () => {
  const { root, out, dispose } = twoSources({
    "rules/tokens.json": JSON.stringify([{ id: "typo", source: "missing", find: "Use", replace: "Run" }]),
  });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /typo.*unknown source.*missing/i);
  } finally { dispose(); }
});

test("tokens, sections and the file map produce the translated tree", () => {
  const { root, out, read, dispose } = fixture({});
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/SKILL.md"), "---\nname: demo\n---\n\n# Demo\n\nUse a child.\n\n## Subagents\n\nPi delegation.\n\n## Next\n\nKept.\n");
    assert.equal(read("skills/demo/scripts/run.sh"), "echo hi\n");
    assert.equal(read("LICENSE"), "MIT\n");
    assert.equal(existsSync(join(out, "README.md")), false, "unmapped upstream files are not emitted");
  } finally { dispose(); }
});

test("slash commands discover emitted skill paths, including new skills and principles, without rewriting other tokens", () => {
  const rule = JSON.parse(readFileSync(new URL("../rules/tokens.json", import.meta.url), "utf8")).find(({ id }) => id === "slash-skill");
  const { root, out, read, dispose } = fixture({
    "vendor/up/skills/future-check/SKILL.md": "# Future\n\nRun /future-check and /principle-future.\n",
    "vendor/up/skills/principle-future/SKILL.md": "# Principle\n",
    "vendor/up/skills/omitted/SKILL.md": "# Omitted\n",
    "vendor/up/agents/helper.md": "Run /future-check.\n",
    "vendor/up/skills/demo/commands.md": "/demo /future-check /principle-future /not-a-skill /omitted /principle-missing\n/skill:future-check docs/future-check https://example.test/future-check ./future-check ../future-check /future-check-more /future-check_word\n",
    "rules/manifest.json": manifest({ map: [{ from: "skills/", to: "skills/" }, { from: "agents/", to: "agents/" }], exclude: ["^skills/omitted/"] }),
    "rules/tokens.json": JSON.stringify([{ ...rule, min: 1 }]),
    "rules/sections.json": "[]",
    "rules/lint.json": JSON.stringify({ deny: [] }),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/future-check/SKILL.md"), "# Future\n\nRun /skill:future-check and /skill:principle-future.\n");
    assert.equal(read("agents/helper.md"), "Run /skill:future-check.\n");
    assert.equal(read("skills/demo/commands.md"), "/skill:demo /skill:future-check /skill:principle-future /not-a-skill /omitted /principle-missing\n/skill:future-check docs/future-check https://example.test/future-check ./future-check ../future-check /future-check-more /future-check_word\n");
  } finally { dispose(); }
});

test("slash command discovery with no emitted skills cannot match a bare slash", () => {
  const rule = JSON.parse(readFileSync(new URL("../rules/tokens.json", import.meta.url), "utf8")).find(({ id }) => id === "slash-skill");
  const { root, out, read, dispose } = fixture({
    "vendor/up/agents/helper.md": "Use /future-check or /anything.\n",
    "rules/manifest.json": manifest({ map: [{ from: "agents/", to: "agents/" }] }),
    "rules/tokens.json": JSON.stringify([{ ...rule, min: 0 }]),
    "rules/sections.json": "[]",
    "rules/lint.json": JSON.stringify({ deny: [] }),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("agents/helper.md"), "Use /future-check or /anything.\n");
  } finally { dispose(); }
});

test("a token rule that stops matching upstream fails with its id", () => {
  const { root, out, dispose } = fixture({ "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\n---\n\n## Subagents\n\nx\n" });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /task-tool: 0 matches, expected at least 1/);
  } finally { dispose(); }
});

test("a section heading that disappears upstream fails with its file and heading", () => {
  const { root, out, dispose } = fixture({ "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Delegation\n\nx\n" });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /skills\/demo\/SKILL\.md: heading "## Subagents" not found/);
  } finally { dispose(); }
});

test("a leaf section ends at the next heading of the same or a higher level, and a parent overlay is refused", () => {
  const parentText = "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Subagents\n\nCursor.\n\n### Detail\n\nCursor too.\n\n# Top\n\nKept.\n";
  const parent = fixture({
    "vendor/up/skills/demo/SKILL.md": parentText,
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "## Subagents", overlay: "demo/subagents.md", upstream: sectionHash(parentText, "## Subagents") }]),
  });
  try {
    assert.throws(() => generate({ packageDir: parent.root, outDir: parent.out }), error => {
      assert.match(error.message, /skills\/demo\/SKILL\.md: "## Subagents" is not a leaf; it contains "### Detail"/);
      assert.match(error.message, /token anchored on "## Subagents"/);
      assert.match(error.message, /A sibling with no rule is emitted/);
      assert.doesNotMatch(error.message, /update its hash/);
      return true;
    });
  } finally { parent.dispose(); }
  const leafText = "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Subagents\n\nCursor.\n\n## Next\n\nSame level.\n\n# Top\n\nKept.\n";
  const leaf = fixture({
    "vendor/up/skills/demo/SKILL.md": leafText,
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "## Subagents", overlay: "demo/subagents.md", upstream: sectionHash(leafText, "## Subagents") }]),
  });
  try {
    generate({ packageDir: leaf.root, outDir: leaf.out });
    assert.equal(leaf.read("skills/demo/SKILL.md"), "---\nname: demo\n---\n\nUse a child.\n\n## Subagents\n\nPi delegation.\n\n## Next\n\nSame level.\n\n# Top\n\nKept.\n");
  } finally { leaf.dispose(); }
});

test("patches apply after tokens and sections, and a stale patch fails with its name", () => {
  const patch = [
    "--- a/skills/demo/SKILL.md", "+++ b/skills/demo/SKILL.md", "@@ -11,3 +11,3 @@", " ## Next", " ", "-Kept.", "+Patched.", "",
  ].join("\n");
  const ok = fixture({ "patches/0001-demo.patch": patch });
  try {
    generate({ packageDir: ok.root, outDir: ok.out });
    assert.match(ok.read("skills/demo/SKILL.md"), /## Next\n\nPatched\.\n$/);
  } finally { ok.dispose(); }
  const stale = fixture({ "patches/0001-demo.patch": patch.replace("-Kept.", "-Gone.") });
  try {
    assert.throws(() => generate({ packageDir: stale.root, outDir: stale.out }), /0001-demo\.patch/);
  } finally { stale.dispose(); }
});

test("the coupling lint names every file, line and token a rule left behind", () => {
  const { root, out, dispose } = fixture({ "vendor/up/skills/demo/extra.md": "fine\nopen .cursor/rules\nCursor again\n", "rules/lint.json": JSON.stringify({ deny: ["Task tool", "Cursor", ".cursor"] }) });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), error => {
      assert.match(error.message, /skills\/demo\/extra\.md:2: \.cursor/);
      assert.match(error.message, /skills\/demo\/extra\.md:3: Cursor/);
      return true;
    });
  } finally { dispose(); }
});

test("excluded upstream paths are never emitted", () => {
  const { root, out, dispose } = fixture({
    "rules/manifest.json": manifest({ map: [{ from: "skills/", to: "skills/" }], exclude: ["^skills/demo/scripts/"] }),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(existsSync(join(out, "skills/demo/scripts/run.sh")), false);
  } finally { dispose(); }
});

test("check mode reports drift in generated outputs without writing, and sync repairs it", () => {
  const { root, dispose } = fixture({});
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, P3STACK_PACKAGE_DIR: root } });
  try {
    assert.equal(run().status, 0, run().stderr);
    assert.equal(run("--check").status, 0, "a fresh sync has no drift");
    writeFileSync(join(root, "skills/demo/SKILL.md"), "hand edit\n");
    writeFileSync(join(root, "skills/demo/stray.md"), "not generated\n");
    const drift = run("--check");
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /skills\/demo\/SKILL\.md/);
    assert.match(drift.stderr, /skills\/demo\/stray\.md/);
    assert.equal(readFileSync(join(root, "skills/demo/SKILL.md"), "utf8"), "hand edit\n");
    assert.equal(run().status, 0);
    assert.equal(existsSync(join(root, "skills/demo/stray.md")), false, "sync replaces generated roots whole");
    assert.equal(run("--check").status, 0);
  } finally { dispose(); }
});

test("a replaced section that changes upstream fails with its new hash, so the overlay is reviewed", () => {
  const { root, out, dispose } = fixture({ "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Subagents\n\nNew Cursor-only text.\n\n## Next\n\nKept.\n" });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /skills\/demo\/SKILL\.md: section "## Subagents" changed upstream \(was 8a5db126d6c5, now [0-9a-f]{12}\)/);
  } finally { dispose(); }
});

test("authored files copy after extras without token rewrites and keep executable modes", () => {
  const { root, out, read, dispose } = fixture({
    "extra/skills/demo/references/contract.md": "Extra copy.\n",
    "authored/skills/demo/references/contract.md": "Authored copy.\n",
    "authored/skills/release/SKILL.md": "---\nname: release\ndescription: Prepare a release.\n---\n\n# Release\n",
    "authored/skills/release/scripts/version.sh": "echo version\n",
    "rules/tokens.json": JSON.stringify([{ id: "authored-untouched", find: "Authored", replace: "Rewritten" }]),
    "rules/sections.json": "[]",
    "rules/lint.json": JSON.stringify({ deny: [] }),
  });
  try {
    chmodSync(join(root, "authored/skills/release/scripts/version.sh"), 0o755);
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/references/contract.md"), "Authored copy.\n");
    assert.match(read("skills/release/SKILL.md"), /^name: release$/m);
    assert.equal(statSync(join(out, "skills/release/scripts/version.sh")).mode & 0o111, 0o111);
  } finally { dispose(); }
});

test("the coupling lint scans authored files", () => {
  const { root, out, dispose } = fixture({ "authored/skills/release/SKILL.md": "Use the Task tool.\n" });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /skills\/release\/SKILL\.md:1: Task tool/);
  } finally { dispose(); }
});

test("hand-written extras are copied into the output and still linted", () => {
  const { root, out, read, dispose } = fixture({ "extra/skills/demo/references/contract.md": "Delegate.\n" });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/references/contract.md"), "Delegate.\n");
  } finally { dispose(); }
  const dirty = fixture({ "extra/skills/demo/references/contract.md": "Use the Task tool.\n" });
  try {
    assert.throws(() => generate({ packageDir: dirty.root, outDir: dirty.out }), /skills\/demo\/references\/contract\.md:1: Task tool/);
  } finally { dirty.dispose(); }
});

test("a section rule matches the heading after token rewrites, and hashes the upstream heading", () => {
  const { root, out, read, dispose } = fixture({
    "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Run /demo\n\nCursor.\n",
    "rules/tokens.json": JSON.stringify([
      { id: "task-tool", min: 1, find: "the Task tool", replace: "a child" },
      { id: "skill-name", min: 1, find: "^name: Demo$", flags: "m", replace: "name: demo" },
      { id: "slash", min: 1, find: "/demo\\b", replace: "/skill:demo" },
    ]),
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "## Run /skill:demo", upstreamHeading: "## Run /demo", overlay: "demo/subagents.md", upstream: "2990d269bc84" }]),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.match(read("skills/demo/SKILL.md"), /## Subagents\n\nPi delegation\.\n$/);
  } finally { dispose(); }
});

test("headings inside fenced code neither start nor end a section, whatever the fence length", () => {
  const body = "## Subagents\n\nCursor-only text.\n\n````md\n```\n## Next\n````\n\n   ## Indented end\n\nKept.\n";
  const upstream = "---\nname: Demo\n---\n\nUse the Task tool.\n\n```md\n## Subagents\n```\n\n" + body;
  const hash = sectionHash(upstream, "## Subagents");
  const { root, out, read, dispose } = fixture({
    "vendor/up/skills/demo/SKILL.md": upstream,
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "## Subagents", overlay: "demo/subagents.md", upstream: hash }]),
  });
  try {
    assert.equal(hash, sectionHash("## Subagents\n\nCursor-only text.\n\n````md\n```\n## Next\n````\n", "## Subagents"));
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/SKILL.md"), "---\nname: demo\n---\n\nUse a child.\n\n```md\n## Subagents\n```\n\n## Subagents\n\nPi delegation.\n\n   ## Indented end\n\nKept.\n");
  } finally { dispose(); }
});

test("files that are not valid UTF-8 are copied byte for byte, and executable bits survive", () => {
  const { root, out, dispose } = fixture({});
  try {
    writeFileSync(join(root, "vendor/up/skills/demo/logo.bin"), Buffer.from([0xff, 0xfe, 0x80, 0x41]));
    chmodSync(join(root, "vendor/up/skills/demo/scripts/run.sh"), 0o755);
    generate({ packageDir: root, outDir: out });
    assert.deepEqual([...readFileSync(join(out, "skills/demo/logo.bin"))], [0xff, 0xfe, 0x80, 0x41]);
    assert.equal(statSync(join(out, "skills/demo/scripts/run.sh")).mode & 0o111, 0o111);
    assert.equal(statSync(join(out, "skills/demo/SKILL.md")).mode & 0o111, 0);
  } finally { dispose(); }
});

test("check mode reports a lost executable bit and any symlink in the generated roots", () => {
  const { root, dispose } = fixture({});
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, P3STACK_PACKAGE_DIR: root } });
  try {
    chmodSync(join(root, "vendor/up/skills/demo/scripts/run.sh"), 0o755);
    assert.equal(run().status, 0);
    chmodSync(join(root, "skills/demo/scripts/run.sh"), 0o644);
    symlinkSync("missing.md", join(root, "skills/demo/link.md"));
    const drift = run("--check");
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /skills\/demo\/scripts\/run\.sh: mode differs/);
    assert.match(drift.stderr, /skills\/demo\/link\.md: not generated/);
  } finally { dispose(); }
});

test("patches apply in code-unit order, independent of locale", () => {
  const first = ["--- a/skills/demo/SKILL.md", "+++ b/skills/demo/SKILL.md", "@@ -13 +13 @@", "-Kept.", "+B.", ""].join("\n");
  const second = ["--- a/skills/demo/SKILL.md", "+++ b/skills/demo/SKILL.md", "@@ -13 +13 @@", "-B.", "+C.", ""].join("\n");
  const { root, out, read, dispose } = fixture({ "patches/Z.patch": first, "patches/a.patch": second });
  try {
    generate({ packageDir: root, outDir: out });
    assert.match(read("skills/demo/SKILL.md"), /\nC\.\n$/);
  } finally { dispose(); }
});

test("sync records the upstream commit and version in package.json, and check fails when they drift", () => {
  const { root, dispose } = fixture({
    "vendor/up/plugin.json": JSON.stringify({ name: "up", version: "1.2.3" }),
    "package.json": JSON.stringify({ name: "demo", p3stack: { upstream: "stale" } }, null, 2) + "\n",
    "rules/manifest.json": manifest({ upstream: { repository: "acme/plugins", checkout: "vendor/up" }, map: [{ from: "skills/", to: "skills/" }] }),
  });
  const git = (...args) => spawnSync("git", ["-C", join(root, "vendor/up"), ...args], { encoding: "utf8", env: gitEnv() });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, P3STACK_PACKAGE_DIR: root } });
  try {
    git("init", "-q"); git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).p3stack.upstream, `acme/plugins@${sha} up 1.2.3`);
    assert.equal(run("--check").status, 0);
    writeFileSync(join(root, "vendor/up/plugin.json"), JSON.stringify({ name: "up", version: "1.2.4" }));
    assert.equal(git("add", ".").status, 0);
    assert.equal(git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump upstream version").status, 0);
    const drift = run("--check");
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /package\.json p3stack\.upstream/);
  } finally { dispose(); }
});

test("a parent overlay is refused even when its hash is current", () => {
  const text = "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Steps\n\nDo these.\n\n### 1. First\n\nCursor.\n\n### 2. Second\n\nAlso Cursor.\n";
  const { root, out, dispose } = fixture({
    "vendor/up/skills/demo/SKILL.md": text,
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "## Steps", overlay: "demo/subagents.md", upstream: sectionHash(text, "## Steps") }]),
  });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /"## Steps" is not a leaf; it contains "### 1\. First", "### 2\. Second"/);
  } finally { dispose(); }
});

test("replacing a leaf leaves a new sibling offer, translated, with no rule for that sibling", () => {
  const text = "---\nname: Demo\n---\n\nUse the Task tool.\n\n### 1. First\n\nCursor leaf.\n\n### 2. Offer\n\nRun /demo now.\n";
  const { root, out, read, dispose } = fixture({
    "vendor/up/skills/demo/SKILL.md": text,
    "rules/tokens.json": JSON.stringify([
      { id: "task-tool", min: 1, find: "the Task tool", replace: "a child" },
      { id: "skill-name", min: 1, find: "^name: Demo$", flags: "m", replace: "name: demo" },
      { id: "offer", min: 1, find: "/demo\\b", replace: "/skill:demo", files: "^skills/demo/" },
    ]),
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "### 1. First", overlay: "demo/subagents.md", upstream: sectionHash(text, "### 1. First") }]),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/SKILL.md"), "---\nname: demo\n---\n\nUse a child.\n\n## Subagents\n\nPi delegation.\n\n### 2. Offer\n\nRun /skill:demo now.\n");
  } finally { dispose(); }
});

test("a heading inside a fence is not a child of the leaf that contains it", () => {
  const text = "---\nname: Demo\n---\n\nUse the Task tool.\n\n### 5. Write the rule\n\nBefore.\n\n```md\n### 9. Not a heading\n# Also not\n```\n\nAfter.\n\n### 6. Confirm\n\nKept.\n";
  const { root, out, read, dispose } = fixture({
    "vendor/up/skills/demo/SKILL.md": text,
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "### 5. Write the rule", overlay: "demo/subagents.md", upstream: sectionHash(text, "### 5. Write the rule") }]),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/SKILL.md"), "---\nname: demo\n---\n\nUse a child.\n\n## Subagents\n\nPi delegation.\n\n### 6. Confirm\n\nKept.\n");
  } finally { dispose(); }
});

test("setup offers and the help setup sentence come from upstream through the package rules", () => {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  const out = realpathSync(mkdtempSync(join(tmpdir(), "p3stack-rules-")));
  try {
    generate({ packageDir, outDir: out });
    const setup = readFileSync(join(out, "skills/setup-pstack/SKILL.md"), "utf8");
    const help = readFileSync(join(out, "skills/poteto-help/SKILL.md"), "utf8");
    const upstream = readFileSync(join(packageDir, "vendor/pstack/pstack/skills/setup-pstack/SKILL.md"), "utf8");
    const aside = " (resolves wherever pstack is installed: workspace, user, or plugin)";
    const expectedOffers = upstream.slice(upstream.indexOf("### 7. Offer a verification skill")).replaceAll(aside, "").replaceAll(/\/(create-(?:formal-)?verification-skill)\b/g, "/skill:$1");
    assert.equal(setup.slice(setup.indexOf("### 7. Offer a verification skill")), expectedOffers);
    assert.equal(setup.includes(aside), false);
    const offer = "Then it offers once each to generate a verification skill and a formal verification skill for the project, unless the project already has one.";
    assert.equal(help.includes(offer), true);
    assert.equal(readFileSync(join(packageDir, "vendor/pstack/pstack/skills/poteto-help/SKILL.md"), "utf8").includes(offer), true);
    assert.match(help, /The collection installs p3stack with `subagents` and `todo`/);
    assert.match(help, /p3stack spends extra tokens on subagents and review panels/);
    assert.match(help, /written for Cursor/);
    assert.equal(help.includes("/plugin "), false);
    assert.equal(help.includes("docs/harness/"), false);
    assert.equal(help.includes("not part of the collection manifest"), false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

const packageDir = fileURLToPath(new URL("..", import.meta.url));
test("the maintenance skill and its references are emitted byte-for-byte from authored inputs", () => {
  const out = mkdtempSync(join(tmpdir(), "p3stack-maintain-"));
  try {
    generate({ packageDir, outDir: out });
    const directory = "skills/maintain-p3stack";
    for (const path of ["SKILL.md", "references/failure-classes.md", "references/bump-note.md", "references/nightly.md"]) {
      const input = join(packageDir, "authored", directory, path);
      assert.ok(existsSync(input), path);
      assert.deepEqual(readFileSync(join(out, directory, path)), readFileSync(input), path);
    }
    const routes = JSON.parse(readFileSync(join(packageDir, "registry/routes.json"), "utf8"));
    assert.ok(routes.some(row => row.target === "maintain-p3stack"));
    assert.match(readFileSync(join(out, "skills/p3stack-mode/SKILL.md"), "utf8"), /\.\.\/maintain-p3stack\/SKILL\.md/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("the router renders the registry tables with existing route targets and no template output", () => {
  const out = mkdtempSync(join(tmpdir(), "p3stack-router-"));
  try {
    generate({ packageDir, outDir: out });
    const router = readFileSync(join(out, "skills/p3stack-mode/SKILL.md"), "utf8");
    assert.doesNotMatch(router, /\{\{(?:routes|chains)\}\}/);
    assert.doesNotMatch(router, /\/home\/|\/tmp\//);
    assert.ok(router.includes("<package>/skills/p3stack-mode/SKILL.md"));
    assert.ok(router.includes("<package>/skills/poteto-mode/SKILL.md"));
    assert.equal(existsSync(join(out, "skills/p3stack-mode/SKILL.md.tmpl")), false);
    const routes = JSON.parse(readFileSync(join(packageDir, "registry/routes.json"), "utf8"));
    for (const { request, target } of routes) {
      assert.ok(router.includes(request), request);
      const path = target.startsWith("p3stack-mode/playbooks/") ? target : target.startsWith("playbooks/") ? `poteto-mode/${target}` : `${target}/SKILL.md`;
      assert.ok(existsSync(join(out, "skills", path)), target);
      assert.ok(router.includes(`\`<this file's directory>/../${path}\``), target);
    }
    for (const { anchor, skill } of JSON.parse(readFileSync(join(packageDir, "registry/chains.json"), "utf8"))) {
      assert.ok(router.includes(anchor), anchor);
      assert.ok(router.includes(`\`<this file's directory>/../${skill}/SKILL.md\``), skill);
    }
    const paths = [...router.matchAll(/`<this file's directory>\/([^`]+)`/g)];
    assert.ok(paths.length > routes.length);
    for (const [, path] of paths) {
      assert.ok(existsSync(join(out, "skills/p3stack-mode", path)), path);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("the router precedence overlay is locked to upstream Playbooks", () => {
  const sections = JSON.parse(readFileSync(join(packageDir, "rules/sections.json"), "utf8"));
  const rule = sections.find(row => row.file === "skills/poteto-mode/SKILL.md" && row.heading === "## Playbooks");
  assert.ok(rule, "the precedence failure requires a Playbooks overlay");
  const upstream = readFileSync(join(packageDir, "vendor/pstack/pstack/skills/poteto-mode/SKILL.md"), "utf8");
  assert.equal(rule.upstream, sectionHash(upstream, "## Playbooks"));
  const mode = readFileSync(join(packageDir, "skills/poteto-mode/SKILL.md"), "utf8");
  assert.match(mode, /p3stack-mode.*route and chain tables/);
});

test("the package ships the Pocock license and initializes both source checkouts", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("LICENSE-matt-pocock"));
  assert.match(manifest.scripts.sync, /packages\/p3stack\/vendor\/matt-pocock/);
});

test("the collection and global settings use only the unified skill source", () => {
  const rootManifest = JSON.parse(readFileSync(join(packageDir, "../../package.json"), "utf8"));
  assert.equal(rootManifest.pi.skills.some(path => path.includes("pi-pocock-skills")), false);
  for (const lock of ["package-lock.json", "pnpm-lock.yaml"]) assert.equal(readFileSync(join(packageDir, "../..", lock), "utf8").includes("pi-pocock-skills"), false, lock);
  const settings = JSON.parse(readFileSync(join(packageDir, "../../global/settings.json"), "utf8"));
  assert.equal(settings.packages.some(entry => JSON.stringify(entry).includes("pi-pocock-skills")), false);
  const source = settings.packages.find(entry => (typeof entry === "string" ? entry : entry.source).endsWith("/p3stack"));
  assert.equal(source, "../../Code/pi-packages/packages/p3stack");
});

test("the root gate uses the registry instead of the retired skill-report and decision directory", () => {
  const root = join(packageDir, "../..");
  const check = readFileSync(join(root, "scripts/check.sh"), "utf8");
  assert.match(check, /node packages\/p3stack\/generator\/check-registry\.mjs/);
  assert.doesNotMatch(check, /skill-report/);
  assert.equal(existsSync(join(root, "scripts/skill-report.mjs")), false);
  assert.equal(existsSync(join(root, ".pi/skills/p3stack-pocock-unification")), false);
});

const pocockNames = ["grilling", "grill-with-docs", "domain-modeling", "codebase-design", "code-review", "writing-for-agents", "diagnosing-bugs", "research", "tdd", "implement", "triage", "setup-matt-pocock-skills", "to-spec", "to-tickets", "wayfinder", "implement-spec", "improve-codebase-architecture", "pr", "retro", "handoff", "wizard"];

function pocockFixture() {
  const temp = mkdtempSync(join(process.env.P3STACK_FIXTURE_ROOT ?? tmpdir(), "p3stack-pocock-"));
  const root = join(temp, "repo/packages/p3stack");
  mkdirSync(join(temp, "repo/scripts"), { recursive: true });
  symlinkSync(join(packageDir, "../../scripts/lint-skill"), join(temp, "repo/scripts/lint-skill"));
  for (const name of ["rules", "registry", "extra", "authored", "overlays", "patches", "vendor/pstack"]) cpSync(join(packageDir, name), join(root, name), { recursive: true });
  const oldVendor = join(packageDir, "../pi-pocock-skills/vendor/matt-pocock");
  cpSync(existsSync(oldVendor) ? oldVendor : join(packageDir, "vendor/matt-pocock"), join(root, "vendor/matt-pocock"), { recursive: true });
  const manifestPath = join(root, "rules/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const source of manifest.sources) delete source.upstream;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const directory of ["rules", "overlays"]) {
    for (const path of readdirSync(join(root, directory), { recursive: true })) {
      const file = join(root, directory, path);
      if (statSync(file).isFile()) writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{upstream.commit}}", "fixture-pin"));
    }
  }
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, P3STACK_PACKAGE_DIR: root } });
  const input = path => join(root, "vendor/matt-pocock/skills", path);
  const read = path => readFileSync(join(root, "skills", path), "utf8");
  const rewrite = (path, from, to) => writeFileSync(input(path), readFileSync(input(path), "utf8").replaceAll(from, to));
  const dispose = () => rmSync(temp, { recursive: true, force: true });
  return { root, run, input, read, rewrite, dispose };
}

function pocockCase(name, body) {
  test(`Pocock ${name}`, () => {
    const fixture = pocockFixture();
    try { body(fixture); } finally { fixture.dispose(); }
  });
}

pocockCase("1 check reports mismatches without replacing committed output", ({ root, run, read }) => {
  assert.equal(run().status, 0);
  writeFileSync(join(root, "skills/grilling/SKILL.md"), "committed marker\n");
  const checked = run("--check");
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /skills\/grilling\/SKILL\.md/);
  assert.equal(read("grilling/SKILL.md"), "committed marker\n");
});

pocockCase("2 missing adopted skills fail by name", ({ run, input }) => {
  rmSync(input("engineering/research"), { recursive: true });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stale registry row matt-pocock\/skills\/engineering\/research\/SKILL\.md/);
});

pocockCase("3 duplicate names in two buckets fail", ({ run, input }) => {
  cpSync(input("engineering/research"), input("productivity/research"), { recursive: true });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unclassified skill matt-pocock\/skills\/productivity\/research\/SKILL\.md/);
});

pocockCase("4 ordered rule minima detect upstream drift", ({ run, input, rewrite }) => {
  for (const path of readdirSync(input(""), { recursive: true }).filter(path => path.endsWith(".md"))) rewrite(path, "sub-agents", "child-workers");
  assert.match(run().stderr, /subagent-plural: 0 matches/);
});

pocockCase("5 tracker prerequisites survive and review collection retains its drift guard", ({ run, read, rewrite }) => {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(read("code-review/SKILL.md"), /The issue tracker should have been provided/);
  assert.match(read("triage/SKILL.md"), /docs\/agents\/issue-tracker.md/);
  assert.match(read("implement/SKILL.md"), /fetch it from the issue tracker and state its title/);
  rewrite("engineering/code-review/SKILL.md", "in the foreground", "upstream changed this wording");
  assert.match(run().stderr, /subagent-review-collect: 0 matches/);
});

pocockCase("6 unrecognized harness wording names the file", ({ run, input }) => {
  const file = input("engineering/research/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\nUse the Skill tool for another task.\n");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skills\/research\/SKILL\.md:\d+: Skill tool/);
});

pocockCase("7 invalid optional regexes are errors", ({ root, run }) => {
  const file = join(root, "rules/tokens.json"), rules = JSON.parse(readFileSync(file, "utf8"));
  const rule = rules.find(({ id, source }) => id === "clear-to-new" && source === "matt-pocock");
  assert.ok(rule);
  rule.find = "(";
  writeFileSync(file, JSON.stringify(rules));
  assert.match(run().stderr, /Invalid regular expression/);
});

pocockCase("8 glossary resource collisions fail instead of overwriting", ({ run, input }) => {
  cpSync(input("engineering/domain-modeling/GLOSSARY-FORMAT.md"), input("engineering/domain-modeling/CONTEXT-FORMAT.md"));
  assert.match(run().stderr, /skills\/domain-modeling\/CONTEXT-FORMAT\.md.*both emit/);
});

pocockCase("9 failed validation preserves committed output", ({ root, run, input, read }) => {
  assert.equal(run().status, 0);
  const before = read("grilling/SKILL.md") + "\npreserve this output\n";
  writeFileSync(join(root, "skills/grilling/SKILL.md"), before);
  rmSync(input("engineering/research"), { recursive: true });
  assert.equal(run().status, 1);
  assert.equal(read("grilling/SKILL.md"), before);
});

pocockCase("10 translation preserves semantics and is deterministic", ({ root, run, read }) => {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  for (const name of pocockNames) assert.ok(existsSync(join(root, "skills", name, "SKILL.md")), name);
  assert.match(read("diagnosing-bugs/SKILL.md"), /\[HITL loop template\]\(scripts\/hitl-loop.template.sh\)/);
  assert.match(read("grill-with-docs/SKILL.md"), /\[grilling\]\(\.\.\/grilling\/SKILL.md\)/);
  assert.match(read("research/SKILL.md"), /\[child delegation guidance\]\(\.\.\/poteto-mode\/references\/host-capabilities.md\)/);
  assert.match(read("implement/SKILL.md"), /\[tdd\]\(\.\.\/tdd\/SKILL.md\)/);
  assert.match(read("implement/SKILL.md"), /\[code-review\]\(\.\.\/code-review\/SKILL.md\)/);
  assert.match(read("implement/SKILL.md"), /fetch it from the issue tracker and state its title/);
  assert.match(read("code-review/SKILL.md"), /collect and verify both reports before aggregating/);
  assert.match(read("code-review/SKILL.md"), /Search the repo for every file/);
  assert.match(read("diagnosing-bugs/SKILL.md"), /prove the mutation landed/);
  assert.match(read("grilling/SKILL.md"), /"yes" accepts your recommended answer/);
  assert.match(read("domain-modeling/SKILL.md"), /\[CONTEXT-FORMAT.md\]\(\.\/CONTEXT-FORMAT.md\)/);
  assert.match(read("domain-modeling/CONTEXT-FORMAT.md"), /\[Ordering\]\(\.\/src\/ordering\/CONTEXT.md\)/);
  assert.equal(existsSync(join(root, "skills/domain-modeling/GLOSSARY-FORMAT.md")), false);
  assert.equal(existsSync(join(root, "skills/references/CHILD-DELEGATION.md")), false);
  assert.equal(existsSync(join(root, "skills/research/agents")), false);
  assert.match(read("regression-test/SKILL.md"), /TDD Bug Fix/);
  assert.match(read("tdd/SKILL.md"), /confirmed seam|confirm.*user/i);
  assert.equal(existsSync(join(root, "skills/wait-what/SKILL.md")), false);
  const before = pocockNames.map(name => read(`${name}/SKILL.md`));
  assert.equal(run().status, 0);
  assert.deepEqual(pocockNames.map(name => read(`${name}/SKILL.md`)), before);
  assert.equal(run("--check").status, 0, run("--check").stderr);
});

pocockCase("11 legacy slash invocations keep links and protect paths", ({ run, input, read }) => {
  const file = input("engineering/implement/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\nUse /tdd and /code-review, /to-spec, /clear. Keep ../research/SKILL.md.\nargument-hint: ignored\n");
  assert.equal(run().status, 0);
  assert.match(read("implement/SKILL.md"), /\[\/skill:tdd\]\(\.\.\/tdd\/SKILL.md\)/);
  assert.match(read("implement/SKILL.md"), /\[\/skill:code-review\]\(\.\.\/code-review\/SKILL.md\)/);
  assert.match(read("implement/SKILL.md"), /\/skill:to-spec, \/new. Keep ..\/research\/SKILL.md/);
  assert.doesNotMatch(read("implement/SKILL.md"), /argument-hint:/);
});

pocockCase("12 dependency closure does not depend on invocation spelling", ({ run, input, rewrite }) => {
  rewrite("engineering/implement/SKILL.md", 'Call the Skill tool with "tdd"', "Use the testing helper");
  const file = input("engineering/research/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + '\nCall the Skill tool with "tdd".\n');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skills\/implement\/SKILL.md.*tdd.*dependency/);
});

pocockCase("13 a final-root install failure restores every old root", ({ root, run }) => {
  assert.equal(run().status, 0);
  const originals = new Map(["LICENSE", "agents/poteto-agent.md", "skills/grilling/SKILL.md"].map(path => {
    const text = readFileSync(join(root, path), "utf8") + "\nold output sentinel\n";
    writeFileSync(join(root, path), text);
    return [path, text];
  }));
  rmSync(join(root, "LICENSE-matt-pocock"));
  const outDir = join(root, "staged");
  generate({ packageDir: root, outDir });
  assert.throws(() => installGenerated({ packageDir: root, outDir, copy: (source, destination, options) => {
    if (destination === join(root, "skills")) {
      mkdirSync(destination);
      writeFileSync(join(destination, "partial"), "incomplete output");
      throw new Error("EIO forced final-root install failure");
    }
    cpSync(source, destination, options);
  } }), /EIO forced final-root install failure/);
  for (const [path, text] of originals) assert.equal(readFileSync(join(root, path), "utf8"), text);
  assert.equal(existsSync(join(root, "skills/partial")), false);
  assert.equal(existsSync(join(root, "LICENSE-matt-pocock")), false);
  assert.equal(existsSync(join(outDir, ".backups")), false);
  installGenerated({ packageDir: root, outDir });
  for (const path of originals.keys()) assert.deepEqual(readFileSync(join(root, path)), readFileSync(join(outDir, path)));
  assert.equal(existsSync(join(root, "LICENSE-matt-pocock")), true);
  assert.equal(existsSync(join(outDir, ".backups")), false);
});

pocockCase("14 failed restoration retains its sentinel at the reported recovery path", ({ root, run }) => {
  assert.equal(run().status, 0);
  const originals = new Map(["LICENSE", "LICENSE-matt-pocock", "agents/poteto-agent.md", "skills/grilling/SKILL.md"].map(path => {
    const text = readFileSync(join(root, path), "utf8") + "\nretained recovery sentinel\n";
    writeFileSync(join(root, path), text);
    return [path, text];
  }));
  const staging = join(root, "staging"), injection = join(root, "fail-install.mjs");
  mkdirSync(staging);
  writeFileSync(injection, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const copy = fs.cpSync, move = fs.renameSync;
fs.cpSync = (source, destination, options) => {
  if (destination === process.env.P3STACK_PACKAGE_DIR + "/skills") throw new Error("EIO forced final-root install failure");
  return copy(source, destination, options);
};
fs.renameSync = (source, destination) => {
  if (source.endsWith("/.backups/skills")) throw new Error("EIO forced restoration failure");
  return move(source, destination);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--import", injection, cli], {
    cwd: root, encoding: "utf8", env: { ...process.env, P3STACK_PACKAGE_DIR: root, TMPDIR: staging },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EIO forced final-root install failure/);
  assert.match(result.stderr, /EIO forced restoration failure/);
  const recovery = /recovery copies retained at (.+)/.exec(result.stderr)?.[1];
  assert.ok(recovery, result.stderr);
  assert.equal(readFileSync(join(recovery, "skills/grilling/SKILL.md"), "utf8"), originals.get("skills/grilling/SKILL.md"));
  for (const [path, text] of originals) if (!path.startsWith("skills/")) assert.equal(readFileSync(join(root, path), "utf8"), text);
  assert.deepEqual(readdirSync(recovery), ["skills"]);
});

pocockCase("13 failed staging preserves the old tree without a shell move", ({ root, run }) => {
  assert.equal(run().status, 0);
  const output = join(root, "blocked");
  writeFileSync(output, "not a directory");
  const before = readFileSync(join(root, "skills/grilling/SKILL.md"));
  assert.throws(() => generate({ packageDir: root, outDir: output }), /ENOTDIR|EEXIST/);
  assert.deepEqual(readFileSync(join(root, "skills/grilling/SKILL.md")), before);
});

pocockCase("14 failed resource validation leaves no recovery step", ({ root, run, input, read }) => {
  assert.equal(run().status, 0);
  const before = read("research/SKILL.md");
  const file = input("engineering/research/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\n[missing](references/missing-report.md)\n");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Referenced resource does not exist/);
  assert.equal(read("research/SKILL.md"), before);
  assert.equal(readdirSync(root).some(name => /backup|sync\./.test(name)), false);
});

pocockCase("15 unknown and extra CLI arguments fail before writing", ({ root, run }) => {
  assert.equal(run("--bogus").status, 2);
  assert.equal(run("--check", "extra").status, 2);
  assert.equal(existsSync(join(root, "skills")), false);
});

pocockCase("16 staged lint rejects unbundled skills in both modes", ({ run, input }) => {
  const file = input("engineering/research/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\n[unbundled](../not-bundled/SKILL.md)\n");
  for (const args of [[], ["--check"]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Referenced resource does not exist/);
  }
});

pocockCase("17 staged lint rejects missing resources in both modes", ({ run, input }) => {
  const file = input("engineering/research/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\n[missing](references/missing-report.md)\n");
  for (const args of [[], ["--check"]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /references\/missing/);
  }
});

pocockCase("staged resource checks keep their source scope", ({ run, root, input }) => {
  const cursorFile = join(root, "vendor/pstack/pstack/skills/bro/SKILL.md");
  writeFileSync(cursorFile, readFileSync(cursorFile, "utf8") + "\n[missing](references/not-bundled.md)\n");
  const cursor = run();
  assert.equal(cursor.status, 0, cursor.stderr);
  const file = input("engineering/research/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\n[missing](references/not-bundled.md)\n");
  const pocock = run();
  assert.equal(pocock.status, 1);
  assert.match(pocock.stderr, /skills\/research.*|Referenced resource does not exist/);
});

pocockCase("18 unavailable staged linter refuses replacement", ({ root, run }) => {
  rmSync(join(root, "../../scripts/lint-skill"));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lint-skill.mjs/);
  assert.equal(existsSync(join(root, "skills")), false);
});

test("{{upstream.commit}} without an upstream checkout fails with the rule that uses it", () => {
  const { root, out, dispose } = fixture({
    "rules/tokens.json": JSON.stringify([{ id: "pinned-link", min: 1, find: "the Task tool", replace: "a child ({{upstream.commit}})" }]),
    "rules/sections.json": "[]",
  });
  try {
    assert.throws(() => generate({ packageDir: root, outDir: out }), /token rule pinned-link: uses \{\{upstream\.commit\}\}/);
  } finally { dispose(); }
});
