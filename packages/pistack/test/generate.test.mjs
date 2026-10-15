import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generate } from "../generator/generate.mjs";

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
