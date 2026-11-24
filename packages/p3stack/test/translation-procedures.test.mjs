import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../generator/git-env.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(pkg, path), "utf8");
const playbook = name => read(`skills/poteto-mode/playbooks/${name}.md`);
const skill = name => read(`skills/${name}/SKILL.md`);
const audit = join(pkg, "skills/poteto-mode/scripts/worktree-audit.sh");

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p3stack-procedures-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function auditFixture(t, name = "worker") {
  const root = scratch(t), repo = join(root, "main tree"), wt = join(root, name);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // No real forge, remote, session history, global config or hooks.
  for (const tool of ["origin", "gh"]) writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = gitEnv({ ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: "",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=test@example.org", "commit", "-qm", "base");
  git("-C", repo, "worktree", "add", "--detach", wt, "HEAD");
  function rows() {
    const result = execFileSync("bash", [audit, "-b", "main", repo], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return result.trimEnd().split("\n").slice(2).map(line => line.split("\t"));
  }
  return { repo, wt, env, git, rows };
}

test("audit preserves whole worktree paths and omits the main checkout", t => {
  const { wt, rows } = auditFixture(t, "worker with spaces");
  assert.deepEqual(rows().map(row => [row[8], row[7]]), [[wt, "safe"]]);
});

for (const [file, description] of [["new-module.ts", "only copy of new source"], ["build/output", "ignored build output"]]) {
  test(`audit holds ${description}, even when user settings hide untracked files`, t => {
    const { wt, git, rows } = auditFixture(t);
    git("-C", wt, "config", "status.showUntrackedFiles", "no");
    mkdirSync(join(wt, "build"));
    writeFileSync(join(wt, file), "only copy\n");
    assert.equal(rows()[0][7], "hold-untracked");
  });
}

test("a failed status inspection cannot make a merged worktree safe", t => {
  const { wt, git, rows } = auditFixture(t);
  writeFileSync(join(git("-C", wt, "rev-parse", "--absolute-git-dir"), "index"), "broken index");
  assert.equal(rows()[0][7], "unknown");
});

test("a recent Pi session started in a worktree subdirectory holds the worktree", t => {
  const { wt, env, rows } = auditFixture(t);
  const cwd = join(wt, "src");
  mkdirSync(cwd);
  const dir = join(env.PI_CODING_AGENT_DIR, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ type: "session", cwd }) + "\n");
  assert.equal(rows()[0][7], "verify-recent-chat");
});

test("audit help discloses the fetch rather than promising a read-only operation", () => {
  const help = execFileSync("bash", [audit, "--help"], { encoding: "utf8" });
  assert.match(help, /fetch/i);
  assert.doesNotMatch(help, /read-only/i);
});

test("cleanup requires approval for the named non-versioned files and holds unknown owners", () => {
  const text = playbook("worktree-cleanup");
  assert.match(text, /hold-untracked/);
  assert.match(text, /list[^\n]*untracked[^\n]*ignored[^\n]*operator[^\n]*approv/i);
  assert.match(text, /owner you cannot establish counts as in use/);
  assert.doesNotMatch(text, /throwaway|rm -rf|remove --force|delete all/i);
});

test("PR delivery has an explicit trigger and never resets a checkout between children", () => {
  const text = playbook("opening-a-pr");
  assert.match(text, /request.*playbook.*delivery step/i);
  assert.match(text, /never after a read-only investigation, review, design or plan/i);
  assert.doesNotMatch(text, /end of every other playbook|reset --hard|reset from main/);
});

test("the plan records installed paths for briefs and reserves git show for project files", () => {
  const plan = playbook("multi-phase-plan");
  assert.doesNotMatch(plan, /pstack\/skills\/|execution playbook from trunk/);
  assert.match(plan, /absolute installed path/i);
  assert.match(plan, /brief[^\n]*recorded path|recorded path[^\n]*brief/i);
  assert.match(plan, /project-owned[^\n]*git show <[^>]+>:<[^>]+>/i);
});

for (const mode of ["autopilot-full", "autopilot-stack"]) {
  test(`${mode} reads the installed execution playbook on every tick`, () => {
    assert.match(playbook(mode), /tick[^\n]*installed path[^\n]*plan/i);
    assert.doesNotMatch(playbook(mode), /playbook from trunk/);
  });
}

test("plan checker accepts installed files outside the consumer repo, not missing files or trunk markers", t => {
  const cwd = scratch(t), file = join(cwd, "plan.md");
  const skeleton = playbook("multi-phase-plan").split("````markdown\n")[1].split("\n````")[0]
    .replace("<swarm workers model>", "test-model");
  const check = pointer => {
    const arm = `### Arm the program\n- [ ] Installed file. \`${pointer}\`\n`;
    writeFileSync(file, skeleton.replace(/### Arm the program\n[\s\S]*?(?=- \[ \] On the operator's go)/, arm));
    return spawnSync(process.execPath, [join(pkg, "skills/poteto-mode/scripts/check-plan.mjs"), file], { cwd, encoding: "utf8" });
  };
  const ok = check(join(pkg, "skills/swarm/SKILL.md"));
  assert.equal(ok.status, 0, ok.stderr);
  for (const pointer of ["git show origin/main:pstack/skills/swarm/SKILL.md", join(cwd, "absent.md")]) {
    const bad = check(pointer);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /installed file/i);
  }
});

for (const name of ["swarm", "arena"]) {
  test(`${name} covers the full assignment within the live-child limit`, () => {
    const fanOut = skill(name).split("## Phase B: Fan out")[1].split("## Phase C")[0];
    assert.match(fanOut, /every (?:slice|candidate)/i);
    assert.match(fanOut, /waves[^\n]*live-child limit/i);
    assert.match(fanOut, /close[^\n]*before[^\n]*next/i);
    assert.doesNotMatch(fanOut, /all N .* at once/);
  });
}

test("recall gives each child scoped history IDs, not a second discovery algorithm", () => {
  const recall = skill("recall");
  assert.match(recall, /Session history[^\n]*host-capabilities\.md/);
  assert.match(recall, /in-scope session or thread IDs/i);
  assert.doesNotMatch(recall, /~\/\.pi\/agent\/sessions\/|ls -t|chat UUID/);
});

const reviews = ["thermo-nuclear-review", "thermo-nuclear-code-quality-review"];
for (const name of ["thermos", "dyl-review"]) {
  test(`${name} briefs both read-only thermo passes with the installed recipes and rubrics`, () => {
    const text = skill(name);
    for (const review of reviews) {
      assert.ok(text.includes(`(../../agents/${review}-subagent.md)`), review + " recipe");
      assert.ok(text.includes(`(../${review}/SKILL.md)`), review + " rubric");
    }
    assert.doesNotMatch(text, /Thermos plugin/);
  });
}

for (const name of reviews) {
  test(`${name} recipe points to the rubric it uses without a plugin or child forge call`, () => {
    const text = read(`agents/${name}-subagent.md`);
    assert.ok(text.includes(`(../skills/${name}/SKILL.md)`));
    assert.doesNotMatch(text, /Thermos plugin|Invoked delegated child|use `gh` or `glab`/);
  });
}

test("dyl-review keeps code-review coordination and Git/forge work in the parent", () => {
  const text = skill("dyl-review");
  assert.match(text, /parent[^\n]*Standards[^\n]*Spec/i);
  const worker = text.split("## Dylan-lens worker")[1].split("## Synthesis")[0];
  assert.doesNotMatch(worker, /`(?:gh|git|origin) /);
  assert.match(worker, /title and body[^\n]*(?:parent|main thread)/i);
  assert.doesNotMatch(text, /child running \[code-review\]|code-review child|every worker the depth calls for in one message/);
});

test("Pi help starts at the persistent router and distinguishes an explicit standalone skill", () => {
  const help = skill("poteto-help");
  for (const command of ["/p3stack on`", "/p3stack on autonomous`", "/p3stack off`", "/skill:<name>"]) assert.ok(help.includes(command), command);
  assert.match(help, /model-visible skills[^\n]*router (?:is )?off/i);
  assert.match(help, /\.\.\/p3stack-mode\/references\/routes\.md/);
  assert.doesNotMatch(help, /start(?:ing)? each (?:new )?task with|Only `[^\n]*setup-pstack` loads|lists every playbook|default answer is `\/skill:poteto-mode/i);
});

test("copyable help recipes can be sent after enabling the Pi router", () => {
  const recipes = read("skills/poteto-help/references/recipes.md");
  assert.match(recipes, /\/p3stack on/);
  assert.doesNotMatch(recipes, /`\/skill:poteto-mode /);
});

test("tracker setup selects the first instruction file Pi loads", () => {
  const write = skill("setup-matt-pocock-skills").split("**Pick the file to edit:**")[1].split("If an `## Agent skills`")[0];
  const names = [...write.matchAll(/`((?:AGENTS|CLAUDE)(?:\.override)?\.(?:md|MD))`/g)].map(m => m[1]);
  assert.deepEqual(names.slice(0, 5), ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
});

test("the migration step names both exact old-to-new moves; other steps depend only on the new names", () => {
  const setup = skill("setup-matt-pocock-skills");
  const migration = setup.split("\n").find(line => line.includes("legacy domain glossary"));
  const operands = [...migration.matchAll(/`git mv -- (\{[A-Z]+,[A-Z]+\}[-A-Z.]*md)`/g)];
  // Expand only literal brace pairs, never run commands from the document.
  assert.deepEqual(operands.map(([, pair]) => execFileSync("bash", ["-c", 'printf "%s\\n" ' + pair], { encoding: "utf8" }).trim().split("\n")), [
    ["CONTEXT.md", "GLOSSARY.md"], ["CONTEXT-MAP.md", "GLOSSARY-MAP.md"],
  ]);
  assert.doesNotMatch(setup.replace(migration, ""), /CONTEXT/);
});
