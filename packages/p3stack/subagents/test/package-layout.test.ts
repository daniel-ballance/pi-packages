import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { git as runGit, gitEnv } from "./git.js";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { tempRoot } from "./support/temp-root.js";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const collectionExtensions = ["claude-subscription", "computer-use", "p3stack", "self-reload", "subagents", "todo", "web-search"];
const packagePath = (name: string) => name === "mcp-client" || name === "p3stack" ? `packages/${name}` : `packages/p3stack/${name}`;
const expectedPaths = collectionExtensions.map(name => `${packagePath(name)}/extensions/${name}/index.ts`).sort();
const p3stackSkills = readdirSync(join(root, "packages/p3stack/skills"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, "packages/p3stack/skills", entry.name, "SKILL.md")))
  .map(entry => entry.name);
const expectedSkills = ["subagents", "workflows", ...p3stackSkills].sort();

async function load(source: string, base = root) {
  const temp = tempRoot("pi-package-discovery-");
  const previousHome = process.env.HOME;
  process.env.HOME = temp; // Also isolate the conventional ~/.agents/skills path.
  try {
    runGit(["init", "--quiet", "--template=", temp]);
    const loader = new DefaultResourceLoader({
      cwd: temp, agentDir: temp,
      settingsManager: SettingsManager.inMemory({ packages: [source] }),
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    return {
      extensions: loader.getExtensions().extensions.map(extension => relative(base, extension.path)).sort(),
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

test("repository root is not a second package identity", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.pi, undefined);
  assert.ok(!(manifest.keywords ?? []).includes("pi-package"));
  for (const name of ["extensions", "skills"]) assert.equal(existsSync(join(root, name)), false);
});

test("p3stack discovers exactly the public extensions and unified skill collection", async () => {
  const result = await load(join(root, "packages/p3stack"));
  assert.deepEqual(result.extensions, expectedPaths);
  assert.deepEqual(result.skills, expectedSkills);
  assert.equal(result.skillPaths.tdd, "packages/p3stack/skills/tdd/SKILL.md");
  assert.deepEqual(result.skillDiagnostics, []);
});

test("project settings do not reference the retired pi-pocock-skills package", async () => {
  const settings = JSON.parse(await readFile(join(root, ".pi/settings.json"), "utf8"));
  const sources = (settings.packages ?? []).map((entry: string | { source: string }) => typeof entry === "string" ? entry : entry.source);
  assert.deepEqual(sources.filter((source: string) => source.includes("pi-pocock-skills")), []);
});

test("Pi Git installation resolves every extension without development dependencies or bundled Pi peers", async () => {
  const temp = tempRoot("pi-production-install-");
  const source = join(temp, "repo.git");
  try {
    await mkdir(source);
    for (const name of ["package.json", "package-lock.json", ".npmrc", "packages"]) {
      await cp(join(root, name), join(source, name), {
        recursive: true,
        filter: path => !["node_modules", "vendor", ".git"].includes(basename(path)),
      });
    }
    const git = (...args: string[]) => runGit(args, { cwd: source, stdio: "pipe" });
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
      env: { ...gitEnv(), GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(temp + "/").href}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://pi-packages.invalid/fixtures/",
        npm_config_offline: process.env.PI_PACKAGING_NPM_OFFLINE ?? "true", npm_config_ignore_scripts: "true",
        npm_config_audit: "false", npm_config_fund: "false" },
    });
    const installed: string = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    const result = await load(join(installed, "packages/p3stack"), installed);
    assert.deepEqual(result.extensions, expectedPaths);
    assert.deepEqual(result.skills, expectedSkills);
    for (const name of collectionExtensions) {
      await assert.rejects(readFile(join(installed, packagePath(name), "node_modules/@earendil-works/pi-coding-agent/package.json")));
      assert.deepEqual((await load(join(installed, packagePath(name)), installed)).extensions,
        name === "p3stack" ? expectedPaths : [`${packagePath(name)}/extensions/${name}/index.ts`]);
    }
    await assert.rejects(readFile(join(installed, "node_modules/@earendil-works/pi-coding-agent/package.json")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pnpm production workspace resolves every extension without development dependencies", {
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
    const result = await load(join(temp, "packages/p3stack"), temp);
    assert.deepEqual(result.extensions, expectedPaths);
    assert.deepEqual(result.skills, expectedSkills);
    for (const name of collectionExtensions) {
      await assert.rejects(readFile(join(temp, packagePath(name), "node_modules/@earendil-works/pi-coding-agent/package.json")));
      assert.deepEqual((await load(join(temp, packagePath(name)), temp)).extensions,
        name === "p3stack" ? expectedPaths : [`${packagePath(name)}/extensions/${name}/index.ts`]);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("individual packages still discover their public resources", async () => {
  for (const name of [...collectionExtensions.filter(name => name !== "p3stack"), "mcp-client"]) {
    const result = await load(join(root, packagePath(name)));
    assert.deepEqual(result.extensions, [`${packagePath(name)}/extensions/${name}/index.ts`]);
    assert.deepEqual(result.skills, name === "subagents" ? ["subagents", "workflows"] : []);
  }
  const p3stackDir = join(root, "packages/p3stack/skills");
  const ownSkills = [];
  for (const entry of await readdir(p3stackDir, { withFileTypes: true })) {
    if (entry.isDirectory() && await stat(join(p3stackDir, entry.name, "SKILL.md")).then(() => true, () => false)) ownSkills.push(entry.name);
  }
  assert.ok(ownSkills.includes("tdd"));
  const p3stack = await load(join(root, "packages/p3stack"));
  assert.deepEqual(p3stack.skills, ["subagents", "workflows", ...ownSkills].sort());
  assert.deepEqual(p3stack.extensions, expectedPaths);
});

test("every package has resource directories and packs its declared extension implementation", async () => {
  for (const name of [...collectionExtensions, "mcp-client"]) {
    const path = join(root, packagePath(name));
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    for (const type of ["extensions", "skills", "prompts", "themes"]) {
      await readdir(join(path, type));
      assert.ok(Array.isArray(manifest.pi[type]), `${name}: missing pi.${type}`);
    }
    const [pack] = Object.values<{ files: { path: string }[] }>(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })));
    const files = pack.files.map((file: { path: string }) => file.path);
    if ([...collectionExtensions, "mcp-client"].includes(name)) {
      assert.ok(files.includes(`extensions/${name}/index.ts`), name);
      if (name !== "self-reload") assert.ok(files.some((file: string) => file.startsWith(`extensions/${name}/src/`)), name);
      assert.ok(!files.includes("index.ts"));
    }
    assert.ok(!files.some((file: string) => file.includes("node_modules/")));
    assert.ok(!files.some((file: string) => /(^|\/)test\//.test(file)));
    if (name === "p3stack") {
      for (const extension of expectedPaths) assert.ok(files.includes(extension.replace("packages/p3stack/", "")), extension);
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
