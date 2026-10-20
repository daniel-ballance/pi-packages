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
  write("rules/t3-pin.json", { version: "fixture-version", bridgeSha256: hash(bridge), statePaths, directTools: tools, beforeAgentStartReturn: { systemPrompt: "string" } });
  write("home/.t3/runtime/service-state.json", { activeVersion: "fixture-version" });
  write("home/.t3/caches/pi-t3-mcp-extension.ts", bridge);
  write("empty-home/.keep", "");
  write("extra/skills/poteto-mode/references/host-capabilities.md", tools.map(name => `\`mcp__t3-code__${name}\``).join("\n") + "\n`mcp__t3-code__html_preview`\n`mcp__t3-code__preview_*`\n");
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
  return { root, write, doctor, run };
}

test("pin check matches a fixture state file and bridge without contacting T3", t => {
  const f = fixture(t);
  const result = f.run(["--state", join(f.root, "home/.t3/runtime/service-state.json"), "--bridge", join(f.root, "home/.t3/caches/pi-t3-mcp-extension.ts")], "empty-home");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `T3 fixture-version matches rules/t3-pin.json\nstate read from ${join(f.root, "home/.t3/runtime/service-state.json")}`);
});

for (const [name, path, value, diagnostic] of [
  ["version drift", "home/.t3/runtime/service-state.json", { activeVersion: "other-version" }, /activeVersion.*other-version.*fixture-version/],
  ["bridge drift", "home/.t3/caches/pi-t3-mcp-extension.ts", "changed bridge", /bridge SHA-256/],
  ["invalid state", "home/.t3/runtime/service-state.json", "not json", /service-state\.json/],
  ["missing active version", "home/.t3/runtime/service-state.json", {}, /activeVersion/],
]) {
  test(`pin check rejects ${name}`, t => {
    const f = fixture(t);
    f.write(path, value);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, diagnostic);
    if (name === "version drift") {
      const lines = result.stderr.trim().split("\n");
      assert.equal(lines[0], "activeVersion is other-version, expected fixture-version");
      assert.equal(lines[1], `state read from ${join(f.root, "home/.t3/runtime/service-state.json")}`);
    }
  });
}

test("pin check skips when T3 is absent", t => {
  const f = fixture(t);
  const absent = f.run([], "empty-home");
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /skip.*T3.*absent/i);
});

test("pin check reports legacy serverVersion drift without a bridge", t => {
  const f = fixture(t);
  const pin = JSON.parse(readFileSync(join(f.root, "rules/t3-pin.json"), "utf8"));
  f.write("rules/t3-pin.json", { ...pin, version: "0.1.1-nightly.20261018.3302" });
  f.write("legacy-home/.t3/userdata/server-runtime.json", { serverVersion: "0.1.1-nightly.20261016.3203" });
  const result = f.run([], "legacy-home");
  assert.equal(result.status, 1, result.stdout);
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines[0], "activeVersion is 0.1.1-nightly.20261016.3203, expected 0.1.1-nightly.20261018.3302");
  assert.equal(lines[1], `state read from ${join(f.root, "legacy-home/.t3/userdata/server-runtime.json")}`);
  assert.ok(lines.includes(`bridge hash unverifiable at ${join(f.root, "legacy-home/.t3/caches/pi-t3-mcp-extension.ts")}`));
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("pin check skips when runtime exists but neither state file exists", t => {
  const f = fixture(t);
  rmSync(join(f.root, "home/.t3/runtime/service-state.json"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip.*T3.*no state file/i);
  assert.ok(result.stdout.includes(join(f.root, "home/.t3/runtime/service-state.json")));
  assert.ok(result.stdout.includes(join(f.root, "home/.t3/userdata/server-runtime.json")));
});

test("pin check prefers runtime state when both layouts exist", t => {
  const f = fixture(t);
  f.write("home/.t3/runtime/service-state.json", { activeVersion: "runtime-version" });
  f.write("home/.t3/userdata/server-runtime.json", { serverVersion: "legacy-version" });
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines[0], "activeVersion is runtime-version, expected fixture-version");
  assert.equal(lines[1], `state read from ${join(f.root, "home/.t3/runtime/service-state.json")}`);
  assert.doesNotMatch(result.stderr, /legacy-version/);
});

test("explicit missing fixture paths fail rather than skip", t => {
  const f = fixture(t);
  const result = f.run(["--state", join(f.root, "missing.json")], "empty-home");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /missing\.json/);
});

test("doctor accepts PR-04's dump shape independently of installed T3", t => {
  const f = fixture(t);
  const result = f.run(["--doctor", join(f.root, "doctor.json")], "empty-home");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doctor.*matches.*host map/i);
});

for (const [name, mutate, diagnostic] of [
  ["renamed direct tool", f => { f.doctor.tools[1].name = "mcp__t3-code__delegate_task_renamed"; }, /delegate_task/],
  ["missing documented tool", f => { f.doctor.tools.pop(); }, /html_preview/],
  ["changed exposure", f => { f.doctor.tools[1].exposure = "deferred"; }, /directTools.*delegate_task/],
  ["changed bridge", f => { f.doctor.extension.sha256 = "0".repeat(64); }, /bridge SHA-256/],
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
    assert.match(result.stderr, /doctor|T3_PI_MCP_EXTENSION_PATH/);
  }
});

test("pin CLI rejects unknown, missing, repeated, or mixed arguments", t => {
  const f = fixture(t);
  for (const args of [["--unknown"], ["--doctor"], ["--state"], ["--bridge"], ["--state", "a", "--state", "b"], ["--doctor", "a", "--state", "b"]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage/);
  }
});

test("pin records a nightly matching the host map, bridge, direct tools, and prompt return shape", () => {
  const pin = JSON.parse(readFileSync(new URL("../rules/t3-pin.json", import.meta.url), "utf8"));
  const hostMap = readFileSync(new URL("../extra/skills/poteto-mode/references/host-capabilities.md", import.meta.url), "utf8");
  assert.match(pin.version, /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/);
  assert.equal(hostMap.match(/^- \*\*T3\.\*\* .*Pinned T3 version is `([^`]+)`\./m)?.[1], pin.version);
  assert.equal(pin.bridgeSha256, "8cc49f380d825f869d2b50b1fd512cb71fe8d3e869d78e6fcd8ea5d3e6fbb24f");
  assert.deepEqual(pin.statePaths, statePaths);
  assert.deepEqual(pin.directTools, tools);
  assert.deepEqual(pin.beforeAgentStartReturn, { systemPrompt: "string" });
});
