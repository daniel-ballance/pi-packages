import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generate, sectionHash } from "../generator/generate.mjs";
import { gitEnv } from "../generator/git-env.mjs";

const cli = fileURLToPath(new URL("../generator/generate.mjs", import.meta.url));

// A miniature package: an upstream tree under vendor/ plus the hand-written rules.
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "pistack-generate-"));
  const defaults = {
    "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\nicon: crown\n---\n\n# Demo\n\nUse the Task tool.\n\n## Subagents\n\nCursor-only text.\n\n## Next\n\nKept.\n",
    "vendor/up/skills/demo/scripts/run.sh": "echo hi\n",
    "vendor/up/README.md": "Not emitted.\n",
    "vendor/up/LICENSE": "MIT\n",
    "rules/manifest.json": JSON.stringify({
      vendor: "vendor/up",
      map: [{ from: "skills/", to: "skills/" }, { from: "LICENSE", to: "LICENSE" }],
      exclude: [],
    }),
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
    "rules/manifest.json": JSON.stringify({ vendor: "vendor/up", map: [{ from: "skills/", to: "skills/" }, { from: "agents/", to: "agents/" }], exclude: ["^skills/omitted/"] }),
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
    "rules/manifest.json": JSON.stringify({ vendor: "vendor/up", map: [{ from: "agents/", to: "agents/" }] }),
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

test("a section ends at the next heading of the same or a higher level", () => {
  const { root, out, read, dispose } = fixture({
    "vendor/up/skills/demo/SKILL.md": "---\nname: Demo\n---\n\nUse the Task tool.\n\n## Subagents\n\nCursor.\n\n### Detail\n\nCursor too.\n\n# Top\n\nKept.\n",
    "rules/sections.json": JSON.stringify([{ file: "skills/demo/SKILL.md", heading: "## Subagents", overlay: "demo/subagents.md", upstream: "82da502595ac" }]),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(read("skills/demo/SKILL.md"), "---\nname: demo\n---\n\nUse a child.\n\n## Subagents\n\nPi delegation.\n\n# Top\n\nKept.\n");
  } finally { dispose(); }
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
    "rules/manifest.json": JSON.stringify({ vendor: "vendor/up", map: [{ from: "skills/", to: "skills/" }], exclude: ["^skills/demo/scripts/"] }),
  });
  try {
    generate({ packageDir: root, outDir: out });
    assert.equal(existsSync(join(out, "skills/demo/scripts/run.sh")), false);
  } finally { dispose(); }
});

test("check mode reports drift in generated outputs without writing, and sync repairs it", () => {
  const { root, dispose } = fixture({});
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PISTACK_PACKAGE_DIR: root } });
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
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PISTACK_PACKAGE_DIR: root } });
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
    "package.json": JSON.stringify({ name: "demo", pistack: { upstream: "stale" } }, null, 2) + "\n",
    "rules/manifest.json": JSON.stringify({ vendor: "vendor/up", upstream: { repository: "acme/plugins", checkout: "vendor/up" }, map: [{ from: "skills/", to: "skills/" }], exclude: [] }),
  });
  const git = (...args) => spawnSync("git", ["-C", join(root, "vendor/up"), ...args], { encoding: "utf8", env: gitEnv() });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PISTACK_PACKAGE_DIR: root } });
  try {
    git("init", "-q"); git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pistack.upstream, `acme/plugins@${sha} up 1.2.3`);
    assert.equal(run("--check").status, 0);
    writeFileSync(join(root, "vendor/up/plugin.json"), JSON.stringify({ name: "up", version: "1.2.4" }));
    const drift = run("--check");
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /package\.json pistack\.upstream/);
  } finally { dispose(); }
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
