import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gitEnv } from "../generator/git-env.mjs";
import { generate } from "../generator/generate.mjs";

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
  const root = mkdtempSync(join(tmpdir(), "p3stack-update-"));
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
    "package.json": JSON.stringify({ name: "demo", p3stack: { upstream: "unset" } }, null, 2) + "\n",
    "README.md": "# demo\n\nPin: <!-- p3stack:upstream -->unset<!-- /p3stack:upstream -->.\n",
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
  const env = { ...gitEnv(), P3STACK_PACKAGE_DIR: pkg, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
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
    assert.equal(read("README.md"), `# demo\n\nPin: <!-- p3stack:upstream -->\`acme/plugins\` [\`${sha.slice(0, 7)}\`](https://github.com/acme/plugins/tree/${sha}/up), up 1.0.0<!-- /p3stack:upstream -->.\n`);
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
    assert.equal(JSON.parse(read("package.json")).p3stack.upstream, `acme/plugins@${tip} up 1.1.0`);
    assert.match(read("README.md"), new RegExp(`\\[\`${tip.slice(0, 7)}\`\\]\\(https://github.com/acme/plugins/tree/${tip}/up\\), up 1\\.1\\.0`));
    assert.equal(run(generateCli, "--check").status, 0);
    assert.match(run(updateCli).stdout, /already at/);
  } finally { dispose(); }
});

test("update reports emitted, excluded and unmapped source changes without including other plugins", () => {
  const { pkg, run, commit, dispose } = fixture();
  try {
    const manifestPath = join(pkg, "rules/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.exclude = ["^skills/omitted/"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    commit({
      "up/skills/added/SKILL.md": "# Added\n",
      "up/skills/omitted/SKILL.md": "# Omitted\n",
      "up/docs/harness/adapter.md": "# Other harness\n",
      "up/README.md": "# Upstream install\n",
      "other/new.md": "Another plugin.\n",
    }, "add source and packaging");
    const result = run(updateCli);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /A up\/skills\/added\/SKILL\.md -> skills\/added\/SKILL\.md/);
    assert.match(result.stdout, /A up\/skills\/omitted\/SKILL\.md \(excluded\)/);
    assert.match(result.stdout, /A up\/docs\/harness\/adapter\.md \(not emitted; review scope\)/);
    assert.match(result.stdout, /A up\/README\.md \(not emitted; review scope\)/);
    assert.doesNotMatch(result.stdout, /other\/new\.md/);
    assert.match(result.stdout, /full upstream commits.*outside up\//);
    assert.doesNotMatch(run(updateCli).stdout, /Changed upstream source paths/);
  } finally { dispose(); }
});

test("the scope report includes both sides of a rename and handles explicit older pins", () => {
  const { pkg, origin, run, head, dispose } = fixture();
  try {
    const first = head();
    git(origin, "mv", "up/skills/demo", "up/skills/renamed");
    git(origin, "commit", "-qm", "rename demo");
    const result = run(updateCli);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /D up\/skills\/demo\/SKILL\.md -> skills\/demo\/SKILL\.md/);
    assert.match(result.stdout, /A up\/skills\/renamed\/SKILL\.md -> skills\/renamed\/SKILL\.md/);
    assert.equal(readFileSync(join(pkg, "skills/renamed/SKILL.md"), "utf8").startsWith("# Demo"), true);
    const rollback = run(updateCli, first);
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(head(), first);
    assert.match(rollback.stdout, /not a descendant/);
    assert.match(rollback.stdout, /A up\/skills\/demo\/SKILL\.md/);
    assert.match(rollback.stdout, /D up\/skills\/renamed\/SKILL\.md/);
    assert.equal(run(generateCli, "--check").status, 0);
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

for (const [state, dirty] of Object.entries({
  modified: checkout => write(checkout, { "up/skills/demo/SKILL.md": "# Demo\n\nUse the Task tool twice. See [guide](../../docs/guide/01.md).\n" }),
  staged: checkout => { write(checkout, { "up/skills/demo/SKILL.md": "# Demo\n\nUse the Task tool twice. See [guide](../../docs/guide/01.md).\n" }); git(checkout, "add", "."); },
  untracked: checkout => write(checkout, { "up/skills/demo/local.md": "Local input.\n" }),
  ignored: checkout => {
    write(checkout, { ".git/info/exclude": "up/skills/demo/local.md\n", "up/skills/demo/local.md": "Local input.\n" });
    assert.equal(git(checkout, "check-ignore", "up/skills/demo/local.md"), "up/skills/demo/local.md");
  },
  "mode with core.fileMode=false": checkout => {
    git(checkout, "config", "core.fileMode", "false");
    chmodSync(join(checkout, "up/skills/demo/SKILL.md"), 0o755);
    assert.equal(git(checkout, "status", "--porcelain"), "");
  },
  metadata: checkout => write(checkout, { "up/plugin.json": JSON.stringify({ name: "up", version: "9.0.0" }) }),
  deleted: checkout => rmSync(join(checkout, "up/plugin.json")),
  "skip-worktree": checkout => {
    git(checkout, "update-index", "--skip-worktree", "up/skills/demo/SKILL.md");
    write(checkout, { "up/skills/demo/SKILL.md": "# Hidden input.\n" });
    assert.equal(git(checkout, "status", "--porcelain"), "");
  },
  "assume-unchanged": checkout => {
    git(checkout, "update-index", "--assume-unchanged", "up/skills/demo/SKILL.md");
    write(checkout, { "up/skills/demo/SKILL.md": "# Hidden input.\n" });
    assert.equal(git(checkout, "status", "--porcelain"), "");
  },
})) {
  test(`generation refuses ${state} upstream content without writing outputs or pins`, () => {
    const { root, pkg, run, read, dispose } = fixture();
    try {
      const checkout = join(pkg, "vendor/up");
      const paths = ["skills/demo/SKILL.md", "package.json", "README.md"];
      const before = paths.map(read);
      dirty(checkout);
      for (const args of [[], ["--check"]]) {
        const result = run(generateCli, ...args);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /vendor\/up has local changes/);
        assert.deepEqual(paths.map(read), before);
        assert.equal(existsSync(join(pkg, "skills/demo/local.md")), false);
      }
      const outDir = join(root, "candidate");
      assert.throws(() => generate({ packageDir: pkg, outDir }), /vendor\/up has local changes/);
      assert.equal(existsSync(outDir), false);
      write(outDir, { "sentinel.md": "Keep me.\n" });
      assert.throws(() => generate({ packageDir: pkg, outDir }), /vendor\/up has local changes/);
      assert.equal(readFileSync(join(outDir, "sentinel.md"), "utf8"), "Keep me.\n");
      git(checkout, "update-index", "--no-skip-worktree", "up/skills/demo/SKILL.md");
      git(checkout, "update-index", "--no-assume-unchanged", "up/skills/demo/SKILL.md");
      git(checkout, "config", "core.fileMode", "true");
      git(checkout, "reset", "--hard", "HEAD");
      rmSync(join(checkout, "up/skills/demo/local.md"), { force: true });
      assert.equal(run(generateCli, "--check").status, 0, "clean input works again without pin or rule edits");
    } finally { dispose(); }
  });
}

test("direct generation ignores local changes outside the consumed upstream subtree", () => {
  const { pkg, run, read, dispose } = fixture();
  try {
    const before = read("skills/demo/SKILL.md");
    write(join(pkg, "vendor/up"), { "other/README.md": "Local unrelated edit.\n", "other/local.md": "Local unrelated file.\n" });
    assert.equal(run(generateCli).status, 0);
    assert.equal(run(generateCli, "--check").status, 0);
    assert.equal(read("skills/demo/SKILL.md"), before);
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
