import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { builtInPolicy, DEFAULT_POLICY, loadedExtensions, SubagentPolicy, parsePolicy, type PolicyEnvironment } from "../extensions/subagents/src/policy.js";
import { authorizeWorkflow, parseWorkflow } from "../extensions/subagents/src/workflow-definition.js";
import { tempRoot } from "./support/temp-root.js";

test("built-in policy is a multi-provider menu with delegation, nesting and loops on, for use with no setup", () => {
  const policy = parsePolicy(DEFAULT_POLICY);
  const ids = policy.models.map(model => model.id);
  for (const id of ["openai-codex/gpt-6-luna:medium", "openai-codex/gpt-6.2-sol:xhigh", "openai-codex/gpt-6.2-sol:max", "xai/grok-4.7:high", "anthropic/claude-opus-5-5:high"]) assert.ok(ids.includes(id), id);
  for (const tool of ["read", "bash", "edit", "write", "todo", "subagent_spawn", "subagent_catalog"]) assert.ok(policy.tools.includes(tool), tool);
  assert.equal(policy.maxDepth, 2);
  assert.equal(policy.loops?.enabled, true);
  assert.equal(policy.peerMessageLimit, 0);
  assert.deepEqual(policy.maxChildren, { kind: "capped", max: 6 });
  assert.match(JSON.stringify(DEFAULT_POLICY), /"maxChildren":6/);
  assert.deepEqual(policy.workingDirectories, ["."]);
  for (const resources of [policy.extensions, policy.skills, policy.promptTemplates, policy.themes]) assert.deepEqual(resources, []);
});

test("built-in policy offers Claude and Antigravity children exactly when loaded once", () => {
  const withProviders = parsePolicy(builtInPolicy(new Map([
    ["claude-subscription", ["/x/claude-subscription/index.ts"]],
    ["antigravity-provider", ["/x/antigravity-provider/index.ts"]],
  ])));
  assert.deepEqual(withProviders.extensions, ["loaded:claude-subscription", "loaded:antigravity-provider"]);
  assert.deepEqual(withProviders.providerExtensions, {
    "claude": "loaded:claude-subscription",
    "antigravity": "loaded:antigravity-provider",
  });
  assert.ok(withProviders.models.some(model => model.id === "claude/claude-opus-5-5:high"));
  assert.ok(withProviders.models.some(model => model.id === "antigravity/gemini-4-neon:xhigh"));
  assert.ok(withProviders.models.some(model => model.id === "antigravity/gemini-4-hydrogen:high"));
  const outside = withProviders.models.map(model => model.id).filter(id => {
    if (/haiku|fable|astra|carbon|argon/.test(id)) return true;
    if (id.startsWith("openai-codex/gpt-6-luna")) return !/:(medium|high|xhigh|max)$/.test(id);
    if (/^(openai-codex|openai)\//.test(id)) return !/:(low|medium|high|xhigh|max)$/.test(id);
    if (/^(anthropic|claude|xai)\//.test(id)) return !/:(low|medium|high)$/.test(id);
    if (id.startsWith("antigravity/gemini-4-")) return !/:(low|medium|high|xhigh)$/.test(id);
    return true;
  });
  assert.deepEqual(outside, []);
  assert.equal(builtInPolicy(new Map()), DEFAULT_POLICY);
  assert.equal(builtInPolicy(new Map([["web-search", ["/x/web-search/index.ts"]]])), DEFAULT_POLICY);
  assert.equal(builtInPolicy(new Map([["claude-subscription", ["/x/claude-subscription/index.ts", "/y/claude-subscription/index.ts"]]])), DEFAULT_POLICY);
  assert.equal(builtInPolicy(new Map([["antigravity-provider", ["/x/antigravity-provider/index.ts", "/y/antigravity-provider/index.ts"]]])), DEFAULT_POLICY);
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
  const root = tempRoot("subagent-policy-");
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

test("a tool from a loaded extension is selectable with its advertised resource or absent", () => {
  const f = fixture();
  try {
    const todo = join(f.root, "todo.ts");
    writeFileSync(todo, "export default () => {}");
    f.environment.tools = () => ["read", "todo", "codemode"];
    f.environment.toolSources = () => ({ read: "builtin:read", todo, codemode: "builtin:codemode" });
    const loaded = loadedExtensions([{ sourceInfo: { path: todo } }]);
    f.environment.builtIn = builtInPolicy(loaded);
    f.environment.loadedExtensions = () => loaded;
    const builtIn = new SubagentPolicy(f.environment);
    const select = { tools: ["todo"], model: TEST_MODELS[0].id };
    assert.ok(builtIn.catalog().tools.includes("todo"));
    assert.equal(builtIn.catalog().toolExtensions.todo, todo);
    assert.throws(() => builtIn.compile(f.cwd, select), /requires selecting/);
    assert.deepEqual(builtIn.compile(f.cwd, { ...select, extensions: [todo] }).childPolicy!.toolSources, { todo });
    // Do not add an extension grant to a user's policy.
    f.put(f.global, { version: 1, models: TEST_MODELS, tools: ["read", "todo", "codemode"] });
    const user = new SubagentPolicy(f.environment);
    assert.deepEqual(user.catalog().tools, ["read"]);
    assert.ok(user.diagnostics.some(d => d.includes("todo") && d.includes(todo)));
    f.put(f.global, { ...user.config, maxChildren: 1, extensions: ["builtin:codemode"] });
    const managed = new SubagentPolicy(f.environment);
    assert.equal(managed.catalog().toolExtensions.codemode, "builtin:codemode");
    assert.equal(managed.compile(f.cwd, { ...select, tools: ["codemode"], extensions: ["builtin:codemode"] }).childPolicy!.toolSources.codemode, f.environment.guardPath);
  } finally { f.cleanup(); }
});

test("an explicit null is not an omitted policy field", () => {
  const f = fixture();
  try {
    for (const field of ["workingDirectories", "extensions", "skills", "themes", "promptTemplates", "tools", "alwaysExtensions", "alwaysTools", "maxDepth"]) {
      f.put(f.project, { version: 1, models: TEST_MODELS, [field]: null });
      const p = new SubagentPolicy(f.environment);
      assert.equal(p.catalog().spawnEnabled, false, field);
      assert.ok(p.diagnostics.some(d => d.includes(field)), field);
    }
  } finally { f.cleanup(); }
});

test("workflow authorization refuses delegation and forced parent messaging before dispatch", () => {
  const f = fixture();
  try {
    for (const forbidden of ["subagent_list", "parent_send"]) {
      f.put(f.global, { ...DEFAULT_POLICY, tools: [forbidden], alwaysTools: forbidden === "parent_send" ? [forbidden] : [] });
      const policy = new SubagentPolicy(f.environment);
      const worker = { model: TEST_MODELS[0].id, tools: forbidden === "parent_send" ? [] : [forbidden] };
      for (const validator of [false, true]) {
        const task = { id: "w", kind: "task", instructions: "review", worker };
        const check = { id: "check", kind: "check", input: "w", validator: { kind: "agent", instructions: "check", worker } };
        const def = parseWorkflow({ version: 1, name: "invalid", cwd: f.cwd, limits: { concurrency: 1, maxAttempts: 2, timeoutSeconds: 2 },
          steps: validator ? [{ ...task, worker: { ...worker, tools: [] } }, check] : [task] });
        assert.throws(() => authorizeWorkflow(def, policy), new RegExp(forbidden));
      }
    }
  } finally { f.cleanup(); }
});

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

function extensionFile(root: string, install: string) {
  const file = join(root, install, "claude-subscription/extensions/claude-subscription/index.ts");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export default function() {};");
  return file;
}

test("loaded: names the one file the parent loaded, in extensions and providerExtensions alike", () => {
  const f = fixture();
  try {
    const file = extensionFile(f.root, "clone");
    const luna = f.environment.models()[0];
    f.environment.models = () => [luna, { ...luna, provider: "claude", id: "claude-opus-5-5", thinkingLevels: ["high"] }];
    f.environment.loadedExtensions = () => loadedExtensions([{ sourceInfo: { path: "builtin:read" } }, { sourceInfo: { path: file } }]);
    f.put(f.global, {
      version: 1, models: [{ id: "claude/claude-opus-5-5:high" }],
      extensions: ["loaded:claude-subscription"], providerExtensions: { "claude": "loaded:claude-subscription" },
    });
    const policy = new SubagentPolicy(f.environment);
    assert.deepEqual(policy.catalog().extensions, [file]);
    assert.deepEqual(policy.diagnostics, []);
    const compiled = policy.compile(f.cwd, { model: "claude/claude-opus-5-5:high", tools: [] });
    assert.deepEqual(compiled.selection!.extensions, [file]);
    assert.ok(compiled.cliArgs!.includes(file));
  } finally { f.cleanup(); }
});

test("a loaded: reference that is not loaded, or loaded from two files, is a diagnostic, never a guess", () => {
  const f = fixture();
  try {
    const checkout = extensionFile(f.root, "checkout"), clone = extensionFile(f.root, "clone");
    f.put(f.global, { version: 1, models: TEST_MODELS, extensions: ["loaded:claude-subscription"] });
    const absent = new SubagentPolicy(f.environment);
    assert.deepEqual(absent.catalog().extensions, []);
    assert.ok(absent.diagnostics.some(d => d.includes("loaded:claude-subscription") && /not loaded/.test(d)), absent.diagnostics.join("\n"));
    f.environment.loadedExtensions = () => loadedExtensions([checkout, clone, checkout].map(path => ({ sourceInfo: { path } })));
    const twice = new SubagentPolicy(f.environment);
    assert.deepEqual(twice.catalog().extensions, []);
    assert.ok(twice.diagnostics.some(d => d.includes("2 files") && d.includes(checkout) && d.includes(clone)), twice.diagnostics.join("\n"));
  } finally { f.cleanup(); }
});

test("parse accepts loaded: only where an extension file belongs, and only with a name", () => {
  const extension = { extensions: ["loaded:claude-subscription"], alwaysExtensions: ["loaded:claude-subscription"], providerExtensions: { "claude": "loaded:claude-subscription" } };
  assert.deepEqual(parsePolicy({ ...DEFAULT_POLICY, ...extension }).providerExtensions, extension.providerExtensions);
  for (const key of ["skills", "promptTemplates", "themes", "workingDirectories"]) {
    assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, [key]: ["loaded:claude-subscription"] }), /loaded:/, key);
  }
  assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, extensions: ["loaded:"] }), /loaded:/);
  assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, extensions: ["loaded: "] }), /loaded:/);
  assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, extensions: ["loaded:"], providerExtensions: { "claude": "loaded:" } }), /loaded:/);
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
