import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const extensionNames = ["mcp-client", "self-reload", "subagents", "web-search"];
const expectedPaths = extensionNames.map(name => `packages/${name}/extensions/${name}/index.ts`);
const engineeringSkills = ["code-review", "codebase-design", "diagnosing-bugs", "domain-modeling", "grill-with-docs", "grilling", "implement", "research", "tdd", "wait-what", "writing-for-agents"];
const expectedSkills = [...engineeringSkills, "subagents", "workflows"].sort();

async function load(source: string, base = root) {
  const temp = await mkdtemp(join(tmpdir(), "pi-package-discovery-"));
  const previousHome = process.env.HOME;
  process.env.HOME = temp; // Also isolate the conventional ~/.agents/skills path.
  try {
    const loader = new DefaultResourceLoader({
      cwd: temp, agentDir: temp,
      settingsManager: SettingsManager.inMemory({ packages: [source] }),
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    return {
      extensions: loader.getExtensions().extensions.map(extension => relative(base, extension.path)).sort(),
      skills: loader.getSkills().skills.map(skill => skill.name).sort(),
    };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
}

test("extracted research preferences and history are absent; the operational proposal remains", async () => {
  for (const path of [
    ".pi/model-selection.json",
    ".pi/skills/refresh-subagent-models/SKILL.md",
    "docs/subagents-model-selection",
    "docs/subagents-pareto-exploration.md",
    "packages/subagents/proposals/2026-09-20-global-subagents.md",
    "packages/subagents/proposals/2026-09-20-global-subagents.json",
  ]) {
    await assert.rejects(stat(join(root, path)), { code: "ENOENT" }, path);
  }
  assert.ok((await stat(join(root, "packages/subagents/proposals/2026-10-01-builtin-extensions-and-0.99-upgrade.md"))).isFile());
});

test("repository root discovers exactly the public extensions and both skill collections", async () => {
  const result = await load(root);
  assert.deepEqual(result.extensions, expectedPaths);
  assert.deepEqual(result.skills, expectedSkills);
});

test("Pi Git installation resolves every extension without development dependencies or bundled Pi peers", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-production-install-"));
  const source = join(temp, "repo.git");
  try {
    await mkdir(source);
    for (const name of ["package.json", "package-lock.json", ".npmrc", "packages"]) {
      await cp(join(root, name), join(source, name), {
        recursive: true,
        filter: path => !["node_modules", "vendor", ".git"].includes(basename(path)),
      });
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
    git("init", "--quiet", "--template=");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", `core.hooksPath=${join(temp, "empty-hooks")}`, "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "Package fixture");
    // Exercise Pi's actual URL -> clone -> production npm install path. Git's
    // process-local URL rewrite targets our fixture, and npm uses only the cache
    // primed by root npm ci. pnpm CI explicitly permits registry downloads since
    // its store is separate from npm's cache. No personal settings are used.
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { DefaultPackageManager, SettingsManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
      const source = "https://pi-packages.invalid/fixtures/repo.git";
      const manager = new DefaultPackageManager({ cwd: ${JSON.stringify(temp)},
        agentDir: ${JSON.stringify(join(temp, "agent"))}, settingsManager: SettingsManager.inMemory() });
      await manager.install(source);
      console.log(JSON.stringify(manager.getInstalledPath(source, "user")));
    `], {
      cwd: temp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(temp + "/").href}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://pi-packages.invalid/fixtures/",
        npm_config_offline: process.env.PI_PACKAGING_NPM_OFFLINE ?? "true", npm_config_ignore_scripts: "true",
        npm_config_audit: "false", npm_config_fund: "false" },
    });
    const installed: string = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    const result = await load(installed, installed);
    assert.deepEqual(result.extensions, expectedPaths);
    assert.deepEqual(result.skills, expectedSkills);
    for (const name of extensionNames) {
      await assert.rejects(readFile(join(installed, "packages", name, "node_modules/@earendil-works/pi-coding-agent/package.json")));
      assert.deepEqual((await load(join(installed, "packages", name), installed)).extensions,
        [`packages/${name}/extensions/${name}/index.ts`]);
    }
    await assert.rejects(readFile(join(installed, "node_modules/@earendil-works/pi-coding-agent/package.json")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pnpm production workspace resolves every extension without development dependencies", {
  skip: process.env.PACKAGE_MANAGER !== "pnpm" ? "covered by pnpm CI jobs" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-pnpm-production-"));
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
    const result = await load(temp, temp);
    assert.deepEqual(result.extensions, expectedPaths);
    assert.deepEqual(result.skills, expectedSkills);
    for (const name of extensionNames) {
      await assert.rejects(readFile(join(temp, "packages", name, "node_modules/@earendil-works/pi-coding-agent/package.json")));
      assert.deepEqual((await load(join(temp, "packages", name), temp)).extensions,
        [`packages/${name}/extensions/${name}/index.ts`]);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("individual packages still discover their public resources", async () => {
  for (const name of extensionNames) {
    const result = await load(join(root, "packages", name));
    assert.deepEqual(result.extensions, [`packages/${name}/extensions/${name}/index.ts`]);
    assert.deepEqual(result.skills, name === "subagents" ? ["subagents", "workflows"] : []);
  }
  assert.deepEqual((await load(join(root, "packages/agent-skills"))).skills, engineeringSkills);
});

test("every package has resource directories and packs its declared extension implementation", async () => {
  for (const name of await readdir(join(root, "packages"))) {
    const path = join(root, "packages", name);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    for (const type of ["extensions", "skills", "prompts", "themes"]) {
      await readdir(join(path, type));
      assert.ok(Array.isArray(manifest.pi[type]), `${name}: missing pi.${type}`);
    }
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    const files = pack.files.map((file: { path: string }) => file.path);
    if (extensionNames.includes(name)) {
      assert.ok(files.includes(`extensions/${name}/index.ts`), name);
      if (name !== "self-reload") assert.ok(files.some((file: string) => file.startsWith(`extensions/${name}/src/`)), name);
      assert.ok(!files.includes("index.ts"));
    }
    assert.ok(!files.some((file: string) => file.includes("node_modules/")));
    assert.ok(!files.some((file: string) => file.startsWith("test/")));
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
