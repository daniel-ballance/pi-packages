import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  writeFileSync(join(repo, ".gitignore"), "node_modules/\nbuild output/\n.env\n*.log\n");
  git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=test@example.org", "commit", "-qm", "base");
  git("-C", repo, "worktree", "add", "--detach", wt, "HEAD");
  function rows(...args) {
    const result = execFileSync("bash", [audit, "-b", "main", ...args, repo], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return result.trimEnd().split("\n").slice(2).map(line => line.split("\t"));
  }
  return { repo, wt, env, git, rows };
}

test("audit preserves whole worktree paths and omits the main checkout", t => {
  const { wt, rows } = auditFixture(t, "worker with spaces");
  assert.deepEqual(rows().map(row => [row[8], row[7]]), [[wt, "safe"]]);
});

test("audit inspects the named worktree, not the caller's Git directory and index", t => {
  const { repo, wt, env, rows } = auditFixture(t);
  Object.assign(env, { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(repo, ".git/index") });
  writeFileSync(join(wt, "new.ts"), "only copy");
  assert.equal(rows()[0][7], "hold-untracked");
});

test("a missing gitfile must not fall back to an enclosing checkout", t => {
  const { wt, rows } = auditFixture(t, "main tree/nested");
  rmSync(join(wt, ".git"));
  assert.equal(rows()[0][7], "unknown");
});

for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
  test(`audit holds index paths marked ${flag}`, t => {
    const { wt, git, rows } = auditFixture(t);
    git("-C", wt, "update-index", flag, ".gitignore");
    writeFileSync(join(wt, ".gitignore"), "hidden edit");
    const row = rows()[0];
    assert.equal(row[7], "hold-wip");
    assert.doesNotMatch(row[3], /clean/);
  });
}

for (const [files, bucket, ignoredDirs] of [
  [["new-module.ts"], "hold-untracked", 0],
  [[".env"], "hold-ignored", 0],
  [["node_modules/pkg/a", "node_modules/pkg/b"], "safe", 1],
  [["build output/a"], "safe", 1],
  [["logs/stray.log", "new-module.ts", "node_modules/lib"], "hold-ignored", 1],
]) {
  test(`audit rates ${files.join(", ")} even when user settings hide untracked files`, t => {
    const { wt, git, rows } = auditFixture(t);
    git("-C", wt, "config", "status.showUntrackedFiles", "no");
    for (const file of files) {
      mkdirSync(dirname(join(wt, file)), { recursive: true });
      writeFileSync(join(wt, file), "only copy\n");
    }
    const row = rows()[0];
    assert.equal(row[7], bucket);
    assert.match(row[3], new RegExp(`ignored-dirs:${ignoredDirs}\\b`));
  });
}

test("a failed status inspection cannot make a merged worktree safe", t => {
  const { wt, git, rows } = auditFixture(t);
  writeFileSync(join(git("-C", wt, "rev-parse", "--absolute-git-dir"), "index"), "broken index");
  assert.equal(rows()[0][7], "unknown");
});

test("a recent Pi session started in a worktree subdirectory holds the worktree without a forge or jq", t => {
  const { wt, env, rows } = auditFixture(t);
  const cwd = join(wt, "src");
  mkdirSync(cwd);
  writeFileSync(join(env.HOME, "bin/jq"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const dir = join(env.PI_CODING_AGENT_DIR, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ type: "session", cwd }) + "\n");
  assert.equal(rows()[0][7], "verify-recent-chat");
});

for (const source of ["main subdirectory", "settings", "settings in tilde agent directory", "argument", "uninspectable custom directory"]) {
  test(`session inventory: ${source}`, t => {
    const { repo, wt, env, rows } = auditFixture(t);
    const cwd = join(repo, "packages"), agent = env.PI_CODING_AGENT_DIR, custom = join(env.HOME, "custom sessions");
    mkdirSync(cwd); mkdirSync(agent);
    const args = [];
    let dir = custom;
    if (source === "main subdirectory") dir = join(agent, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
    if (source.startsWith("settings")) {
      if (source.includes("tilde")) env.PI_CODING_AGENT_DIR = "~/agent";
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ sessionDir: "~/custom sessions" }));
    }
    if (source === "argument") args.push("--session-dir", custom);
    if (source === "uninspectable custom directory") {
      env.PI_CODING_AGENT_SESSION_DIR = custom;
      assert.equal(rows()[0][7], "unknown");
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), [ { type: "session", cwd }, { type: "message", path: join(wt, ".gitignore") } ].map(x => JSON.stringify(x)).join("\n"));
    assert.equal(rows(...args)[0][7], "verify-recent-chat");
  });
}

test("moving session storage does not hide earlier activity in the default directory", t => {
  const { wt, env, rows } = auditFixture(t);
  const dir = join(env.PI_CODING_AGENT_DIR, "sessions", `--${wt.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ type: "session", cwd: wt }) + "\n");
  env.PI_CODING_AGENT_SESSION_DIR = join(env.HOME, "moved sessions");
  mkdirSync(env.PI_CODING_AGENT_SESSION_DIR);
  assert.equal(rows()[0][7], "verify-recent-chat");
});

test("audit help discloses the fetch rather than promising a read-only operation", () => {
  const help = execFileSync("bash", [audit, "--help"], { encoding: "utf8" });
  assert.match(help, /fetch/i);
  assert.doesNotMatch(help, /read-only/i);
});

test("cleanup requires approval for the named non-versioned files and holds unknown owners", () => {
  const text = playbook("worktree-cleanup");
  const list = text.split("\n").find(line => line.startsWith("4."));
  const remove = text.split("\n").find(line => line.startsWith("5."));
  for (const bucket of ["hold-untracked", "hold-ignored"]) {
    assert.ok(list.includes(bucket));
    assert.ok(remove.includes(bucket));
  }
  assert.match(list, /list[^\n]*untracked[^\n]*ignored[^\n]*--ignored=matching/i);
  assert.match(remove, /operator[^\n]*approv[^\n]*worktree paths[^\n]*named files/i);
  assert.match(text, /owner you cannot establish counts as in use/);
  assert.doesNotMatch(text, /throwaway|rm -rf|remove --force|delete all/i);
});

test("PR delivery has an explicit trigger and never resets a checkout between children", () => {
  const text = playbook("opening-a-pr");
  assert.match(text, /request.*playbook.*delivery step/i);
  assert.match(text, /never after a read-only investigation, review, design or plan/i);
  assert.doesNotMatch(text, /end of every other playbook|reset --hard|reset from main/);
});

test("the coordinator records installed paths; T3 briefs travel without that installation", () => {
  const plan = playbook("multi-phase-plan");
  assert.doesNotMatch(plan, /pstack\/skills\/|execution playbook from trunk/);
  assert.match(plan, /absolute installed path/i);
  for (const doc of [plan, playbook("autopilot-full"), read("skills/dyl-review/references/thermos.md"), skill("dyl-review")]) {
    assert.match(doc, /T3[^\n]*inline[^\n]*commit/i);
    assert.doesNotMatch(doc, /Give each worker (?:its paths|the relevant recorded paths)/);
  }
  assert.doesNotMatch(plan, /per the \[poteto-agent recipe\]|git fetch origin <head-branch> && git checkout|\/tmp\/swarm-/);
  assert.match(plan, /project-owned[^\n]*git show <[^>]+>:<[^>]+>/i);
});

for (const mode of ["autopilot-full", "autopilot-stack"]) {
  test(`${mode} reads the installed execution playbook on every tick`, () => {
    assert.match(playbook(mode), /tick[^\n]*installed path[^\n]*plan/i);
    assert.doesNotMatch(playbook(mode), /playbook from trunk/);
  });
}

test("Autopilot opens the ledger before owner dispatch and sets the floor before swarm dispatch", () => {
  const run = playbook("autopilot-full");
  for (const [precondition, dispatch] of [["[execution-ledger]", "**Spawn one owner"], ["[floor]", "**Swarm-verify once"]]) {
    assert.ok(run.indexOf(precondition) >= 0 && run.indexOf(precondition) < run.indexOf(dispatch));
  }
  assert.match(playbook("orchestrate"), /notes\.md[^\n]*run directory/i);
});

test("plan checker accepts installed files outside the consumer repo, not missing files or trunk markers", t => {
  const cwd = scratch(t), file = join(cwd, "plan.md");
  const skeleton = playbook("multi-phase-plan").split("````markdown\n")[1].split("\n````")[0]
    .replace("<swarm workers model>", "test-model");
  const skills = join(pkg, "skills"), fixed = [join(skills, "swarm/SKILL.md"), join(skills, "poteto-mode/playbooks/opening-a-pr.md")];
  const execution = mode => join(skills, "poteto-mode/playbooks", mode + ".md");
  const check = (pointers, mode = "autopilot-stack", elsewhere = []) => {
    const boxes = paths => paths.map(path => `- [ ] Installed file. \`${path}\``).join("\n");
    const plan = skeleton.replace("<execution playbook>", mode)
      .replace(/### Arm the program\n[\s\S]*?(?=- \[ \] On the operator's go)/, "### Arm the program\n" + boxes(pointers) + "\n")
      .replace("### Spawn owners", "### Spawn owners\n" + boxes(elsewhere));
    writeFileSync(file, plan);
    return spawnSync(process.execPath, [join(pkg, "skills/poteto-mode/scripts/check-plan.mjs"), file], { cwd, encoding: "utf8" });
  };
  for (const mode of ["autopilot-stack", "autopilot-full", "orchestrate"]) {
    const ok = check([execution(mode), ...fixed], mode);
    assert.equal(ok.status, 0, ok.stderr);
  }
  const required = [execution("autopilot-stack"), ...fixed];
  for (const pointers of [[file], fixed, [execution("autopilot-full"), ...fixed],
    [required[0], fixed[0], fixed[0]], [required[0], fixed[1]], [...required, join(cwd, "absent.md")],
    [...required, "git show origin/main:pstack/skills/swarm/SKILL.md"]]) {
    const bad = check(pointers);
    assert.equal(bad.status, 1, JSON.stringify(pointers));
    assert.match(bad.stderr, /installed file/i);
  }
  assert.equal(check(fixed, "autopilot-stack", [required[0]]).status, 1, "outside Arm the program");
});

for (const name of ["swarm", "arena"]) {
  test(`${name} covers the full assignment within the live-child limit`, () => {
    const fanOut = skill(name).split("## Phase B: Fan out")[1].split("## Phase C")[0];
    assert.match(fanOut, /every (?:slice|candidate)/i);
    assert.match(fanOut, /waves[^\n]*live-child limit/i);
    assert.match(fanOut, /collect each wave and free its capacity as the host requires/i);
    assert.doesNotMatch(fanOut, /close each wave/i);
    assert.doesNotMatch(fanOut, /all N .* at once/);
  });
}

test("playbooks and standalone skills resolve roles through the same Subagents section", () => {
  for (const doc of [playbook("feature"), playbook("bug-fix"), skill("how"), skill("swarm")]) {
    assert.match(doc, /resolve each subagent's role per the Subagents section/i);
    assert.doesNotMatch(doc, /pick each subagent's reasoning level/i);
  }
});

test("recall gives each child scoped history IDs, not a second discovery algorithm", () => {
  const recall = skill("recall");
  assert.match(recall, /Session history[^\n]*host-capabilities\.md/);
  assert.match(recall, /in-scope session or thread IDs/i);
  assert.doesNotMatch(recall, /~\/\.pi\/agent\/sessions\/|ls -t|chat UUID/);
});

const reviews = ["thermo-nuclear-review", "thermo-nuclear-code-quality-review"];
for (const name of ["thermos", "dyl-review"]) {
  test(`${name} briefs both read-only thermo passes with the installed recipes and rubrics`, () => {
    const text = name === "dyl-review" ? skill(name) : read("skills/dyl-review/references/thermos.md");
    for (const review of reviews) {
      assert.ok(text.includes(`(../../agents/${review}-subagent.md)`), review + " recipe");
      assert.ok(text.includes(`(${name === "thermos" ? "../dyl-review/" : ""}references/${review}.md)`), review + " rubric");
    }
    assert.doesNotMatch(text, /Thermos plugin/);
  });
}

for (const name of reviews) {
  test(`${name} recipe points to the rubric it uses without a plugin or child forge call`, () => {
    const text = read(`agents/${name}-subagent.md`);
    assert.ok(text.includes(`(../skills/dyl-review/references/${name}.md)`));
    assert.match(text, /child[^\n]*skip this section/i);
    assert.doesNotMatch(text, /Thermos plugin|Invoked delegated child|use `gh` or `glab`/);
  });
}

test("the correctness pass uses the parent's PR discussion only after its independent audit", () => {
  const rubric = read("skills/dyl-review/references/thermo-nuclear-review.md");
  const recipe = read("agents/thermo-nuclear-review-subagent.md");
  assert.doesNotMatch(rubric, /\b(?:gh|glab)\b/);
  assert.match(rubric, /\]\(\.\.\/\.\.\/agents\/thermo-nuclear-review-subagent\.md#work\)/);
  assert.match(recipe, /After the audit[^\n]*medium-or-higher[^\n]*discussion supplied by the parent/i);
  assert.match(recipe, /unavailable[^\n]*return the independent findings/i);
});

test("deep review fetches the PR head even when the base repository has a branch of the same name", t => {
  const { repo, wt, git } = auditFixture(t);
  const base = git("-C", repo, "rev-parse", "HEAD");
  git("-C", repo, "branch", "topic", base);
  git("-C", wt, "-c", "user.name=Fixture", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "fork topic");
  const head = git("-C", wt, "rev-parse", "HEAD");
  git("-C", repo, "update-ref", "refs/pull/17/head", head);
  const checkout = join(dirname(repo), "reviewer");
  git("clone", "--no-local", "-q", repo, checkout);
  assert.notEqual(git("-C", checkout, "rev-parse", "origin/topic"), head);

  const parent = skill("dyl-review").split("## Main-thread rules")[1].split("## Dylan-lens worker")[0];
  const args = parent.match(/`git fetch ([^`]+)`/)[1].replaceAll("<base-remote>", "origin").replaceAll("<base>", "main")
    .replaceAll("<branch>", "topic").replaceAll("<n>", "17").split(" ");
  git("-C", checkout, "fetch", ...args);
  assert.equal(git("-C", checkout, "rev-parse", "FETCH_HEAD"), head, "documented fetch must select the fork's commit");
  assert.match(parent, /headRefOid/);
  assert.match(parent, /FETCH_HEAD[^\n]*stop/i);
  assert.match(parent, /git diff <base-oid>\.\.\.<head-oid>/);
});

test("dyl-review keeps code-review coordination and Git/forge work in the parent", () => {
  const text = skill("dyl-review");
  assert.match(text, /parent[^\n]*Standards[^\n]*Spec/i);
  const worker = text.split("## Dylan-lens worker")[1].split("## Synthesis")[0];
  assert.doesNotMatch(worker, /`(?:gh|git|origin) /);
  assert.match(worker, /title and body[^\n]*(?:parent|main thread)/i);
  assert.doesNotMatch(text, /child running \[code-review\]|code-review child|every worker the depth calls for in one message/);
});

test("review helpers preserve the caller's report and evidence without an extra performance", () => {
  const comments = read("agents/comment-sicko.md");
  assert.doesNotMatch(comments, /first output|ha ha ha/i);
  assert.match(comments, /deletion count.*MUST KILL.*skips/);
  const stance = read("skills/p3stack-mode/references/review-stance.md");
  assert.match(stance, /caller.s (?:report|verdict) format/i);
  assert.match(stance, /command and observed output, or `file:line`/);
  assert.match(playbook("shipping"), /`PASS`, `PASS\+NOTES`, or `FAIL`/);
  assert.match(skill("dyl-review"), /🟢\|🟡\|🔴/);
  assert.doesNotMatch(read("skills/dyl-review/references/dyl-mode.md"), /Write every user-facing reply/);
  for (const review of reviews) assert.doesNotMatch(read(`agents/${review}-subagent.md`), /Calibrate severity honestly|Be direct and high-conviction/i);
});

test("app and formal verification register distinct skills for the same project name", () => {
  const outputs = ["create-verification-skill", "create-formal-verification-skill"].map(name => {
    const instructions = skill(name).replaceAll(/<(?:app|area)>/g, "checkout");
    const directory = instructions.match(/`\.pi\/skills\/([^/`]+)\/SKILL\.md`/)[1];
    return { instructions, directory };
  });
  assert.notEqual(outputs[0].directory, outputs[1].directory);
  for (const { instructions, directory } of outputs) assert.ok(instructions.includes(`\`name: ${directory}\``), directory);
});

test("domain setup pairs the interview with domain-modeling", () => {
  assert.match(read("skills/setup-matt-pocock-skills/domain.md"), /(?:alongside|together with) `\/skill:grilling`/);
});

for (const kind of ["verification-skill", "formal-verification-skill"]) {
  test(`audit an existing ${kind} before starting the create procedure`, () => {
    const entry = skill(`create-${kind}`).split("\n## ")[0];
    assert.match(entry, /audit or realign/i);
    assert.ok(entry.includes(`(references/maintain-${kind}.md)`));
  });
}

test("architect stops on a prompt-only request and compares viable designs on depth", () => {
  const doc = skill("architect");
  assert.match(doc, /only to sharpen[^\n]*return the rewritten prompt and stop/i);
  assert.match(doc, /Compare viable candidates on interface depth\.[^\n]*references\/codebase-design\.md/);
});

test("Pi help starts at the persistent router and distinguishes an explicit standalone skill", () => {
  const help = skill("poteto-help");
  for (const command of ["/p3stack on`", "/p3stack on autonomous`", "/p3stack off`", "/skill:<name>"]) assert.ok(help.includes(command), command);
  assert.match(help, /`\/p3stack on default`/);
  assert.match(help, /`\/p3stack on` keeps the last grant/i);
  assert.doesNotMatch(help, /This file maps questions/);
  assert.match(help, /model-visible skills[^\n]*router (?:is )?off/i);
  assert.doesNotMatch(help, /references\/routes\.md/, "the router inlines its route table; no separate copy is emitted");
  assert.doesNotMatch(help, /start(?:ing)? each (?:new )?task with|Only `[^\n]*setup-pstack` loads|lists every playbook|default answer is `\/skill:poteto-mode/i);
});

test("a reflection reviewer still recognizes reads of any skill in the transcript", () => {
  for (const reviewer of ["divergent", "judgment", "tooling"]) {
    assert.match(read(`skills/retro/references/reflect/references/${reviewer}-reviewer.md`), /a \`Read\` of its \`SKILL\.md\`/);
  }
});

test("help leads with routed requests, then covers the other emitted skills and every reference owner", () => {
  const help = skill("poteto-help"), routes = JSON.parse(read("registry/routes.json")), registry = JSON.parse(read("registry/skills.json"));
  assert.equal(help.match(/^## .+$/m)[0], "## Find a job");
  const [jobs, rest] = help.split("### Other standalone jobs"), [direct, owners] = rest.split("### References by owner");
  for (const { request, grant, target } of routes) {
    const row = jobs.split("\n").find(line => line.startsWith(`| ${request} |`));
    assert.ok(row, request);
    if (target?.includes("playbooks/")) {
      // A playbook is no command: the row names the skill whose directory holds it, which loads it with routing off.
      const label = target.split("/").pop().replace(/\.md$/, ""), holder = target.startsWith("playbooks/") ? "poteto-mode" : target.split("/")[0];
      assert.ok(row.endsWith(`| \`/skill:${holder} use the ${label} playbook\` |`), row);
      assert.ok(read(`skills/${holder}/playbooks/${label}.md`), row);
    }
    else if (target) assert.ok(row.includes(target.includes("/") ? target : `/skill:${target}`), row);
    if (grant !== "any") assert.ok(row.includes(grant === "default" ? "default" : "autonomous"), row);
  }
  assert.ok(jobs.includes("| Review my change | `/skill:p3stack-mode use the review-local playbook` |"));
  assert.ok(jobs.includes("| Open a PR | `/skill:poteto-mode use the opening-a-pr playbook` |"));
  const targets = new Set(routes.map(row => row.target));
  const names = [...direct.matchAll(/\]\(\.\.\/([\w-]+)\/SKILL\.md\)/g)].map(match => match[1]);
  assert.deepEqual(names.sort(), registry.filter(row => row.action === "emit" && !targets.has(row.name)).map(row => row.name).sort());
  assert.match(direct, /\[`\/p3stack on`\]\(\.\.\/p3stack-mode\/SKILL\.md\)/);
  for (const { name, owner } of registry.filter(row => row.action === "reference")) {
    const row = owners.split("\n").find(line => line.startsWith(`- [${owner}]`));
    assert.ok(row?.includes(name.startsWith("principle-") ? "principle-*" : `../${owner}/references/${name}.md`), name);
  }
});

test("copyable help recipes can be sent after enabling the Pi router", () => {
  const recipes = read("skills/poteto-help/references/recipes.md");
  assert.match(recipes, /\/p3stack on/);
  assert.doesNotMatch(recipes, /`\/skill:(?:poteto-mode|p3stack-mode) /);
  assert.match(recipes, /p3stack-mode\/references\/show-me-your-work\.md[^\n]*decision log/);
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
