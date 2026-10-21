import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { git as runGit, gitEnv } from "./git.js";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { tempRoot } from "./support/temp-root.js";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const githubSource = "git:github.com/daniel-ballance/pi-packages";
const rootExtensions = [
  "packages/claude-subscription/extensions/claude-subscription/index.ts",
  "packages/p3stack/extensions/p3stack/index.ts",
  "packages/p3stack/subagents/extensions/subagents/index.ts",
  "packages/p3stack/todo/extensions/todo/index.ts",
  "packages/computer-use/extensions/computer-use/index.ts",
  "packages/self-reload/extensions/self-reload/index.ts",
  "packages/web-search/extensions/web-search/index.ts",
];
const packageDirs: Record<string, string> = {
  "claude-subscription": "packages/claude-subscription",
  "computer-use": "packages/computer-use",
  "mcp-client": "packages/mcp-client",
  p3stack: "packages/p3stack",
  "self-reload": "packages/self-reload",
  subagents: "packages/p3stack/subagents",
  todo: "packages/p3stack/todo",
  "web-search": "packages/web-search",
};
const p3stackSkills = readdirSync(join(root, "packages/p3stack/skills"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, "packages/p3stack/skills", entry.name, "SKILL.md")))
  .map(entry => entry.name);
const expectedSkills = ["subagents", "workflows", ...p3stackSkills].sort();

async function load(packages: string[], base: string, options: { agentDir?: string; extensions?: string[] } = {}) {
  const temp = tempRoot("pi-package-discovery-");
  const previousHome = process.env.HOME;
  process.env.HOME = temp; // Also isolate the conventional ~/.agents/skills path.
  try {
    runGit(["init", "--quiet", "--template=", temp]);
    const loader = new DefaultResourceLoader({
      cwd: temp, agentDir: options.agentDir ?? temp,
      settingsManager: SettingsManager.inMemory({ packages }),
      additionalExtensionPaths: options.extensions,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    return {
      extensions: loader.getExtensions().extensions.map(extension => relative(base, extension.path)),
      skills: loader.getSkills().skills.map(skill => skill.name).sort(),
      skillPaths: Object.fromEntries(loader.getSkills().skills.map(skill => [skill.name, relative(base, skill.filePath)])),
      skillDiagnostics: loader.getSkills().diagnostics,
    };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
}

/** What GitHub serves: every tracked file, without submodule contents, which Pi never initializes. */
function publish(bare: string, work: string) {
  const entries = runGit(["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const entry of entries) {
    const [, mode, path] = /^(\d+) \S+ \d+\t(.+)$/s.exec(entry) as unknown as [string, string, string];
    if (mode === "160000" || !existsSync(join(root, path))) continue;
    mkdirSync(dirname(join(work, path)), { recursive: true });
    copyFileSync(join(root, path), join(work, path));
  }
  const git = (...args: string[]) => runGit(args, { cwd: work, stdio: "pipe" });
  git("init", "--quiet", "--template=");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", `core.hooksPath=${join(work, ".no-hooks")}`, "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Package fixture");
  runGit(["clone", "--quiet", "--bare", work, bare], { stdio: "pipe" });
}

test("retired research and skill-report files are absent; the operational proposal remains", async () => {
  for (const path of [
    ".pi/model-selection.json",
    "scripts/skill-report.mjs",
    ".pi/skills/p3stack-pocock-unification",
    ".pi/skills/refresh-subagent-models/SKILL.md",
    "docs/subagents-model-selection",
    "docs/subagents-pareto-exploration.md",
    "packages/p3stack/subagents/proposals/2026-09-20-global-subagents.md",
    "packages/p3stack/subagents/proposals/2026-09-20-global-subagents.json",
  ]) {
    await assert.rejects(stat(join(root, path)), { code: "ENOENT" }, path);
  }
  assert.ok((await stat(join(root, "packages/p3stack/subagents/proposals/2026-10-01-builtin-extensions-and-0.99-upgrade.md"))).isFile());
});

test("project settings do not reference the retired pi-pocock-skills package", async () => {
  const settings = JSON.parse(await readFile(join(root, ".pi/settings.json"), "utf8"));
  const sources = (settings.packages ?? []).map((entry: string | { source: string }) => typeof entry === "string" ? entry : entry.source);
  assert.deepEqual(sources.filter((source: string) => source.includes("pi-pocock-skills")), []);
});

test("pi install git:github.com/daniel-ballance/pi-packages loads the five packages, and T3's launch argument loads claude-subscription once, first", async () => {
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
      import { DefaultPackageManager, SettingsManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
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
    assert.deepEqual(result.skills, expectedSkills);
    assert.equal(result.skillPaths.tdd, "packages/p3stack/skills/tdd/SKILL.md");
    assert.equal(result.skillPaths.subagents, "packages/p3stack/subagents/skills/subagents/SKILL.md");
    assert.deepEqual(result.skillDiagnostics, []);
    for (const dir of ["", ...Object.values(packageDirs)]) {
      await assert.rejects(readFile(join(installed, dir, "node_modules/@earendil-works/pi-coding-agent/package.json")), dir || "root");
    }
    for (const dir of ["packages/claude-subscription", "packages/p3stack", "packages/computer-use", "packages/self-reload", "packages/web-search"]) {
      const manifest = JSON.parse(await readFile(join(installed, dir, "package.json"), "utf8"));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const paths = createRequire(join(installed, dir, "package.json")).resolve.paths(dependency) ?? [];
        assert.ok(paths.some(path => existsSync(join(path, dependency, "package.json"))), `${dir} resolves ${dependency}`);
      }
    }

    const launchArgs = execFileSync(process.execPath, [join(installed, "scripts/root-package.mjs"), "--t3-launch-args"], { encoding: "utf8" }).trim();
    const claudeSubscription = join(installed, "packages/claude-subscription/extensions/claude-subscription/index.ts");
    assert.equal(launchArgs, `--extension ${claudeSubscription}`);
    const underT3 = await load([githubSource], installed, { agentDir, extensions: [launchArgs.slice("--extension ".length)] });
    assert.deepEqual(underT3.extensions, rootExtensions);
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
    const result = await load([temp], temp);
    assert.deepEqual(result.extensions, rootExtensions);
    assert.deepEqual(result.skills, expectedSkills);
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
    const result = await load([join(temp, "package")], join(temp, "package"));
    assert.deepEqual(result.extensions, ["extensions/p3stack/index.ts", "subagents/extensions/subagents/index.ts", "todo/extensions/todo/index.ts"]);
    assert.deepEqual(result.skills, expectedSkills);
    assert.equal(result.skillPaths.tdd, "skills/tdd/SKILL.md");
    assert.deepEqual(result.skillDiagnostics, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("individual packages still discover their public resources", async () => {
  for (const [name, dir] of Object.entries(packageDirs).filter(([name]) => name !== "p3stack")) {
    const result = await load([join(root, dir)], root);
    assert.deepEqual(result.extensions, [`${dir}/extensions/${name}/index.ts`]);
    assert.deepEqual(result.skills, name === "subagents" ? ["subagents", "workflows"] : []);
  }
});

test("every package has resource directories and packs its declared extension implementation", async () => {
  for (const [name, dir] of Object.entries(packageDirs)) {
    const path = join(root, dir);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    for (const type of ["extensions", "skills", "prompts", "themes"]) {
      await readdir(join(path, type));
      assert.ok(Array.isArray(manifest.pi[type]), `${name}: missing pi.${type}`);
    }
    const [pack] = Object.values<{ files: { path: string }[] }>(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })));
    const files = pack!.files.map((file: { path: string }) => file.path);
    assert.ok(files.includes(`extensions/${name}/index.ts`), name);
    if (name !== "self-reload") assert.ok(files.some((file: string) => file.startsWith(`extensions/${name}/src/`)), name);
    assert.ok(!files.includes("index.ts"));
    assert.ok(!files.some((file: string) => file.includes("node_modules/")));
    assert.ok(!files.some((file: string) => /(^|\/)test\//.test(file)));
    if (name === "p3stack") {
      for (const extension of ["subagents/extensions/subagents/index.ts", "todo/extensions/todo/index.ts"]) assert.ok(files.includes(extension), extension);
      for (const moved of ["claude-subscription", "computer-use", "self-reload", "web-search"]) {
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
      for (const reference of ["model-research.md", "frontier-analysis.md"]) {
        assert.ok(!files.includes(`skills/subagents/reference/${reference}`), reference);
      }
    }
  }
});
