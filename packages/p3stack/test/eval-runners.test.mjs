import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
if (process.argv.includes('--version')) { console.log('1.5.2'); process.exit(0); }
if (process.env.WRITE_NOTE) fs.writeFileSync('notes.txt', 'proposed patch');
if (process.env.PAGE) fs.writeFileSync('page.html', process.env.PAGE);
if (process.env.BREAK_SECOND_TREE && fs.existsSync(process.env.LOG)) fs.rmSync('.git', { recursive: true });
const dir = process.env.PI_CODING_AGENT_DIR;
fs.appendFileSync(process.env.LOG, JSON.stringify({dir, mode:fs.statSync(dir).mode & 511, files:fs.readdirSync(dir), settings:JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))), gitVars:Object.keys(process.env).filter(k=>k.startsWith("GIT_"))})+'\\n');
if (process.env.TRAP_TERM) process.on('SIGTERM', () => process.exit(143)); // Pi print-mode disposal
if (process.env.HELPER) {
  const p = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setTimeout(()=>{},5000)"], {stdio:['ignore',1,2]});
  fs.writeFileSync(process.env.HELPER, String(p.pid));
  p.unref(); // the leader exits, the helper still holds the output pipes
}
if (process.env.SIGNAL) {
  require('node:child_process').spawn(process.execPath, ['-e', \`
    const fs = require('node:fs');
    process.on(process.env.SIGNAL, () => { fs.writeFileSync(process.env.LOG+'.forwarded', process.env.SIGNAL); process.exit(0); });
    fs.writeFileSync(process.env.LOG+'.ready', String(process.ppid));
    setTimeout(() => {}, 10000);
  \`], {stdio:'inherit'});
}
process.stdout.write(process.env.STREAM);
if (process.env.HANG) setInterval(() => {}, 1000);
process.exitCode = Number(process.env.CODE ?? 0);`;

// A hermetic PATH: even a missing/broken stub must never fall through to a real Pi.
function setup(t, tier) {
  const root = mkdtempSync(join(tmpdir(), `stub-${tier}-`));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const source = join(root, "source"), bin = join(root, "bin"), output = join(root, "receipts"), scratch = join(root, "tmp"), home = join(root, "home"), log = join(root, "stub.log");
  for (const dir of [source, bin, home, scratch]) mkdirSync(dir);
  const settings = { packages: ["./provider"], defaultProjectTrust: "never" };
  for (const [name, text] of Object.entries({ "settings.json": JSON.stringify(settings), "auth.json": "{}", "models.json": "{}", "mcp.json": "{}", "unrelated": "do not copy" })) writeFileSync(join(source, name), text);
  writeFileSync(join(bin, "pi"), stub, { mode: 0o700 });
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const env = { HOME: home, PATH: bin, TMPDIR: scratch, LOG: log, STREAM: jsonl([...(tier === "routing" ? reads : []), ...finish]) };
  const args = [join(pkg, "test", tier + "-eval/run.mjs"), "--agent-dir", source, "--output", output, "--runs", "1",
    ...(tier === "routing" ? ["--only", "feature"] : ["--only", "floor-review", "--arms", "on"])];
  function run(extra = [], vars = {}) {
    const child = spawnSync(process.execPath, [...args, ...extra], { env: { ...env, ...vars }, cwd: root, encoding: "utf8", timeout: 20000 });
    if (child.error) throw child.error;
    return child;
  }
  return { run, args, env, source, root, home, bin, output, settings, log, calls: () => readFileSync(log, "utf8").trim().split("\n").map(s => JSON.parse(s)) };
}

function invalid(result, reason) {
  assert.equal(result.status, 2, result.stderr + result.stdout);
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

  test(`${tier}: a per-attempt receipt identifies the revision and served model, not the requested alias or private transcript`, t => {
    const f = setup(t, tier), routing = tier === "routing";
    const recorded = readFileSync(join(pkg, "test/routing-eval/fixtures/assistant.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
    if (routing) recorded.splice(-3, 0, ...reads);
    const result = f.run(routing ? ["--max-reads", "5"] : [], { STREAM: jsonl(recorded), ...(!routing && { WRITE_NOTE: "1" }) });
    assert.equal(result.status, routing ? 0 : 1, result.stderr + result.stdout);
    const dir = join(f.output, readdirSync(f.output)[0]);
    const file = readdirSync(dir).find(name => name.endsWith(".receipt.json"));
    assert.ok(file, "no comparison receipt for the attempt");
    const bytes = readFileSync(join(dir, file), "utf8"), receipt = JSON.parse(bytes);
    const summary = readFileSync(join(dir, "results.json"), "utf8");
    for (const secret of [f.root, pkg, "/home/eval", "fixture-credential", "private-session-8ba7", "private thinking"]) {
      assert.ok(!(bytes + summary).includes(secret), "comparison evidence contains private data");
    }
    assert.equal(receipt.revision, execFileSync("git", ["rev-parse", "HEAD"], { cwd: pkg, encoding: "utf8" }).trim());
    assert.deepEqual(receipt.models, [{ provider: "test-provider", model: "model-alias", responseModel: "served-snapshot", thinkingLevel: "medium", providerThinkingLevel: "low" }]);
    assert.equal(receipt.piVersion, "1.5.2");
    assert.equal(receipt.turns, 2);
    assert.deepEqual(receipt.usage, { input: 22, output: 11, cacheRead: 7, cacheWrite: 2, totalTokens: 42 });
    const rows = routing ? "prompts" : "cases";
    const row = JSON.parse(readFileSync(join(pkg, `test/${tier}-eval/${rows}.json`)))[rows].find(row => row.id === receipt.id);
    const hash = value => createHash("sha256").update(value).digest("hex");
    assert.equal(receipt.promptSha256, hash(row.prompt));
    assert.equal(receipt.passed, routing);
    const artifact = readFileSync(join(dir, receipt.artifact.file));
    assert.equal(receipt.artifact.sha256, hash(artifact));
    const evidence = JSON.parse(artifact);
    if (routing) {
      assert.deepEqual(evidence.reads.slice(1).map(r => r.path), paths);
      assert.equal(evidence.reads[0].path, "<other>");
    } else {
      assert.match(evidence.final, /empty list/);
      assert.deepEqual(evidence.changes, [{ path: "notes.txt", before: null, after: "proposed patch" }]);
    }
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
    const nonzero = f.run([], { CODE: "17", STREAM: jsonl(finish) });
    invalid(nonzero, /17/);
    const log = nonzero.stderr.match(/\(log: (.+)\)/)?.[1];
    assert.ok(log && existsSync(log + ".stderr"), "the diagnostic locates the raw logs");
    assert.equal(readFileSync(log + ".jsonl", "utf8"), jsonl(finish));
    invalid(f.run(["--timeout-seconds", "1"], { HANG: "1", STREAM: "" }), /timed out|timeout after/i);
    rmSync(join(f.bin, "pi"));
    invalid(f.run(), /spawn pi ENOENT/i);
    assert.ok(f.calls().every(call => !existsSync(call.dir)), "clean up on every failure path");
    assert.ok(!readdirSync(f.output, { recursive: true }).some(name => name.endsWith("results.json")));
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} reaches the eval process group and removes its private directory`, async t => {
    const f = setup(t, "routing"), ready = f.log + ".ready";
    const runner = spawn(process.execPath, f.args, { cwd: f.root, env: { ...f.env, STREAM: "", SIGNAL: signal },
      stdio: "ignore", timeout: 10000, killSignal: "SIGKILL" });
    const exited = once(runner, "exit");
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(ready), "stub helper is listening");
      runner.kill(signal);
      assert.deepEqual(await exited, [null, signal]);
      assert.ok(!existsSync(f.calls()[0].dir), "private credential copy survived interruption");
      assert.equal(readFileSync(f.log + ".forwarded", "utf8"), signal);
    } finally {
      runner.kill("SIGKILL");
      const group = existsSync(ready) && Number(readFileSync(ready, "utf8"));
      if (group && Number.isSafeInteger(group) && group > 1) {
        try { process.kill(-group, "SIGKILL"); }
        catch (e) { if (e.code !== "ESRCH") throw e; }
      }
    }
  });
}

test("behavior: require Chromium before the first attempt when a later case needs arithmetic", t => {
  const f = setup(t, "behavior");
  invalid(f.run(["--only", "floor-review,prototype-logic"]), /Chromium/);
  assert.equal(existsSync(f.log), false);
});

test("behavior: a state-only page is counted as not graded for arithmetic", t => {
  const f = setup(t, "behavior");
  const browser = spawnSync("which", ["chromium"], { encoding: "utf8" });
  if (browser.status !== 0) return t.skip("no Chromium on PATH");
  const page = '<p id="s">requested</p>' + ["approved", "rejected", "refunded"]
    .map(word => `<button onclick="s.textContent='${word}'">Show ${word}</button>`).join("");
  writeFileSync(join(f.bin, "chromium"), '#!/bin/sh\nPATH="$BROWSER_PATH" exec "$BROWSER" "$@"\n', { mode: 0o700 });
  const result = f.run(["--only", "prototype-logic"], {
    PAGE: page, BROWSER_PATH: process.env.PATH, BROWSER: browser.stdout.trim(),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /prototype-logic \[on\]:.*arithmetic not graded: 1\/1/);
  const dir = join(f.output, readdirSync(f.output)[0]);
  const { results: [r] } = JSON.parse(readFileSync(join(dir, "results.json")));
  assert.deepEqual(r.outcome.checks.map(c => c.passed), [true, null]);
  assert.equal(r.outcome.score, 1, "only measured checks contribute");
  assert.equal(r.passed, null, "a partial grade is not a pass");
  assert.equal(JSON.parse(readFileSync(join(dir, r.receipt))).status, "not graded");
});

test("behavior: a grading error leaves completed attempts in results.json", t => {
  const f = setup(t, "behavior");
  invalid(f.run(["--runs", "2"], { BREAK_SECOND_TREE: "1" }), /not a git repository/);
  const dir = join(f.output, readdirSync(f.output)[0]);
  const { results } = JSON.parse(readFileSync(join(dir, "results.json")));
  assert.deepEqual(results.map(r => [r.id, r.run, r.passed]), [["floor-review", 1, true]]);
});

test("behavior: copy mcp.json only for the selected MCP case; fail without it", t => {
  const f = setup(t, "behavior");
  const args = ["--only", "source-grounding"];
  invalid(f.run(args), /P3STACK_EVAL_VITEST_DIR/);
  // Exercise MCP import without installing software. Only the separate coverage controls run Vitest.
  const runtime = join(f.root, "grader");
  const { devDependencies } = JSON.parse(readFileSync(join(pkg, "test/behavior-eval/fixtures/source-grounding/base/package.json")));
  for (const [name, version] of Object.entries(devDependencies)) {
    const dir = join(runtime, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  }
  const result = f.run(args, { P3STACK_EVAL_VITEST_DIR: runtime });
  assert.equal(result.status, 1, "stub produced no configured artifact");
  assert.ok(f.calls()[0].files.includes("mcp.json"));
  rmSync(join(f.source, "mcp.json"));
  invalid(f.run(["--only", "source-grounding"]), /mcp\.json/);
  assert.equal(f.calls().length, 1);
});

test("routing: unknown usage stays unknown and a credential or session ID cannot masquerade as a model", t => {
  const f = setup(t, "routing"), id = "private-session-72d1", key = "fixture-token-124";
  writeFileSync(join(f.source, "auth.json"), JSON.stringify({ custom: { type: "api_key", key } }));
  const message = { ...final.message, model: id, responseModel: key, provider: f.home };
  const result = f.run(["--mode-off"], { STREAM: jsonl([{ type: "session", version: 3, id, cwd: f.home }, { type: "message_end", message }, ...finish.slice(1)]) });
  assert.equal(result.status, 0, result.stderr);
  const path = readdirSync(f.output, { recursive: true }).find(path => path.endsWith(".receipt.json"));
  const text = readFileSync(join(f.output, path), "utf8");
  for (const privateValue of [id, key, f.home]) assert.ok(!text.includes(privateValue));
  const receipt = JSON.parse(text);
  assert.equal(receipt.usage, null);
  assert.equal(receipt.models[0].responseModel, null);
  assert.equal(receipt.models[0].thinkingLevel, null);
  assert.equal(receipt.status, "not graded");
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
