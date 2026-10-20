import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtInPolicy, DEFAULT_POLICY, SubagentPolicy, parsePolicy, type PolicyEnvironment } from "../extensions/subagents/src/policy.js";

test("built-in policy is a multi-provider menu with delegation, nesting and loops on, for use with no setup", () => {
  const policy = parsePolicy(DEFAULT_POLICY);
  const ids = policy.models.map(model => model.id);
  for (const id of ["openai-codex/gpt-6-luna:medium", "openai-codex/gpt-6.1-sol:high", "xai/grok-4.7:xhigh", "anthropic/claude-opus-5-5:xhigh"]) assert.ok(ids.includes(id), id);
  for (const tool of ["read", "bash", "edit", "write", "todo", "subagent_spawn", "subagent_catalog"]) assert.ok(policy.tools.includes(tool), tool);
  assert.equal(policy.maxDepth, 2);
  assert.equal(policy.loops?.enabled, true);
  assert.equal(policy.peerMessageLimit, 0);
  assert.deepEqual(policy.maxChildren, { kind: "capped", max: 6 });
  assert.match(JSON.stringify(DEFAULT_POLICY), /"maxChildren":6/);
  assert.deepEqual(policy.workingDirectories, ["."]);
  for (const resources of [policy.extensions, policy.skills, policy.promptTemplates, policy.themes]) assert.deepEqual(resources, []);
  const withClaude = parsePolicy(builtInPolicy("/x/claude-subscription/index.ts"));
  assert.deepEqual(withClaude.extensions, ["/x/claude-subscription/index.ts"]);
  assert.deepEqual(withClaude.providerExtensions, { "claude-subscription": "/x/claude-subscription/index.ts" });
  assert.ok(withClaude.models.some(model => model.id === "claude-subscription/claude-opus-5-5:xhigh"));
  assert.equal(builtInPolicy(undefined), DEFAULT_POLICY);
});

test("with no policy file, unreachable built-in models are dropped without diagnostics", () => {
  const f = fixture();
  try {
    const p = new SubagentPolicy(f.environment);
    assert.equal(p.source, "built-in");
    assert.deepEqual(p.catalog().models.map(model => model.id), ["openai-codex/gpt-6-luna:medium"]);
    assert.equal(p.diagnostics.some(d => d.includes("Unavailable model")), false);
  } finally { f.cleanup(); }
});

// Multi-option validation must not depend on the size of the shipped fallback.
const TEST_MODELS = [
  { id: "openai-codex/gpt-6-luna:medium", description: "User-supplied guidance." },
  { id: "openai-codex/gpt-6-luna:max" },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subagent-policy-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(agentDir);
  const environment: PolicyEnvironment = {
    cwd, agentDir, projectTrusted: true, guardPath: "/internal/child-guard.ts",
    models: () => [{ provider: "openai-codex", id: "gpt-6-luna", input: ["text", "image"], contextWindow: 272000, maxTokens: 128000, cost: { input: 1 }, thinkingLevels: ["medium", "max"] }],
    tools: () => ["read", "bash", "subagent_spawn"],
  };
  const global = join(agentDir, "subagents.json"), project = join(cwd, ".pi/subagents.json");
  return { root, cwd, environment, global, project, put: (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("built-in fallback remains usable, denies unlisted levels, and never substitutes an available model", () => {
  const f = fixture();
  try {
    const policy = new SubagentPolicy(f.environment);
    assert.equal(policy.catalog().spawnEnabled, true);
    assert.deepEqual(policy.catalog().models.map(m => m.id), [DEFAULT_POLICY.models[0].id]);
    assert.equal(policy.compile(f.cwd, { model: DEFAULT_POLICY.models[0].id, tools: [] }).model, DEFAULT_POLICY.models[0].id);
    assert.throws(() => policy.compile(f.cwd, { model: TEST_MODELS[1].id, tools: [] }), /not currently allowed/);
    const original = f.environment.models;
    f.environment.models = () => original().map(model => ({ ...model, thinkingLevels: ["max"] }));
    assert.equal(policy.catalog().spawnEnabled, false);
    assert.throws(() => policy.compile(f.cwd, { model: DEFAULT_POLICY.models[0].id, tools: [] }), /No spawnable/);
  } finally { f.cleanup(); }
});

test("catalog retains runtime metadata and user guidance for all permitted thinking entries", () => {
  const f = fixture();
  try {
    f.put(f.global, { version: 1, models: TEST_MODELS });
    const policy = new SubagentPolicy(f.environment);
    const metadata = { input: ["text", "image"], contextWindow: 272000, maxTokens: 128000, cost: { input: 1 } };
    assert.deepEqual(policy.catalog().models, TEST_MODELS.map(entry => ({ description: undefined, ...entry, ...metadata })));
    assert.equal(policy.compile(f.cwd, { model: TEST_MODELS[1].id, tools: [] }).model, TEST_MODELS[1].id);
    assert.throws(() => policy.compile(f.cwd, { model: "openai-codex/gpt-6-luna:high", tools: [] }), /not currently allowed/);
  } finally { f.cleanup(); }
});

test("deterministic workflow commands require explicit bash permission and an allowed directory", () => {
  const f = fixture();
  try {
    f.put(f.global, { version: 1, models: DEFAULT_POLICY.models, tools: ["read"] });
    const readonly = new SubagentPolicy(f.environment);
    assert.equal(readonly.directory(f.cwd), f.cwd);
    assert.throws(() => readonly.commandDirectory(f.cwd), /require bash/);
    f.put(f.global, { version: 1, models: DEFAULT_POLICY.models, tools: ["bash"] });
    const allowed = new SubagentPolicy(f.environment);
    assert.equal(allowed.commandDirectory(f.cwd), f.cwd);
    assert.throws(() => allowed.commandDirectory(f.root), (error: Error) => {
      assert.equal(error.message.includes(`cwd ${f.root} `), true, error.message);
      assert.equal(error.message.includes(realpathSync(f.cwd)), true, error.message);
      return true;
    });
    writeFileSync(f.global, "broken");
    assert.throws(() => new SubagentPolicy(f.environment).commandDirectory(f.cwd), /require bash/);
  } finally { f.cleanup(); }
});

test("built-in -> global -> trusted project: whole-file replacement, omitted capabilities stay disabled", () => {
  const f = fixture();
  try {
    assert.equal(new SubagentPolicy(f.environment).source, "built-in");
    f.put(f.global, { ...DEFAULT_POLICY, tools: ["bash"] });
    assert.deepEqual(new SubagentPolicy(f.environment).catalog().tools, ["bash"]);
    f.put(f.project, { version: 1, models: DEFAULT_POLICY.models, tools: ["read"] });
    const project = new SubagentPolicy(f.environment).catalog();
    assert.equal(project.source, f.project);
    assert.deepEqual(project.tools, ["read"]);
    assert.equal(project.systemPrompt, false);
    assert.deepEqual(project.extensions, []);
    assert.equal(new SubagentPolicy({ ...f.environment, projectTrusted: false }).source, f.global);
    rmSync(f.project);
    assert.equal(new SubagentPolicy(f.environment).source, f.global);
    rmSync(f.global);
    assert.equal(new SubagentPolicy(f.environment).source, "built-in");
  } finally { f.cleanup(); }
});

test("malformed selected policy fails closed, never falls through to broader defaults", () => {
  const f = fixture();
  try {
    writeFileSync(f.project, "invalid json");
    const policy = new SubagentPolicy(f.environment);
    assert.equal(policy.catalog().spawnEnabled, false);
    assert.equal(policy.source, f.project);
    assert.throws(() => policy.compile(f.cwd, { model: DEFAULT_POLICY.models[0].id, tools: [] }), /No spawnable/);
    assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, cliArgs: ["--no-tools"] }), /Unknown/);
    assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, models: [{ id: "luna" }] }), /exact/);
  } finally { f.cleanup(); }
});

test("catalog removes unavailable entries, recursive tools and missing resources; diagnostics remain user-facing", () => {
  const f = fixture();
  try {
    f.put(f.global, { ...DEFAULT_POLICY, maxDepth: undefined, loops: undefined, models: [...TEST_MODELS, { id: "anthropic/missing:medium" }, { id: "openai-codex/gpt-6-luna:xhigh" }], tools: ["read", "absent", "subagent_spawn"], extensions: ["missing.ts"] });
    const p = new SubagentPolicy(f.environment);
    const catalog = p.catalog();
    assert.equal(catalog.models.length, 2);
    assert.deepEqual(catalog.tools, ["read"]);
    assert.deepEqual(catalog.extensions, []);
    assert.equal(JSON.stringify(catalog).includes("anthropic/missing"), false);
    assert.ok(p.diagnostics.some(d => d.includes("Forbidden recursive")));
    assert.ok(p.diagnostics.some(d => d.includes("anthropic/missing")));
    f.environment.models = () => [];
    assert.equal(p.catalog().spawnEnabled, false);
    assert.throws(() => p.compile(f.cwd, { model: DEFAULT_POLICY.models[0].id, tools: [] }), /No spawnable/);
  } finally { f.cleanup(); }
});

test("compile enforces exact composition, prompt modes, scoped directories and explicit resources", () => {
  const f = fixture();
  try {
    const extension = join(f.environment.agentDir, "allowed.ts");
    writeFileSync(extension, "export default function() {};");
    f.put(f.global, { ...DEFAULT_POLICY, tools: ["read", "bash"], extensions: ["allowed.ts"] });
    const policy = new SubagentPolicy(f.environment);
    const selection = { model: DEFAULT_POLICY.models[0].id, tools: ["read"], extensions: [extension], systemPrompt: "You review code.", appendSystemPrompt: "Be concise." };
    const compiled = policy.compile(f.cwd, selection);
    assert.equal(compiled.inheritExtensions, false);
    assert.ok(compiled.cliArgs!.includes("--no-skills"));
    assert.ok(compiled.cliArgs!.includes("--system-prompt"));
    assert.ok(compiled.cliArgs!.includes("--append-system-prompt"));
    assert.ok(compiled.cliArgs!.includes(extension));
    assert.equal(compiled.cliArgs!.at(-1), f.environment.guardPath);
    const unchanged = policy.compile(f.cwd, { model: selection.model, tools: [] });
    assert.ok(!unchanged.cliArgs!.includes("--system-prompt"));
    assert.ok(!unchanged.cliArgs!.includes("--append-system-prompt"));
    assert.throws(() => policy.compile(f.cwd, { ...selection, model: "gpt-6-luna:medium" }), /not currently allowed/);
    assert.throws(() => policy.compile(f.cwd, { ...selection, tools: ["subagent_spawn"] }), /not allowed/);
    assert.throws(() => policy.compile(f.cwd, { ...selection, extensions: ["/tmp/not-allowed.ts"] }), /not allowed/);
    symlinkSync(f.environment.agentDir, join(f.cwd, "escape"));
    const requested = join(f.cwd, "escape");
    assert.throws(() => policy.compile(requested, selection), (error: Error) => {
      assert.equal(error.message.includes(requested), true);
      assert.equal(error.message.includes(realpathSync(f.cwd)), true);
      assert.match(error.message, /outside allowed workingDirectories/);
      assert.match(error.message, /Relative roots resolve against the launch cwd/);
      return true;
    });
    rmSync(extension);
    assert.throws(() => policy.compile(f.cwd, selection), /not allowed/);
  } finally { f.cleanup(); }
});

test("config snapshot changes only after reload, availability is rechecked every time", () => {
  const f = fixture();
  try {
    f.put(f.global, { version: 1, models: TEST_MODELS });
    const p = new SubagentPolicy(f.environment);
    f.put(f.global, { version: 1, models: [] });
    assert.equal(p.catalog().models.length, 2);
    assert.equal(new SubagentPolicy(f.environment).catalog().models.length, 0);
    f.environment.models = () => [];
    assert.equal(p.catalog().models.length, 0);
  } finally { f.cleanup(); }
});
