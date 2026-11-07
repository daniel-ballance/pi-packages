import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../generator/check-t3-pin.mjs", import.meta.url));
const tools = ["orchestrator_capabilities", "delegate_task", "task_status"];
const statePaths = [
  { path: "runtime/service-state.json", versionField: "activeVersion" },
  { path: "userdata/server-runtime.json", versionField: "serverVersion" },
];
const hash = text => createHash("sha256").update(text).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-t3-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const bridge = "export const fixtureBridge = true;\n";
  const pin = {
    version: "fixture-version", bridgeSha256: hash(bridge), statePaths, directTools: tools, beforeAgentStartReturn: { systemPrompt: "string" },
    reviewed: { release: "fixture-release", commit: "a".repeat(40) },
    watch: [{ path: "packages/contracts/src/orchestratorMcp.ts", contract: "fixture contract", dependents: ["packages/p3stack/rules/t3-pin.json"] }],
  };
  const hostMap = tools.map(name => `\`mcp__t3-code__${name}\``).join("\n") + "\n`mcp__t3-code__html_preview`\n`mcp__t3-code__preview_*`\n";
  write("rules/t3-pin.json", pin);
  write("home/.t3/runtime/service-state.json", { activeVersion: "fixture-version" });
  write("home/.t3/caches/pi-t3-mcp-extension.ts", bridge);
  write("empty-home/.keep", "");
  write("extra/skills/poteto-mode/references/host-capabilities.md", hostMap);
  const doctor = {
    tools: [...tools.map(name => ({ name: `mcp__t3-code__${name}`, exposure: "direct" })), { name: "mcp__t3-code__html_preview", exposure: "deferred" }],
    extension: { path: "/fixture/bridge.ts", sha256: hash(bridge) },
    claudeSubscriptionBeforeBridge: false,
    problems: [],
  };
  write("doctor.json", doctor);
  const run = (args = [], home = "home") => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, HOME: join(root, home), P3STACK_PACKAGE_DIR: root },
  });
  return { root, write, pin, doctor, run };
}

for (const home of ["home", "empty-home"]) {
  test(`default checks the static contract without an installed host in ${home}`, t => {
    const f = fixture(t);
    f.write("home/.t3/runtime/service-state.json", "not json");
    rmSync(join(f.root, "home/.t3/caches/pi-t3-mcp-extension.ts"));
    const result = f.run([], home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "T3 static contract matches rules/t3-pin.json and the host map.");
  });
}

test("default is independent of installed release and bridge bytes", t => {
  const f = fixture(t);
  f.write("home/.t3/runtime/service-state.json", { activeVersion: "other-version" });
  f.write("home/.t3/caches/pi-t3-mcp-extension.ts", "other bridge");
  assert.equal(f.run().status, 0);
});

for (const [name, mutate, diagnostic] of [
  ["missing direct tool in the map", f => f.write("extra/skills/poteto-mode/references/host-capabilities.md", ""), /host map.*required direct tool/],
  ["malformed JSON", f => f.write("rules/t3-pin.json", "not json"), /t3-pin\.json could not be read/],
  ["invalid provenance hash", f => f.write("rules/t3-pin.json", { ...f.pin, bridgeSha256: "invalid" }), /Invalid rules/],
  ["empty direct tools", f => f.write("rules/t3-pin.json", { ...f.pin, directTools: [] }), /Invalid rules/],
  ["duplicate direct tools", f => f.write("rules/t3-pin.json", { ...f.pin, directTools: ["task_status", "task_status"] }), /Invalid rules/],
  ["invalid state layout", f => f.write("rules/t3-pin.json", { ...f.pin, statePaths: [{}] }), /Invalid rules/],
  ["incompatible prompt return", f => f.write("rules/t3-pin.json", { ...f.pin, beforeAgentStartReturn: { systemPrompt: "object" } }), /Unsupported beforeAgentStartReturn/],
  ["missing reviewed commit", f => f.write("rules/t3-pin.json", { ...f.pin, reviewed: { release: "x" } }), /reviewed/],
  ["duplicate watch path", f => f.write("rules/t3-pin.json", { ...f.pin, watch: [f.pin.watch[0], f.pin.watch[0]] }), /watch/],
]) {
  test(`static contract rejects ${name}`, t => {
    const f = fixture(t);
    mutate(f);
    const result = f.run([], "empty-home");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, diagnostic);
  });
}

test("installed diagnostics report different release and bridge bytes without accepting compatibility", t => {
  const f = fixture(t);
  f.write("home/.t3/runtime/service-state.json", { activeVersion: "other-version" });
  f.write("home/.t3/caches/pi-t3-mcp-extension.ts", "changed bridge");
  const result = f.run(["--installed", "--state", join(f.root, "home/.t3/runtime/service-state.json"), "--bridge", join(f.root, "home/.t3/caches/pi-t3-mcp-extension.ts")], "empty-home");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diagnostics only; compatibility is not verified/);
  assert.match(result.stdout, /activeVersion: other-version/);
  assert.ok(result.stdout.includes(`bridge SHA-256: ${hash("changed bridge")}`));
  assert.doesNotMatch(result.stdout, /matches|expected/);
});

for (const [name, path, value, diagnostic] of [
  ["invalid state", "home/.t3/runtime/service-state.json", "not json", /service-state\.json/],
  ["missing active version", "home/.t3/runtime/service-state.json", {}, /activeVersion/],
]) {
  test(`installed diagnostics reject ${name}`, t => {
    const f = fixture(t);
    f.write(path, value);
    const result = f.run(["--installed"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, diagnostic);
  });
}

test("explicit diagnostics report absent state and bridge instead of skipping", t => {
  const f = fixture(t);
  const absent = f.run(["--installed"], "empty-home");
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /No installed T3 state file/);
  rmSync(join(f.root, "home/.t3/caches/pi-t3-mcp-extension.ts"));
  const bridge = f.run(["--installed"]);
  assert.equal(bridge.status, 1);
  assert.match(bridge.stderr, /pi-t3-mcp-extension\.ts/);
  const explicit = f.run(["--installed", "--state", join(f.root, "missing.json")]);
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /missing\.json could not be read/);
});

test("installed diagnostics support legacy state and prefer runtime state when both exist", t => {
  const f = fixture(t);
  f.write("home/.t3/userdata/server-runtime.json", { serverVersion: "legacy-version" });
  const runtime = f.run(["--installed"]);
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(runtime.stdout, /activeVersion: fixture-version/);
  assert.doesNotMatch(runtime.stdout, /legacy-version/);
  rmSync(join(f.root, "home/.t3/runtime/service-state.json"));
  const legacy = f.run(["--installed"]);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /activeVersion: legacy-version/);
  assert.ok(legacy.stdout.includes(join(f.root, "home/.t3/userdata/server-runtime.json")));
});

test("doctor verifies required capabilities independently of release, hash, and additive tools", t => {
  const f = fixture(t);
  f.doctor.extension.sha256 = "0".repeat(64);
  f.doctor.tools.push({ name: "mcp__t3-code__new_direct_tool", exposure: "direct" });
  f.doctor.tools.push({ name: "mcp__t3-code__new_deferred_tool", exposure: "deferred" });
  f.write("doctor.json", f.doctor);
  const result = f.run(["--doctor", join(f.root, "doctor.json")], "empty-home");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doctor capabilities match.*host map; behavioral verification is still required/);
});

for (const [name, mutate, diagnostic] of [
  ["renamed direct tool", f => { f.doctor.tools[1].name = "mcp__t3-code__delegate_task_renamed"; }, /delegate_task/],
  ["missing documented tool", f => { f.doctor.tools.pop(); }, /html_preview/],
  ["changed required exposure", f => { f.doctor.tools[1].exposure = "deferred"; }, /directTools.*delegate_task/],
  ["invalid exposure", f => { f.doctor.tools[1].exposure = "unknown"; }, /Invalid doctor dump/],
  ["reported problems", f => { f.doctor.problems.push("fixture problem"); }, /fixture problem/],
]) {
  test(`doctor reports ${name}`, t => {
    const f = fixture(t);
    mutate(f);
    f.write("doctor.json", f.doctor);
    const result = f.run(["--doctor", join(f.root, "doctor.json")]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, diagnostic);
  });
}

test("doctor rejects a terminal dump and malformed input", t => {
  const f = fixture(t);
  for (const dump of [{ tools: [], extension: { path: null, sha256: null }, claudeSubscriptionBeforeBridge: false, problems: ["T3_PI_MCP_EXTENSION_PATH is not set"] }, {}, { tools: [null], extension: null }, "not json"]) {
    f.write("doctor.json", dump);
    const result = f.run(["--doctor", join(f.root, "doctor.json")]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doctor/);
  }
});

test("CLI rejects unknown, missing, repeated, or mixed modes", t => {
  const f = fixture(t);
  for (const args of [["--unknown"], ["--doctor"], ["--state"], ["--bridge"], ["--installed", "--installed"], ["--state", "a"], ["--bridge", "a"], ["--installed", "--state", "a", "--state", "b"], ["--doctor", "a", "--installed"], ["--doctor", "a", "--state", "b"]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage/);
  }
});

test("repository contract retains required direct tools and the prompt return shape", () => {
  const pin = JSON.parse(readFileSync(new URL("../rules/t3-pin.json", import.meta.url), "utf8"));
  assert.deepEqual(pin.statePaths, statePaths);
  assert.deepEqual(pin.directTools, tools);
  assert.deepEqual(pin.beforeAgentStartReturn, { systemPrompt: "string" });
  assert.deepEqual(pin.reviewed, { release: "v0.1.3-nightly.20261026.3717", commit: "1316d48b0c68151afd8b47eb0c11a114cf0b4daa" });
  assert.deepEqual(pin.watch.map(entry => entry.path), [
    "packages/contracts/src/orchestratorMcp.ts",
    "packages/provider-pi/src/server/mcpExtensionSource.ts",
    "packages/provider-pi/src/server/mcpInjection.ts",
    "packages/provider-pi/src/server/adapter.ts",
    "apps/server/src/orchestration-v2/Orchestrator.ts",
    "apps/server/src/orchestration-v2/ProviderContinuationService.ts",
    "packages/provider-core/src/server/orchestrationInstructions.ts",
    "apps/server/src/mcp/toolkits/orchestrator/tools.ts",
    "apps/server/src/mcp/toolkits/pullRequests/tools.ts",
  ]);
});

test("static contract rejects a dependents path that is not in the repository", t => {
  const f = fixture(t);
  f.write("rules/t3-pin.json", { ...f.pin, watch: [{ path: "a.ts", contract: "fixture contract", dependents: ["no/such/dependent.ts"] }] });
  const result = f.run([], "empty-home");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /dependents path does not exist: no\/such\/dependent\.ts/);
});

function sourceRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-t3-src-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync("git", ["-c", "user.email=pin@example.com", "-c", "user.name=pin", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-b", "main"]);
  writeFileSync(join(root, "watched.txt"), "v1\n");
  writeFileSync(join(root, "other.txt"), "same\n");
  git(["add", "watched.txt", "other.txt"]);
  git(["commit", "-m", "base"]);
  return { root, git, commit: git(["rev-parse", "HEAD"]) };
}

function sourcePin(f, commit, watch) {
  f.write("rules/t3-pin.json", { ...f.pin, reviewed: { release: "fixture-release", commit }, watch });
}

test("--source reports no watched change when the checkout matches the reviewed commit", t => {
  const f = fixture(t);
  const repo = sourceRepo(t);
  const watch = [
    { path: "watched.txt", contract: "options stay {id, values}", dependents: ["not-in-this-repo.md"] },
    { path: "other.txt", contract: "wake text stays anchored", dependents: ["also-missing.md"] },
  ];
  sourcePin(f, repo.commit, watch);
  const result = f.run(["--source", repo.root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "No watched T3 file changed since fixture-release.");
});

test("--source names each watched file that changed, with its contract and dependents", t => {
  const f = fixture(t);
  const repo = sourceRepo(t);
  writeFileSync(join(repo.root, "watched.txt"), "v2\n");
  repo.git(["add", "watched.txt"]);
  repo.git(["commit", "-m", "change"]);
  const watch = [
    { path: "watched.txt", contract: "options stay {id, values}", dependents: ["roles.ts", "mode.ts"] },
    { path: "other.txt", contract: "wake text stays anchored", dependents: ["mode.ts"] },
  ];
  sourcePin(f, repo.commit, watch);
  const result = f.run(["--source", repo.root, "--ref", "HEAD"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^watched\.txt\noptions stay \{id, values\}\nroles\.ts\nmode\.ts\n/);
  assert.doesNotMatch(result.stdout, /other\.txt/);
  assert.match(result.stdout, /1 of 2 watched T3 files changed since fixture-release; review each contract above\.\n$/);
});

test("--source reports a watched path missing at the ref", t => {
  const f = fixture(t);
  const repo = sourceRepo(t);
  sourcePin(f, repo.commit, [{ path: "missing.txt", contract: "must exist", dependents: ["roles.ts"] }]);
  const result = f.run(["--source", repo.root, "--ref", "HEAD"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /watched path missing at HEAD: missing\.txt/);
  assert.doesNotMatch(result.stdout, /watched T3 file changed/);
});

test("--source exits with git's message for a bad commit", t => {
  const f = fixture(t);
  const repo = sourceRepo(t);
  sourcePin(f, repo.commit, [{ path: "watched.txt", contract: "options stay {id, values}", dependents: ["roles.ts"] }]);
  const result = f.run(["--source", repo.root, "--ref", "not-a-commit"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /fatal:.*not-a-commit/);
  assert.doesNotMatch(result.stderr, /watched path missing/);
});

test("--source rejects mixes with other modes and a ref without a source", t => {
  const f = fixture(t);
  for (const args of [["--source", f.root, "--installed"], ["--source", f.root, "--doctor", "a"], ["--ref", "HEAD"], ["--source"], ["--source", "--ref", "HEAD"], ["--source", f.root, "--state", "a"], ["--source", f.root, "--bridge", "a"], ["--doctor", "a", "--source", f.root]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stderr, /Usage/);
  }
});
