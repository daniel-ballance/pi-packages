import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { gitAt, gitEnv } from "../packages/p3stack/generator/git-env.mjs";
import { piSdk } from "./pi-sdk.mjs";

const { DefaultResourceLoader, parseArgs, SettingsManager } = await import(piSdk);
const tempRoot = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const root = fileURLToPath(new URL("..", import.meta.url));
const githubSource = "git:github.com/daniel-ballance/pi-packages";
const rootExtensions = [
  "packages/claude-subscription/extensions/claude-subscription/index.ts",
  "packages/p3stack/extensions/p3stack/index.ts",
  "packages/p3stack/subagents/extensions/subagents/index.ts",
  "packages/p3stack/todo/extensions/todo/index.ts",
  "packages/computer-use/extensions/computer-use/index.ts",
  "packages/self-reload/extensions/self-reload/index.ts",
  "packages/web-search/extensions/web-search/index.ts",
  "packages/t3-agent/extensions/t3-agent/index.ts",
];
const packageDirs: Record<string, string> = {
  "claude-subscription": "packages/claude-subscription",
  "computer-use": "packages/computer-use",
  "mcp-client": "packages/mcp-client",
  p3stack: "packages/p3stack",
  "self-reload": "packages/self-reload",
  subagents: "packages/p3stack/subagents",
  "t3-agent": "packages/t3-agent",
  todo: "packages/p3stack/todo",
  "web-search": "packages/web-search",
};
type SkillRow = { action: string; name?: string };
const registry: SkillRow[] = JSON.parse(await readFile(join(root, "packages/p3stack/registry/skills.json"), "utf8"));
const hosts = ["cli", "t3"] as const;
const nativeSkills = (host: typeof hosts[number]) => host === "cli" ? ["subagents", "workflows"] : [];
function assertSkillMenu(actual: string[], native: string[], rows = registry) {
  assert.deepEqual(actual, [...native, ...rows.filter(row => row.action === "emit").map(row => row.name)].sort());
}

async function load(packages: string[], base: string, options: { host?: typeof hosts[number]; agentDir?: string; extensions?: string[] } = {}) {
  const temp = tempRoot("pi-package-discovery-");
  const previousHost = process.env.T3_MCP_URL;
  if (options.host === "t3") process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  else delete process.env.T3_MCP_URL;
  const previousHome = process.env.HOME;
  process.env.HOME = temp; // Also isolate the conventional ~/.agents/skills path.
  try {
    gitAt(temp, "init", "--quiet", "--template=");
    const loader = new DefaultResourceLoader({
      cwd: temp, agentDir: options.agentDir ?? temp,
      settingsManager: SettingsManager.inMemory({ packages }),
      additionalExtensionPaths: options.extensions,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    // reload() loads package manifests and factories. A session then extends the
    // loader with resources_discover results; exercise that boundary without opening Pi.
    const native = loader.getExtensions().extensions.find(ext => ext.path.endsWith("/extensions/subagents/index.ts"));
    if (native) {
      assert.ok(!loader.getSkills().skills.some(s => ["subagents", "workflows"].includes(s.name)), "native skills are not static resources");
      for (const discover of native.handlers.get("resources_discover") ?? []) {
        const result = await discover({ type: "resources_discover", cwd: temp, reason: "startup" }, { mode: "rpc" });
        loader.extendResources({ skillPaths: result.skillPaths?.map(path => ({ path, metadata: { source: native.path, scope: "temporary", origin: "top-level" } })) });
      }
    }
    return {
      extensions: loader.getExtensions().extensions.map(extension => relative(base, extension.path)),
      skills: loader.getSkills().skills.map(skill => skill.name).sort(),
      skillPaths: Object.fromEntries(loader.getSkills().skills.map(skill => [skill.name, relative(base, skill.filePath)])),
      skillDiagnostics: loader.getSkills().diagnostics,
    };
  } finally {
    if (previousHost === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previousHost;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
}

/** What GitHub serves: every tracked file, without submodule contents, which Pi never initializes. */
function publish(bare: string, work: string) {
  const entries = gitAt(root, "ls-files", "-s", "-z").split("\0").filter(Boolean);
  for (const entry of entries) {
    const [, mode, path] = /^(\d+) \S+ \d+\t(.+)$/s.exec(entry) as unknown as [string, string, string];
    if (mode === "160000" || !existsSync(join(root, path))) continue;
    mkdirSync(dirname(join(work, path)), { recursive: true });
    copyFileSync(join(root, path), join(work, path));
  }
  const git = (...args: string[]) => gitAt(work, ...args);
  git("init", "--quiet", "--template=");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", `core.hooksPath=${join(work, ".no-hooks")}`, "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Package fixture");
  gitAt(work, "clone", "--quiet", "--bare", work, bare);
}

test("discovery rejects a reference shipped as a command in place of an emitted skill", async () => {
  const temp = tempRoot("bad-package-menu-");
  try {
    const rows = registry.filter(row => ["tdd", "regression-test"].includes(row.name ?? ""));
    const dir = join(temp, "skills/regression-test");
    mkdirSync(dir, { recursive: true });
    await writeFile(join(temp, "package.json"), JSON.stringify({ name: "bad-menu", pi: { skills: ["./skills"] } }));
    await writeFile(join(dir, "SKILL.md"), "---\nname: regression-test\ndescription: Check a regression.\n---\n");
    const result = await load([temp], temp);
    assert.deepEqual(result.skills, ["regression-test"]);
    assert.throws(() => assertSkillMenu(result.skills, [], rows), /tdd/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("pi install git:github.com/daniel-ballance/pi-packages loads the six packages, and T3's launch argument loads claude-subscription once, first", async () => {
  const temp = tempRoot("pi-git-install-");
  const agentDir = join(temp, "agent"), home = join(temp, "home");
  try {
    publish(join(temp, "github/daniel-ballance/pi-packages"), join(temp, "work"));
    mkdirSync(home);
    // A user's environment carries no npm_config_* values, so the clone's .npmrc governs the
    // install. npm reads only the cache primed by the root install; pnpm CI permits downloads
    // since its store is separate from npm's cache.
    const environment = Object.fromEntries(Object.entries(gitEnv()).filter(([key]) => !/^npm_config_/i.test(key)));
    const npmCache = process.env.npm_config_cache ??
      execFileSync("npm", ["config", "get", "cache"], { cwd: temp, env: environment, encoding: "utf8" }).trim();
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { DefaultPackageManager, SettingsManager } from ${JSON.stringify(piSdk)};
      const manager = new DefaultPackageManager({ cwd: ${JSON.stringify(temp)}, agentDir: ${JSON.stringify(agentDir)},
        settingsManager: SettingsManager.inMemory() });
      await manager.install(${JSON.stringify(githubSource)});
      console.log(JSON.stringify(manager.getInstalledPath(${JSON.stringify(githubSource)}, "user")));
    `], {
      cwd: temp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, HOME: home, GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(join(temp, "github")).href}/.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/",
        npm_config_cache: npmCache, npm_config_offline: process.env.PI_PACKAGING_NPM_OFFLINE ?? "true",
        npm_config_audit: "false", npm_config_fund: "false" },
    });
    const installed: string = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    assert.equal(installed, join(agentDir, "git/github.com/daniel-ballance/pi-packages"));

    const result = await load([githubSource], installed, { agentDir });
    assert.deepEqual(result.extensions, rootExtensions);
    assertSkillMenu(result.skills, nativeSkills("cli"));
    assert.equal(result.skillPaths.tdd, "packages/p3stack/skills/tdd/SKILL.md");
    assert.equal(result.skillPaths.subagents, "packages/p3stack/subagents/skills/subagents/SKILL.md");
    assert.deepEqual(result.skillDiagnostics, []);
    for (const dir of ["", ...Object.values(packageDirs)]) {
      await assert.rejects(readFile(join(installed, dir, "node_modules/@earendil-works/pi-coding-agent/package.json")), dir || "root");
    }
    for (const dir of ["packages/claude-subscription", "packages/p3stack", "packages/computer-use", "packages/self-reload", "packages/web-search", "packages/t3-agent"]) {
      const manifest = JSON.parse(await readFile(join(installed, dir, "package.json"), "utf8"));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const paths = createRequire(join(installed, dir, "package.json")).resolve.paths(dependency) ?? [];
        assert.ok(paths.some(path => existsSync(join(path, dependency, "package.json"))), `${dir} resolves ${dependency}`);
      }
    }

    const launchArgs = execFileSync(process.execPath, [join(installed, "scripts/root-package.mjs"), "--t3-launch-args"], { encoding: "utf8" }).trim();
    const claudeSubscription = join(installed, "packages/claude-subscription/extensions/claude-subscription/index.ts");
    const { extensions } = parseArgs(launchArgs.split(/\s+/));
    assert.deepEqual(extensions, [claudeSubscription]);
    const underT3 = await load([githubSource], installed, { host: "t3", agentDir, extensions });
    assert.deepEqual(underT3.extensions, rootExtensions);
    assertSkillMenu(underT3.skills, nativeSkills("t3"));
    assert.equal(underT3.skillPaths.tdd, "packages/p3stack/skills/tdd/SKILL.md");
    assert.deepEqual(underT3.skillDiagnostics, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pnpm production workspace loads the root package without development dependencies", {
  skip: process.env.PACKAGE_MANAGER !== "pnpm" ? "covered by pnpm CI jobs" : false,
}, async () => {
  const temp = tempRoot("pi-pnpm-production-");
  try {
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "packages"]) {
      await cp(join(root, name), join(temp, name), {
        recursive: true,
        filter: path => !["node_modules", "vendor", ".git"].includes(basename(path)),
      });
    }
    execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: temp, encoding: "utf8", stdio: "pipe",
    });
    for (const host of hosts) {
      const result = await load([temp], temp, { host });
      assert.deepEqual(result.extensions, rootExtensions);
      assertSkillMenu(result.skills, nativeSkills(host));
    }
    for (const dir of Object.values(packageDirs)) {
      await assert.rejects(readFile(join(temp, dir, "node_modules/@earendil-works/pi-coding-agent/package.json")), dir);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the packed p3stack loads alone: its three extensions and its skills, with no claude-subscription", async () => {
  const temp = tempRoot("p3stack-pack-");
  try {
    const [pack] = Object.values<{ filename: string }>(JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
      cwd: join(root, "packages/p3stack"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })));
    execFileSync("tar", ["-xzf", join(temp, pack!.filename), "-C", temp]);
    const packed = join(temp, "package");
    const skill = join(packed, "subagents/skills/workflows");
    const body = await readFile(join(skill, "SKILL.md"), "utf8");
    const link = body.match(/\[the workflow contract\]\(([^)]+)\)/)?.[1];
    assert.ok(link, "workflow skill links its required contract");
    assert.match(await readFile(join(skill, link), "utf8"), /limits\.maxAttempts/);
    for (const host of hosts) {
      const result = await load([packed], packed, { host });
      assert.deepEqual(result.extensions, ["extensions/p3stack/index.ts", "subagents/extensions/subagents/index.ts", "todo/extensions/todo/index.ts"]);
      assertSkillMenu(result.skills, nativeSkills(host));
      assert.equal(result.skillPaths.tdd, "skills/tdd/SKILL.md");
      assert.equal(result.skillPaths["regression-test"], undefined);
      assert.deepEqual(result.skillDiagnostics, []);
    }
    assert.ok(existsSync(join(packed, "skills/tdd/references/regression-test.md")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("individual packages still discover their public resources", async () => {
  for (const [name, dir] of Object.entries(packageDirs).filter(([name]) => name !== "p3stack")) {
    for (const host of hosts) {
      const result = await load([join(root, dir)], root, { host });
      assert.deepEqual(result.extensions, [`${dir}/extensions/${name}/index.ts`]);
      assert.deepEqual(result.skills, name === "subagents" ? nativeSkills(host) : []);
    }
  }
});

test("each tarball contains its declared extensions and public native resources", async () => {
  for (const [name, dir] of Object.entries(packageDirs)) {
    const path = join(root, dir);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    const [pack] = Object.values<{ files: { path: string }[] }>(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })));
    const files = pack!.files.map((file: { path: string }) => file.path);
    for (const entry of manifest.pi.extensions) assert.ok(files.includes(entry.replace(/^\.\//, "")), `${name}: tarball is missing ${entry}`);
    assert.ok(!files.some((file: string) => file.includes("node_modules/")));
    assert.ok(!files.some((file: string) => /(^|\/)test\//.test(file)));
    if (name === "p3stack") {
      for (const moved of ["claude-subscription", "computer-use", "self-reload", "web-search", "t3-agent"]) {
        assert.ok(!files.some((file: string) => file.startsWith(`${moved}/`)), moved);
      }
      assert.ok(files.includes("subagents/skills/subagents/SKILL.md"));
      assert.ok(files.includes("subagents/skills/workflows/SKILL.md"));
      assert.ok(!files.some((file: string) => file.startsWith("subagents/skills/subagents/scripts/")));
    }
    if (name === "subagents") {
      assert.ok(files.includes("skills/subagents/SKILL.md"));
      assert.ok(files.includes("skills/subagents/reference/configuration.md"));
      assert.ok(files.includes("skills/subagents/reference/builtins.md"));
      assert.ok(files.includes("skills/workflows/SKILL.md"));
      assert.ok(!files.some((file: string) => file.startsWith("skills/subagents/scripts/")), "research scripts must not ship");
    }
  }
});
