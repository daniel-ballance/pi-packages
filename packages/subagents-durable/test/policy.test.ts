import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileChildSelection, compilePolicy, isManagementTool, parseModel, parsePolicy, type DurablePolicy } from "../src/policy.js";

const MODEL = { provider: "fixture", model: "offline", thinking: "off" } as const;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "durable-policy-")));
  const project = join(root, "project"), nested = join(project, "nested"), outside = join(root, "project-other");
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  const policy: DurablePolicy = {
    allowedModels: [MODEL], allowedTools: ["read"], allowedRoots: ["."],
    maxAgents: 4, maxActiveAssignments: 2, maxPeerMessages: 0,
  };
  return { root, project, nested, outside, policy, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("omitted permissions and limits grant nothing; no built-in model or ambient cwd", () => {
  assert.deepEqual(parsePolicy({}), {
    allowedModels: [], allowedTools: [], allowedRoots: [], maxAgents: 0, maxActiveAssignments: 0, maxPeerMessages: 0,
  });
  const f = fixture();
  try {
    assert.throws(() => compilePolicy({}, "."), /baseDirectory must be absolute/);
    assert.throws(() => compileChildSelection(compilePolicy({}, f.project), { model: MODEL, cwd: f.project }), /not allowed/);
    assert.throws(() => compileChildSelection(compilePolicy({ allowedModels: [MODEL] }, f.project), { model: MODEL, cwd: f.project }), /outside allowedRoots/);
  } finally { f.close(); }
});

test("exact model strings normalize to the same provider/model/thinking tuple", () => {
  assert.deepEqual(parseModel("fixture/offline:off"), MODEL);
  assert.deepEqual(parseModel("host/vendor/model:revision:high"), { provider: "host", model: "vendor/model:revision", thinking: "high" });
  assert.deepEqual(parsePolicy({ allowedModels: [MODEL, "fixture/offline:off"] }).allowedModels, [MODEL]);
  for (const value of ["offline", "fixture/offline", "fixture/:off", "/offline:off", "fixture/offline:", "fixture/offline:auto", "fixture/*:off", " fixture/offline:off", "fixture/off line:off", { provider: "fixture", model: "offline" }]) {
    assert.throws(() => parseModel(value));
  }
  assert.throws(() => parseModel({ ...MODEL, apiKey: "not-a-real-key" }), /Unknown model field/);
});

test("malformed or unsupported policy fields fail closed instead of importing old Pi settings", () => {
  for (const value of [null, [], new Date(), false]) assert.throws(() => parsePolicy(value), /object/);
  for (const field of ["version", "models", "tools", "extensions", "mcp", "childSettings", "credentials", "inheritCredentials", "providerExtensions"]) {
    assert.throws(() => parsePolicy({ [field]: [] }), /Unknown policy field/);
  }
  for (const field of ["allowedModels", "allowedTools", "allowedRoots"]) {
    for (const value of ["*", null]) assert.throws(() => parsePolicy({ [field]: value }), /array/);
  }
  for (const field of ["maxAgents", "maxActiveAssignments", "maxPeerMessages"]) {
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      assert.throws(() => parsePolicy({ [field]: value }), /safe integer/);
    }
  }
  assert.throws(() => parsePolicy({ allowedTools: ["read", ""] }), /exact non-empty/);
  assert.throws(() => parsePolicy({ allowedTools: ["*"] }), /exact identifier/);
});

test("tools are separately opted in, and model provider and thinking match exactly", () => {
  const f = fixture();
  try {
    const policy = compilePolicy(f.policy, f.project);
    assert.deepEqual(compileChildSelection(policy, { model: "fixture/offline:off", cwd: f.nested }), { model: MODEL, tools: [], cwd: f.nested });
    assert.deepEqual(compileChildSelection(policy, { model: MODEL, tools: ["read", "read"], cwd: f.project }).tools, ["read"]);
    for (const model of [{ ...MODEL, provider: "other" }, { ...MODEL, model: "offline-other" }, { ...MODEL, thinking: "high" as const }]) {
      assert.throws(() => compileChildSelection(policy, { model, cwd: f.project }), /not allowed/);
    }
    assert.throws(() => compileChildSelection(policy, { model: MODEL, tools: ["write"], cwd: f.project }), /Tool is not allowed/);
    assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd: f.project, extensions: ["arbitrary.js"] } as never), /Unknown child selection field/);
  } finally { f.close(); }
});

test("nested subagent management cannot be enabled by a policy or a selection", () => {
  const f = fixture();
  try {
    for (const name of ["subagent", "subagents", "subagent_spawn", "subagents.spawn", "subagents/spawn", "subagents:spawn", "subagent-spawn", "SUBAGENT_SPAWN", "spawn_agent", "followup_task", "wait_agent", "list_agents", "interrupt_agent"]) {
      assert.equal(isManagementTool(name), true, name);
      assert.throws(() => compilePolicy({ ...f.policy, allowedTools: [name] }, f.project), /Nested subagent management/);
      assert.throws(() => compileChildSelection(compilePolicy(f.policy, f.project), { model: MODEL, tools: [name], cwd: f.project }), /Nested subagent management/);
    }
  } finally { f.close(); }
});

test("peer_send requires both a positive policy limit and explicit tool selection", () => {
  const f = fixture();
  try {
    assert.throws(() => compilePolicy({ ...f.policy, allowedTools: ["peer_send"] }, f.project), /positive maxPeerMessages/);
    const policy = compilePolicy({ ...f.policy, allowedTools: ["peer_send"], maxPeerMessages: 3 }, f.project);
    assert.deepEqual(compileChildSelection(policy, { model: MODEL, cwd: f.project }).tools, []);
    assert.deepEqual(compileChildSelection(policy, { model: MODEL, cwd: f.project, tools: ["peer_send"] }).tools, ["peer_send"]);
    const noTool = compilePolicy({ ...f.policy, maxPeerMessages: 3 }, f.project);
    assert.throws(() => compileChildSelection(noTool, { model: MODEL, cwd: f.project, tools: ["peer_send"] }), /not allowed/);
  } finally { f.close(); }
});

test("canonical directories stay within explicit roots, including symlink and prefix escapes", () => {
  const f = fixture();
  try {
    const escape = join(f.project, "escape"), insideLink = join(f.root, "alias");
    symlinkSync(f.outside, escape, "dir");
    symlinkSync(f.nested, insideLink, "dir");
    const policy = compilePolicy(f.policy, f.project);
    assert.equal(compileChildSelection(policy, { model: MODEL, cwd: insideLink }).cwd, f.nested);
    for (const cwd of [f.outside, escape, join(f.project, ".."), f.root]) {
      assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd }), /outside allowedRoots/);
    }
    assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd: "nested" }), /cwd must be absolute/);
    assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd: join(f.project, "missing") }), /ENOENT/);
    writeFileSync(join(f.project, "file"), "not a directory");
    assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd: join(f.project, "file") }), /Expected a directory/);
    assert.throws(() => compilePolicy({ ...f.policy, allowedRoots: ["file"] }, f.project), /Expected a directory/);
  } finally { f.close(); }
});

test("explicit symlink roots are pinned to their original realpath", () => {
  const f = fixture();
  try {
    const alias = join(f.root, "approved-root");
    symlinkSync(f.project, alias, "dir");
    const policy = compilePolicy({ ...f.policy, allowedRoots: [alias] }, f.root);
    assert.deepEqual(policy.allowedRoots, [f.project]);
    rmSync(alias);
    symlinkSync(f.outside, alias, "dir");
    assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd: alias }), /outside allowedRoots/);
    renameSync(f.project, join(f.root, "old-project"));
    symlinkSync(f.outside, f.project, "dir");
    assert.throws(() => compileChildSelection(policy, { model: MODEL, cwd: f.project }), /outside allowedRoots/);
  } finally { f.close(); }
});

test("policy and selection snapshots cannot be mutated to widen permissions", () => {
  const f = fixture();
  try {
    const models = [{ provider: "fixture", model: "offline", thinking: "off" }], tools = ["read"], roots = ["."];
    const policy = compilePolicy({ ...f.policy, allowedModels: models, allowedTools: tools, allowedRoots: roots }, f.project);
    models[0].model = "changed";
    tools.push("write");
    roots.push("..");
    assert.deepEqual(policy.allowedModels, [MODEL]);
    assert.deepEqual(policy.allowedTools, ["read"]);
    assert.deepEqual(policy.allowedRoots, [f.project]);
    assert.throws(() => (policy.allowedTools as string[]).push("write"), TypeError);
    const selectedTools = ["read"];
    const selection = compileChildSelection(policy, { model: MODEL, cwd: f.project, tools: selectedTools });
    selectedTools.push("write");
    assert.deepEqual(selection.tools, ["read"]);
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.allowedModels[0]) && Object.isFrozen(selection) && Object.isFrozen(selection.model));
  } finally { f.close(); }
});
