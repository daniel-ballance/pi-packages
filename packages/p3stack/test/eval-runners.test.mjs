import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const jsonl = events => events.map(e => JSON.stringify(e)).join("\n") + "\n";
const final = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Review: sumAll of an empty list is zero is skipped." }] } };
const finish = [final, { type: "agent_end", willRetry: false }, { type: "agent_settled", aborted: false }];
const paths = ["p3stack-mode/SKILL.md", "poteto-mode/SKILL.md", "poteto-mode/playbooks/feature.md"];
const reads = paths.flatMap((path, i) => [
  { type: "tool_execution_start", toolName: "read", toolCallId: String(i), args: { path: join(pkg, "skills", path) } },
  { type: "tool_execution_end", toolName: "read", toolCallId: String(i), isError: false },
]);
const stub = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.PI_CODING_AGENT_DIR;
fs.appendFileSync(process.env.LOG, JSON.stringify({dir, mode:fs.statSync(dir).mode & 511, files:fs.readdirSync(dir), settings:JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))), gitVars:Object.keys(process.env).filter(k=>k.startsWith("GIT_"))})+'\\n');
if (process.env.TRAP_TERM) process.on('SIGTERM', () => process.exit(143)); // Pi print-mode disposal
if (process.env.HELPER) {
  const p = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setTimeout(()=>{},5000)"], {stdio:['ignore',1,2]});
  fs.writeFileSync(process.env.HELPER, String(p.pid));
  p.unref(); // the leader exits, the helper still holds the output pipes
}
process.stdout.write(process.env.STREAM);
if (process.env.HANG) setInterval(() => {}, 1000);
process.exitCode = Number(process.env.CODE ?? 0);`;

// A hermetic PATH: even a missing/broken stub must never fall through to a real Pi.
function setup(t, tier) {
  const root = mkdtempSync(join(tmpdir(), `stub-${tier}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), bin = join(root, "bin"), output = join(root, "receipts"), scratch = join(root, "tmp"), home = join(root, "home"), log = join(root, "stub.log");
  for (const dir of [source, bin, home, scratch]) mkdirSync(dir);
  const settings = { packages: ["./provider"], defaultProjectTrust: "never" };
  for (const [name, text] of Object.entries({ "settings.json": JSON.stringify(settings), "auth.json": "{}", "models.json": "{}", "mcp.json": "{}", "unrelated": "do not copy" })) writeFileSync(join(source, name), text);
  writeFileSync(join(bin, "pi"), stub, { mode: 0o700 });
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const env = { HOME: home, PATH: bin, TMPDIR: scratch, LOG: log, STREAM: jsonl([...(tier === "routing" ? reads : []), ...finish]) };
  function run(extra = [], vars = {}) {
    const args = [join(pkg, "test", tier + "-eval/run.mjs"), "--agent-dir", source, "--output", output, "--runs", "1",
      ...(tier === "routing" ? ["--only", "feature"] : ["--only", "floor-review", "--arms", "on"]), ...extra];
    const child = spawnSync(process.execPath, args, { env: { ...env, ...vars }, cwd: root, encoding: "utf8", timeout: 20000 });
    if (child.error) throw child.error;
    return child;
  }
  return { run, source, root, home, bin, output, settings, log, calls: () => readFileSync(log, "utf8").trim().split("\n").map(s => JSON.parse(s)) };
}

function invalid(result, reason) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, reason);
  assert.doesNotMatch(result.stdout, /prompts pass;|outcomes \d+%/);
}

for (const tier of ["behavior", "routing"]) {
  test(`${tier}: each attempt imports only eval inputs into its own private agent dir`, t => {
    const f = setup(t, tier);
    const result = f.run(["--runs", "2"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].dir, calls[1].dir);
    for (const call of calls) {
      assert.notEqual(call.dir, f.source);
      assert.equal(call.mode, 0o700);
      assert.deepEqual(call.files.sort(), ["auth.json", "models.json", "settings.json"]);
      assert.ok(call.settings.packages.includes(join(f.source, "provider")));
      assert.equal(existsSync(call.dir), false, "throw away credentials even when keeping receipts");
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.source, "settings.json"))), f.settings);
    const receipt = readdirSync(f.output, { recursive: true }).find(path => path.endsWith("results.json"));
    assert.equal(statSync(dirname(join(f.output, receipt))).mode & 0o077, 0, "raw transcript is private");
  });

  test(`${tier}: reject aliases of default and custom live sources and output below a live alias`, t => {
    const f = setup(t, tier);
    const live = join(f.home, ".pi/agent"), custom = join(f.root, "custom-agent"), alias = join(f.root, "alias");
    for (const dir of [live, custom]) {
      cpSync(f.source, dir, { recursive: true });
      symlinkSync(dir, alias);
      const vars = { PI_CODING_AGENT_DIR: custom };
      invalid(f.run(["--agent-dir", alias], vars), /live agent/i);
      invalid(f.run(["--output", join(alias, "new", "logs")], vars), /live agent/i);
      assert.equal(existsSync(join(dir, "new")), false);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"))), f.settings);
      rmSync(alias);
    }
    const tilde = join(f.home, "alternate");
    cpSync(f.source, tilde, { recursive: true });
    invalid(f.run(["--agent-dir", tilde], { PI_CODING_AGENT_DIR: "~/alternate" }), /live agent/i);
    assert.equal(existsSync(f.log), false);
  });

  test(`${tier}: fail before spawning on invalid options`, t => {
    const f = setup(t, tier);
    for (const n of ["0", "-1", "NaN", "1.5"]) invalid(f.run(["--runs", n]), /runs/);
    invalid(f.run(["--only", "made-up"]), /unknown/i);
    invalid(f.run(["--typo"]), /unknown/i);
    if (tier === "behavior") {
      invalid(f.run(["--arms", "on,nope"]), /arm/i);
      invalid(f.run(["--only", "floor-review,nope"]), /unknown/i);
    } else invalid(f.run(["--min-rate", "0"]), /min-rate/);
    assert.equal(existsSync(f.log), false);
  });

  test(`${tier}: neither Git (including discovery) nor Pi inherits any GIT_ variables`, t => {
    const f = setup(t, tier), tracePath = join(f.root, "unexpected trace");
    const result = f.run([], { GIT_DIR: join(f.root, "wrong.git"), GIT_WORK_TREE: f.root, GIT_TRACE2_EVENT: tracePath,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "test.outer", GIT_CONFIG_VALUE_0: "outer" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls()[0].gitVars, []);
    assert.equal(existsSync(tracePath), false, "even the first Git subprocess has a scrubbed environment");
  });

  test(`${tier}: an empty assistant or a tool start without an end is not a run`, t => {
    const f = setup(t, tier), args = tier === "routing" ? ["--mode-off"] : [];
    for (const events of [[], [reads[0]]]) {
      invalid(f.run(args, { STREAM: jsonl([...events,
        { type: "message_end", message: { role: "assistant", content: [] } }, ...finish.slice(1)]) }), /no completed|incomplete/i);
    }
  });

  test(`${tier}: a timeout kills a helper holding the leader's output pipes`, t => {
    const f = setup(t, tier), pidFile = join(f.root, "helper.pid"), start = Date.now();
    invalid(f.run(["--timeout-seconds", "1"], { HELPER: pidFile, STREAM: jsonl(finish) }), /timed out/);
    assert.ok(Date.now() - start < 3500, "do not wait for the helper's 5s timer");
    assert.ok(!existsSync(f.calls()[0].dir), "remove the private agent directory at the deadline");
    const ps = spawnSync("ps", ["-p", readFileSync(pidFile, "utf8"), "-o", "stat="], { encoding: "utf8" });
    assert.ok(ps.status === 1 || ps.stdout.trim().startsWith("Z"), "the helper is not still executing");
  });

  test(`${tier}: a malformed, empty, truncated, timed-out or nonzero process is not a grade`, t => {
    const f = setup(t, tier);
    invalid(f.run([], { STREAM: jsonl(finish) + "bad JSON\n" }), /JSONL/);
    invalid(f.run([], { STREAM: "" }), /no completed|empty/i);
    invalid(f.run([], { STREAM: jsonl([{ type: "session" }, { type: "agent_start" }]) }), /no completed|incomplete/i);
    invalid(f.run([], { CODE: "17", STREAM: jsonl(finish) }), /17/);
    invalid(f.run(["--timeout-seconds", "1"], { HANG: "1", STREAM: "" }), /timed out|timeout after/i);
    rmSync(join(f.bin, "pi"));
    invalid(f.run(), /spawn pi ENOENT/i);
    assert.ok(f.calls().every(call => !existsSync(call.dir)), "clean up on every failure path");
    assert.ok(!readdirSync(f.output, { recursive: true }).some(name => name.endsWith("results.json")));
  });
}

test("behavior: copy mcp.json only for the selected MCP case; fail without it", t => {
  const f = setup(t, "behavior");
  const result = f.run(["--only", "source-grounding"]);
  assert.equal(result.status, 1, "stub produced no configured artifact");
  assert.ok(f.calls()[0].files.includes("mcp.json"));
  rmSync(join(f.source, "mcp.json"));
  invalid(f.run(["--only", "source-grounding"]), /mcp\.json/);
  assert.equal(f.calls().length, 1);
});

test("routing: expected first reads on natural exit pass below the cap; mode off only observes", t => {
  const f = setup(t, "routing");
  const natural = f.run(["--max-reads", "4"]);
  assert.equal(natural.status, 0, natural.stderr + natural.stdout);
  assert.match(natural.stdout, /1\/1 prompts pass/);
  const capped = f.run([], { TRAP_TERM: "1", HANG: "1", STREAM: jsonl(reads) });
  assert.equal(capped.status, 0, capped.stderr);
  invalid(f.run([], { CODE: "143", STREAM: jsonl(finish) }), /143/);
  const off = f.run(["--mode-off"], { STREAM: jsonl(finish) });
  assert.equal(off.status, 0, off.stderr + off.stdout);
  assert.match(off.stdout, /not graded/i);
  assert.doesNotMatch(off.stdout, /prompts pass|routed as expected/i);
});

test("the default transcript directory is ignored by the root .gitignore", () => {
  for (const path of ["test/eval-output/probe", "test/behavior-eval/output", "test/routing-eval/fixtures/output"]) {
    const result = spawnSync("git", ["check-ignore", "-v", path + "/results.json"], { cwd: pkg, encoding: "utf8" });
    assert.equal(result.status, 0, path);
    assert.match(result.stdout, /^\.gitignore:/);
  }
});
