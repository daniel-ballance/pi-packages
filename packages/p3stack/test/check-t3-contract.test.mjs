import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../generator/check-t3-contract.mjs", import.meta.url));
const directTools = ["orchestrator_capabilities", "delegate_task", "task_status"];
const manifest = "rules/t3-contract.json";
const map = "extra/skills/poteto-mode/references/host-t3.md";
const hash = text => createHash("sha256").update(text).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-t3-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const bridge = "export const fixtureBridge = true;\n";
  const contract = { directTools, requiredTools: ["html_preview"], optionalTools: ["watch_pull_request"] };
  const hostMap = [...directTools, "watch_pull_request", "html_preview"].map(name => `\`mcp__t3-code__${name}\``).join("\n");
  write(manifest, contract);
  write("home/.t3/runtime/service-state.json", { activeVersion: "fixture-version" });
  write("home/.t3/caches/pi-t3-mcp-extension.ts", bridge);
  write("empty-home/.keep", "");
  write(map, hostMap);
  const doctor = {
    tools: [...directTools.map(name => ({ name: `mcp__t3-code__${name}`, exposure: "direct" })), { name: "mcp__t3-code__html_preview", exposure: "deferred" }],
    claudeSubscriptionFiles: [],
    problems: [],
  };
  write("doctor.json", doctor);
  const run = (args = [], home = "home", checker = cli) => spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8", env: { ...process.env, HOME: join(root, home), P3STACK_PACKAGE_DIR: root },
  });
  return { root, write, contract, hostMap, doctor, run };
}

for (const home of ["home", "empty-home"]) {
  test(`default checks the static contract without an installed host in ${home}`, t => {
    const f = fixture(t);
    f.write("home/.t3/runtime/service-state.json", "not json");
    rmSync(join(f.root, "home/.t3/caches/pi-t3-mcp-extension.ts"));
    const result = f.run([], home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /static/i);
  });
}

test("default is independent of installed release and bridge bytes", t => {
  const f = fixture(t);
  f.write("home/.t3/runtime/service-state.json", { activeVersion: "other-version" });
  f.write("home/.t3/caches/pi-t3-mcp-extension.ts", "other bridge");
  assert.equal(f.run().status, 0);
});

for (const [name, mutate, diagnostic] of [
  ["missing direct tool in the map", f => f.write(map, ""), /host map.*missing.*delegate_task/],
  ["unclassified operation in the map", f => f.write(map, f.hostMap + "\nTry \`mcp__t3-code__preview_open\`."), /unclassified.*preview_open/],
  ["malformed JSON", f => f.write(manifest, "not json"), /t3-contract\.json could not be read/],
  ["empty direct tools", f => f.write(manifest, { ...f.contract, directTools: [] }), /Invalid rules/],
  ["missing required list", f => f.write(manifest, { ...f.contract, requiredTools: undefined }), /requiredTools/],
  ["wildcard instead of an operation", f => f.write(manifest, { ...f.contract, requiredTools: ["preview_*"] }), /invalid.*preview_\*/],
  ["duplicate direct tools", f => f.write(manifest, { ...f.contract, directTools: ["task_status", "task_status"] }), /duplicate.*task_status/],
  ["required tool also marked optional", f => f.write(manifest, { ...f.contract, optionalTools: ["html_preview"] }), /duplicate.*html_preview/],
  ["undocumented optional tool", f => f.write(manifest, { ...f.contract, optionalTools: ["missing_tool"] }), /host map.*missing_tool/],
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
  rmSync(join(f.root, manifest)); // Fingerprints do not depend on the capability contract.
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

test("a required operation stays required when the host map removes its backticks", t => {
  const f = fixture(t);
  f.write(map, f.hostMap.replaceAll("`", ""));
  const check = f.run();
  assert.equal(check.status, 0, check.stderr);
  f.doctor.tools.pop();
  f.write("doctor.json", f.doctor);
  const result = f.run(["--doctor", join(f.root, "doctor.json")]);
  assert.equal(result.status, 1, "doctor must report the missing required operation");
  assert.match(result.stderr, /html_preview/);
});

test("required tools can have any non-hidden exposure; optional watches may be absent", t => {
  const f = fixture(t);
  for (const exposure of ["deferred", "model-only", "codemode", "direct"]) {
    f.doctor.tools.find(tool => tool.name === "mcp__t3-code__html_preview").exposure = exposure;
    f.write("doctor.json", f.doctor);
    const result = f.run(["--doctor", join(f.root, "doctor.json")]);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("doctor verifies required capabilities independently of release, hash, and additive tools", t => {
  const f = fixture(t);
  f.doctor.extension = { path: "/old/bridge.ts", sha256: "0".repeat(64) }; // Older doctor dumps include a fingerprint.
  rmSync(join(f.root, map)); // Inventory uses the contract, not the prose.
  f.doctor.tools.push({ name: "mcp__t3-code__new_direct_tool", exposure: "direct" });
  f.doctor.tools.push({ name: "mcp__t3-code__new_deferred_tool", exposure: "deferred" });
  f.write("doctor.json", f.doctor);
  const result = f.run(["--doctor", join(f.root, "doctor.json")], "empty-home");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inventory/i);
  assert.match(result.stdout, /behavior.*not tested/i);
});

test("doctor reads the producer's inventory without a bridge fingerprint or optional provider", async t => {
  const f = fixture(t);
  const { doctor } = await import("../extensions/p3stack/src/doctor.ts");
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { ...env, PI_CODING_AGENT_DIR: f.root, T3_MCP_URL: "http://fixture.invalid" };
  delete process.env.T3_PI_MCP_EXTENSION_PATH;
  const dump = doctor({
    getCommands: () => [],
    getAllTools: () => [...f.doctor.tools, ...["model-only", "codemode", "hidden"].map((exposure, i) => ({ name: `mcp__t3-code__extra_${i}`, exposure }))],
  });
  const result = f.run(["--doctor", dump]);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, mutate, diagnostic] of [
  ["hidden required tool", f => { f.doctor.tools.at(-1).exposure = "hidden"; }, /html_preview/],
  ["renamed direct tool", f => { f.doctor.tools[1].name = "mcp__t3-code__delegate_task_renamed"; }, /delegate_task/],
  ["missing required tool", f => { f.doctor.tools.pop(); }, /html_preview/],
  ["changed required exposure", f => { f.doctor.tools[1].exposure = "deferred"; }, /direct tool.*delegate_task/],
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

test("doctor rejects a missing or malformed inventory", t => {
  const f = fixture(t);
  const absent = f.run(["--doctor", join(f.root, "absent.json")]);
  assert.equal(absent.status, 1);
  for (const dump of [{}, { tools: [null], problems: [] }, { tools: f.doctor.tools }, "not json"]) {
    f.write("doctor.json", dump);
    const result = f.run(["--doctor", join(f.root, "doctor.json")]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doctor/);
  }
});

test("installed maintenance skills using the former checker still see inventory failures", t => {
  const f = fixture(t);
  f.write("doctor.json", { tools: [], problems: [] });
  const run = f.run(["--doctor", join(f.root, "doctor.json")], "empty-home", join(dirname(cli), "check-t3-pin.mjs"));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /delegate_task/);
});

test("CLI rejects unknown, missing, repeated, or mixed modes", t => {
  const f = fixture(t);
  for (const args of [["--unknown"], ["--doctor"], ["--state"], ["--bridge"], ["--installed", "--installed"], ["--state", "a"], ["--bridge", "a"], ["--installed", "--state", "a", "--state", "b"], ["--doctor", "a", "--installed"], ["--doctor", "a", "--state", "b"]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage/);
  }
});

test("a compact inventory satisfies the repository contract without root-only PR watches", t => {
  const f = fixture(t);
  const contract = JSON.parse(readFileSync(new URL("../rules/t3-contract.json", import.meta.url), "utf8"));
  f.write(manifest, contract);
  const names = Object.values(contract).flat().filter(name => !["watch_pull_request", "unwatch_pull_request"].includes(name));
  const tools = names.map(name => ({ name: `mcp__t3-code__${name}`, exposure: directTools.includes(name) ? "direct" : "deferred" }));
  const inventory = () => {
    f.write("doctor.json", { tools, problems: [] });
    return f.run(["--doctor", join(f.root, "doctor.json")]);
  };
  const compact = inventory();
  assert.equal(compact.status, 0, compact.stderr);
  for (const name of directTools) tools.find(tool => tool.name === `mcp__t3-code__${name}`).exposure = "deferred";
  tools.find(tool => tool.name === "mcp__t3-code__preview_act").exposure = "hidden";
  const incompatible = inventory();
  assert.equal(incompatible.status, 1);
  for (const name of [...directTools, "preview_act"]) assert.ok(incompatible.stderr.includes(name), incompatible.stderr);
});
