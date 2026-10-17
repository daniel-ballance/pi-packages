import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gitEnv } from "../generator/git-env.mjs";

const generateCli = fileURLToPath(new URL("../generator/generate.mjs", import.meta.url));
const updateCli = fileURLToPath(new URL("../generator/update-upstream.mjs", import.meta.url));

const identity = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"];
const git = (cwd, ...args) => execFileSync("git", [...identity, "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).trim();

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// An upstream repository, and a package whose vendor/up checkout clones it,
// generated once at the first upstream commit.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pistack-update-"));
  const origin = join(root, "origin"), pkg = join(root, "pkg");
  mkdirSync(origin);
  git(origin, "init", "-q");
  write(origin, {
    "up/plugin.json": JSON.stringify({ name: "up", version: "1.0.0" }),
    "up/skills/demo/SKILL.md": "# Demo\n\nUse the Task tool. See [guide](../../docs/guide/01.md).\n",
    "other/README.md": "Not ours.\n",
  });
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "first");
  write(pkg, {
    "package.json": JSON.stringify({ name: "demo", pistack: { upstream: "unset" } }, null, 2) + "\n",
    "README.md": "# demo\n\nPin: <!-- pistack:upstream -->unset<!-- /pistack:upstream -->.\n",
    "rules/manifest.json": JSON.stringify({
      vendor: "vendor/up/up",
      upstream: { repository: "acme/plugins", checkout: "vendor/up", branch: "main" },
      map: [{ from: "skills/", to: "skills/" }],
      exclude: [],
    }),
    "rules/tokens.json": JSON.stringify([
      { id: "task-tool", min: 1, find: "the Task tool", replace: "a child" },
      { id: "guide", min: 1, find: "\\]\\((?:\\.\\./)+docs/guide/([^)]+)\\)", replace: "](https://example.test/{{upstream.commit}}/$1)" },
    ]),
  });
  git(root, "clone", "-q", origin, join(pkg, "vendor/up"));
  const env = { ...gitEnv(), PISTACK_PACKAGE_DIR: pkg, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
  const run = (cli, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd: pkg, encoding: "utf8", env });
  assert.equal(run(generateCli).status, 0);
  const commit = (files, message) => { write(origin, files); git(origin, "add", "."); git(origin, "commit", "-qm", message); return git(origin, "rev-parse", "HEAD"); };
  const read = path => readFileSync(join(pkg, path), "utf8");
  return { root, pkg, origin, run, commit, read, head: () => git(join(pkg, "vendor/up"), "rev-parse", "HEAD"), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("the pinned commit fills {{upstream.commit}} in rules and the README pin markers", () => {
  const { read, head, dispose } = fixture();
  try {
    const sha = head();
    assert.equal(read("skills/demo/SKILL.md"), `# Demo\n\nUse a child. See [guide](https://example.test/${sha}/01.md).\n`);
    assert.equal(read("README.md"), `# demo\n\nPin: <!-- pistack:upstream -->\`acme/plugins\` [\`${sha.slice(0, 7)}\`](https://github.com/acme/plugins/tree/${sha}/up), up 1.0.0<!-- /pistack:upstream -->.\n`);
  } finally { dispose(); }
});

test("update moves the checkout to the upstream tip, lists its commits and regenerates everything the pin touches", () => {
  const { run, commit, read, head, dispose } = fixture();
  try {
    commit({ "other/README.md": "Still not ours.\n" }, "unrelated");
    const tip = commit({ "up/plugin.json": JSON.stringify({ name: "up", version: "1.1.0" }), "up/skills/demo/SKILL.md": "# Demo\n\nUse the Task tool twice. See [guide](../../docs/guide/02.md).\n" }, "reword demo");
    const result = run(updateCli);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(head(), tip);
    assert.match(result.stdout, /reword demo/);
    assert.doesNotMatch(result.stdout, /unrelated/, "only commits to the emitted subtree are listed");
    assert.equal(read("skills/demo/SKILL.md"), `# Demo\n\nUse a child twice. See [guide](https://example.test/${tip}/02.md).\n`);
    assert.equal(JSON.parse(read("package.json")).pistack.upstream, `acme/plugins@${tip} up 1.1.0`);
    assert.match(read("README.md"), new RegExp(`\\[\`${tip.slice(0, 7)}\`\\]\\(https://github.com/acme/plugins/tree/${tip}/up\\), up 1\\.1\\.0`));
    assert.equal(run(generateCli, "--check").status, 0);
    assert.match(run(updateCli).stdout, /already at/);
  } finally { dispose(); }
});

test("when upstream deletes a rule's text, update fails naming the rule and leaves the checkout at the new commit", () => {
  const { run, commit, read, head, dispose } = fixture();
  try {
    const before = read("skills/demo/SKILL.md");
    const tip = commit({ "up/skills/demo/SKILL.md": "# Demo\n\nSee [guide](../../docs/guide/01.md).\n" }, "cut task tool");
    const result = run(updateCli);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /token rule task-tool: 0 matches/);
    assert.equal(head(), tip);
    assert.equal(read("skills/demo/SKILL.md"), before, "a failed generation writes nothing");
    assert.equal(run(generateCli, "--check").status, 1, "the check stays red until the rule is fixed");
  } finally { dispose(); }
});

test("update refuses a checkout with local changes, and an unknown ref", () => {
  const { pkg, run, head, dispose } = fixture();
  try {
    const sha = head();
    assert.match(run(updateCli, "no-such-ref").stderr, /no-such-ref: not a commit/);
    writeFileSync(join(pkg, "vendor/up/up/skills/demo/SKILL.md"), "edited\n");
    const dirty = run(updateCli);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /local changes/);
    assert.equal(head(), sha);
  } finally { dispose(); }
});

test("a README whose pin markers are stale fails the check", () => {
  const { pkg, run, dispose } = fixture();
  try {
    const readme = join(pkg, "README.md");
    writeFileSync(readme, readFileSync(readme, "utf8").replace(/up 1\.0\.0/, "up 0.9.0"));
    const drift = run(generateCli, "--check");
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /README\.md: the upstream pin/);
  } finally { dispose(); }
});
