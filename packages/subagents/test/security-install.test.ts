import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/patch-pi-host-security.mts", import.meta.url));
const sdkName = "@earendil-works/pi-coding-agent";
const packageNames = ["claude-subscription", "durable-subagents", "mcp-client", "self-reload", "subagents", "web-search"];

const undiciIntegrity = "sha512-/y4/bH9YNU5hi9NIrpOuvGXFcxrj3CMrV+/AYpowAYTpHn8gX/XPFjNy766FPoYY0miQhdW977JFWKGNhBdwyQ==";
const undiciResolution = {
  version: "8.10.2", resolved: "https://registry.npmjs.org/undici/-/undici-8.10.2.tgz", integrity: undiciIntegrity,
};

type Fixture = { root: string; sdkDirectories: string[]; braceDirectories: string[] };

async function json(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

async function host(directory: string, alias: string, version: string = "0.99.2"): Promise<string> {
  const sdk = join(directory, "node_modules", alias);
  await json(join(sdk, "package.json"), { name: sdkName, version, main: "index.js" });
  await writeFile(join(sdk, "index.js"), "");
  await json(join(sdk, "node_modules/minimatch/package.json"), { name: "minimatch", main: "index.js" });
  await writeFile(join(sdk, "node_modules/minimatch/index.js"), "");
  await json(join(sdk, "node_modules/brace-expansion/package.json"), {
    name: "brace-expansion", version: "5.0.9", main: "index.cjs", dependencies: { "balanced-match": "^4.0.2" },
  });
  await writeFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "module.exports = 'old';\n");
  await json(join(sdk, "node_modules/undici/package.json"), {
    name: "undici", version: "8.10.1", main: "index.js", engines: { node: ">=22.19.0" },
  });
  await writeFile(join(sdk, "node_modules/undici/index.js"), "module.exports = 'old undici';\n");
  await json(join(sdk, "npm-shrinkwrap.json"), {
    packages: {
      "node_modules/undici": { version: "8.10.1", resolved: "old", integrity: "old", license: "MIT", engines: { node: ">=22.19.0" } },
      "node_modules/brace-expansion": { version: "5.0.9", resolved: "old", integrity: "old", license: "MIT" },
      "node_modules/untouched": { version: "1.2.3" },
    },
  });
  return sdk;
}

async function fixture(root: string): Promise<Fixture> {
  await json(join(root, "package.json"), { name: "pi-packages-repo" });
  await json(join(root, "node_modules/brace-expansion/package.json"), {
    name: "brace-expansion", version: "5.0.12", main: "index.cjs",
  });
  await writeFile(join(root, "node_modules/brace-expansion/index.cjs"), "module.exports = 'patched';\n");
  await json(join(root, "node_modules/undici/package.json"), {
    name: "undici", version: "8.10.2", main: "index.js", engines: { node: ">=22.19.0" },
  });
  await writeFile(join(root, "node_modules/undici/index.js"), "module.exports = 'patched undici';\n");
  await json(join(root, "package-lock.json"), {
    packages: { "node_modules/undici": undiciResolution, "node_modules/brace-expansion": {
      version: "5.0.12", resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
      integrity: "sha512-fixture",
    } },
  });
  await mkdir(join(root, "scripts"));
  await cp(script, join(root, "scripts/patch-pi-host-security.mts"));
  const sdkDirectories: string[] = [];
  for (const name of packageNames) {
    const version = ["mcp-client", "self-reload", "web-search"].includes(name) ? "0.85.1" : "0.99.2";
    sdkDirectories.push(await host(join(root, "packages", name), sdkName, version));
  }
  sdkDirectories.push(await host(join(root, "packages/durable-subagents"), "pi-host-1", "1.0.0"));
  return { root, sdkDirectories, braceDirectories: sdkDirectories.map((sdk: string): string => join(sdk, "node_modules/brace-expansion")) };
}

async function run(value: Fixture, args: readonly string[] = []): Promise<string> {
  const result = await execute(process.execPath, [join(value.root, "scripts/patch-pi-host-security.mts"), ...args], {
    cwd: value.root, timeout: 10_000, maxBuffer: 65_536,
  });
  return result.stdout;
}

async function withFixture(body: (value: Fixture, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-security-install-"));
  try {
    await body(await fixture(join(directory, "checkout")), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const key = join(prefix, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) result[key] = `link:${await readlink(path)}`;
      else if (stat.isDirectory()) {
        result[key] = "directory";
        await visit(path, key);
      } else result[key] = await readFile(path, "utf8");
    }
  }
  await visit(root, "");
  return result;
}

async function metadataIdentity(sdk: string): Promise<{ ino: number; mtimeMs: number }> {
  const stats = await lstat(join(sdk, "npm-shrinkwrap.json"));
  // Reads can change atime; only identity and modification time indicate writes.
  return { ino: stats.ino, mtimeMs: stats.mtimeMs };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function update(path: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const value = record(parsed);
  mutate(value);
  await json(path, value);
}

async function installedVersion(sdk: string, dependency: string, version: string): Promise<void> {
  await update(join(sdk, "node_modules", dependency, "package.json"), (value: Record<string, unknown>): void => { value.version = version; });
  await update(join(sdk, "npm-shrinkwrap.json"), (value: Record<string, unknown>): void => {
    const entries = record(value.packages);
    const entry = record(entries[`node_modules/${dependency}`]);
    entry.version = version;
    entries[`node_modules/${dependency}`] = entry;
    value.packages = entries;
  });
}

test("explicit install step patches all seven SDKs, preserves their code/other entries, and is idempotent", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const manifests = await Promise.all(value.sdkDirectories.map((sdk: string): Promise<string> => readFile(join(sdk, "package.json"), "utf8")));
    assert.match(await run(value), /7 checked, 7 patched/);
    assert.deepEqual(await Promise.all(value.sdkDirectories.map((sdk: string): Promise<string> => readFile(join(sdk, "package.json"), "utf8"))), manifests);
    for (const sdk of value.sdkDirectories) {
      assert.equal(await readFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'patched';\n");
      assert.equal(await readFile(join(sdk, "node_modules/undici/index.js"), "utf8"), "module.exports = 'patched undici';\n");
      assert.equal(await readFile(join(sdk, "index.js"), "utf8"), "");
      const metadata: unknown = JSON.parse(await readFile(join(sdk, "npm-shrinkwrap.json"), "utf8"));
      assert.deepEqual(metadata, { packages: {
        "node_modules/undici": { ...undiciResolution, license: "MIT", engines: { node: ">=22.19.0" } },
        "node_modules/brace-expansion": { version: "5.0.12", resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz", integrity: "sha512-fixture", license: "MIT" },
        "node_modules/untouched": { version: "1.2.3" },
      } });
    }
    const before = await snapshot(value.root);
    const metadataStats = await Promise.all(value.sdkDirectories.map(metadataIdentity));
    assert.match(await run(value), /7 checked, 0 patched/);
    assert.deepEqual(await snapshot(value.root), before);
    assert.deepEqual(await Promise.all(value.sdkDirectories.map(metadataIdentity)), metadataStats);
  });
});

test("preflight rejects a global SDK symlink before modifying any local host", async (): Promise<void> => {
  await withFixture(async (value: Fixture, directory: string): Promise<void> => {
    const outside = await host(join(directory, "global"), sdkName);
    const last = value.sdkDirectories.at(-1);
    assert.ok(last);
    await rm(last, { recursive: true });
    await symlink(outside, last, "dir");
    await assert.rejects(run(value), /outside this development checkout/);
    for (const sdk of value.sdkDirectories) {
      assert.equal(await readFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'old';\n");
    }
  });
});

test("unreviewed source or host dependency shape fails without partial patching", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const last = value.braceDirectories.at(-1);
    assert.ok(last);
    await json(join(last, "package.json"), { name: "brace-expansion", version: "5.0.9", dependencies: { surprise: "*" } });
    await assert.rejects(run(value), /Unreviewed brace-expansion dependency shape/);
    for (const path of value.braceDirectories) assert.equal(await readFile(join(path, "index.cjs"), "utf8"), "module.exports = 'old';\n");
    await json(join(value.root, "node_modules/brace-expansion/package.json"), { name: "brace-expansion", version: "5.0.9" });
    await assert.rejects(run(value), /Install the reviewed brace-expansion 5.0.12/);
  });
});

test("explicit copied-out development scope uses the verified source without modifying workspace hosts", async (): Promise<void> => {
  await withFixture(async (value: Fixture, directory: string): Promise<void> => {
    const standalone = join(directory, "standalone");
    await json(join(standalone, "package.json"), { name: "subagents" });
    const sdk = await host(standalone, sdkName);
    const workspaceBefore = await snapshot(value.root);
    assert.match(await run(value, [standalone]), /1 checked, 1 patched/);
    assert.equal(await readFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'patched';\n");
    assert.equal(await readFile(join(sdk, "node_modules/undici/index.js"), "utf8"), "module.exports = 'patched undici';\n");
    assert.match(await run(value, [standalone]), /1 checked, 0 patched/);
    assert.deepEqual(await snapshot(value.root), workspaceBefore);
    for (const path of value.braceDirectories) assert.equal(await readFile(join(path, "index.cjs"), "utf8"), "module.exports = 'old';\n");
    await json(join(standalone, "package.json"), { name: sdkName });
    await assert.rejects(run(value, [standalone]), /scope must be this collection or a standalone development package/);
  });
});

test("metadata promotion failure rolls back the installed library", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const sdk = value.sdkDirectories[0];
    assert.ok(sdk);
    const original = await readFile(join(sdk, "npm-shrinkwrap.json"), "utf8");
    const before = await snapshot(join(value.root, "packages"));
    const preload = join(value.root, "fail-rename.mts");
    await writeFile(preload, `import fs, { type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.promises.rename;
fs.promises.rename = async (source: PathLike, target: PathLike): Promise<void> => {
  if (target === process.env.TEST_METADATA_PATH) throw Object.assign(new Error("fixture metadata failure"), { code: "EACCES" });
  await original(source, target);
};
syncBuiltinESMExports();\n`);
    await assert.rejects(execute(process.execPath, ["--import", preload, join(value.root, "scripts/patch-pi-host-security.mts")], {
      cwd: value.root, env: { ...process.env, TEST_METADATA_PATH: join(sdk, "npm-shrinkwrap.json") }, timeout: 10_000, maxBuffer: 65_536,
    }), /fixture metadata failure/);
    assert.equal(await readFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'old';\n");
    assert.equal(await readFile(join(sdk, "npm-shrinkwrap.json"), "utf8"), original);
    assert.deepEqual(await snapshot(join(value.root, "packages")), before);
    assert.match(await run(value), /7 checked, 7 patched/);
  });
});

test("partial combinations preserve patched dependencies and update both entries without lost metadata", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const [braceOnly, undiciOnly, both] = value.sdkDirectories;
    assert.ok(braceOnly && undiciOnly && both);
    await installedVersion(braceOnly, "undici", "8.11.0");
    await installedVersion(undiciOnly, "brace-expansion", "5.1.0");
    await installedVersion(both, "brace-expansion", "5.0.12");
    await installedVersion(both, "undici", "8.10.2");
    // Also exercise the supported empty dependency-object spelling.
    await update(join(undiciOnly, "node_modules/undici/package.json"), (manifest: Record<string, unknown>): void => { manifest.dependencies = {}; });
    const unchangedBrace = await snapshot(join(undiciOnly, "node_modules/brace-expansion"));
    const unchangedUndici = await snapshot(join(braceOnly, "node_modules/undici"));
    const unchangedHost = await snapshot(both);
    assert.match(await run(value), /7 checked, 6 patched/);
    assert.deepEqual(await snapshot(join(undiciOnly, "node_modules/brace-expansion")), unchangedBrace);
    assert.deepEqual(await snapshot(join(braceOnly, "node_modules/undici")), unchangedUndici);
    assert.deepEqual(await snapshot(both), unchangedHost);
    assert.equal(await readFile(join(undiciOnly, "node_modules/undici/index.js"), "utf8"), "module.exports = 'patched undici';\n");
    assert.equal(await readFile(join(braceOnly, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'patched';\n");
    assert.match(await run(value), /7 checked, 0 patched/);
  });
});

test("shared local SDK symlinks are patched once and retain both shrinkwrap updates", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const [first, shared] = value.sdkDirectories;
    assert.ok(first && shared);
    await rm(shared, { recursive: true });
    await symlink(first, shared, "dir");
    assert.match(await run(value), /7 checked, 6 patched/);
    assert.equal(await readlink(shared), first);
    for (const name of ["brace-expansion", "undici"]) {
      const parsed: unknown = JSON.parse(await readFile(join(shared, "npm-shrinkwrap.json"), "utf8"));
      const entry = record(record(record(parsed).packages)[`node_modules/${name}`]);
      assert.equal(entry.version, name === "undici" ? "8.10.2" : "5.0.12");
    }
    assert.match(await run(value), /7 checked, 0 patched/);
  });
});

type InvalidInput = { label: string; mutate: (value: Fixture) => Promise<void>; error: RegExp };
const invalidInputs: InvalidInput[] = [];
for (const [field, invalid, error] of [
  ["name", "other", /Unexpected undici dependency/],
  ["version", 8, /undici version must be a string/],
  ["version", "9.0.0", /Unreviewed undici version/],
  ["version", "8.10.2-beta.1", /Unreviewed undici version/],
  ["version", "8.9999999999999999999999.0", /Invalid undici version/],
  ["dependencies", { unexpected: "*" }, /Unreviewed undici dependency shape/],
  ["dependencies", null, /expected an object/],
  ["dependencies", [], /expected an object/],
] satisfies [string, unknown, RegExp][]) {
  invalidInputs.push({ label: `installed undici ${field} ${JSON.stringify(invalid)}`, error,
    mutate: async (value: Fixture): Promise<void> => {
      const sdk = value.sdkDirectories.at(-1);
      assert.ok(sdk);
      await update(join(sdk, "node_modules/undici/package.json"), (manifest: Record<string, unknown>): void => { manifest[field] = invalid; });
    },
  });
}
for (const [field, invalid, error] of [
  ["name", "other", /Install the reviewed undici 8.10.2/],
  ["version", "8.10.1", /Install the reviewed undici 8.10.2/],
  ["dependencies", { unexpected: "*" }, /Unreviewed undici dependency shape/],
  ["engines", { node: ">=18" }, /Unreviewed undici source engines/],
] satisfies [string, unknown, RegExp][]) {
  invalidInputs.push({ label: `undici source ${field}`, error,
    mutate: async (value: Fixture): Promise<void> => {
      await update(join(value.root, "node_modules/undici/package.json"), (manifest: Record<string, unknown>): void => { manifest[field] = invalid; });
    },
  });
}
for (const [field, invalid] of [
  ["version", "8.10.1"], ["resolved", "https://example.invalid/undici.tgz"],
  ["integrity", "sha512-unreviewed"], ["integrity", 123],
] satisfies [string, unknown][]) {
  invalidInputs.push({ label: `undici source lock ${field} ${JSON.stringify(invalid)}`, error: /Security source must have the reviewed version/,
    mutate: async (value: Fixture): Promise<void> => {
      await update(join(value.root, "package-lock.json"), (lock: Record<string, unknown>): void => {
        const entries = record(lock.packages);
        const entry = record(entries["node_modules/undici"]);
        entry[field] = invalid;
        entries["node_modules/undici"] = entry;
        lock.packages = entries;
      });
    },
  });
}
for (const [label, mutate, error] of [
  ["version mismatch", (entries: Record<string, unknown>): void => { entries["node_modules/undici"] = { version: "8.9.0" }; }, /disagrees with its shrinkwrap/],
  ["missing entry", (entries: Record<string, unknown>): void => { delete entries["node_modules/undici"]; }, /expected an object/],
  ["array entry", (entries: Record<string, unknown>): void => { entries["node_modules/undici"] = []; }, /expected an object/],
  ["runtime dependencies", (entries: Record<string, unknown>): void => { entries["node_modules/undici"] = { version: "8.10.1", dependencies: { unexpected: "*" } }; }, /Unreviewed undici dependency shape/],
] satisfies [string, (entries: Record<string, unknown>) => void, RegExp][]) {
  invalidInputs.push({ label: `undici shrinkwrap ${label}`, error,
    mutate: async (value: Fixture): Promise<void> => {
      const sdk = value.sdkDirectories.at(-1);
      assert.ok(sdk);
      await update(join(sdk, "npm-shrinkwrap.json"), (metadata: Record<string, unknown>): void => {
        const entries = record(metadata.packages);
        mutate(entries);
        metadata.packages = entries;
      });
    },
  });
}
invalidInputs.push({ label: "malformed shrinkwrap JSON", error: /SyntaxError/,
  mutate: async (value: Fixture): Promise<void> => {
    const sdk = value.sdkDirectories.at(-1);
    assert.ok(sdk);
    await writeFile(join(sdk, "npm-shrinkwrap.json"), "not JSON");
  },
});
for (const input of invalidInputs) {
  test(`preflight rejects ${input.label} without changing any host or source`, async (): Promise<void> => {
    await withFixture(async (value: Fixture): Promise<void> => {
      await input.mutate(value);
      const before = await snapshot(value.root);
      await assert.rejects(run(value), input.error);
      assert.deepEqual(await snapshot(value.root), before);
    });
  });
}

for (const location of ["source", "dependency", "shrinkwrap", "entry"] satisfies string[]) {
  test(`preflight rejects an escaping ${location} symlink without modifying either scope`, async (): Promise<void> => {
    await withFixture(async (value: Fixture, directory: string): Promise<void> => {
      const sdk = value.sdkDirectories.at(-1);
      assert.ok(sdk);
      const local = location === "source" ? join(value.root, "node_modules/undici") :
        location === "dependency" ? join(sdk, "node_modules/undici") :
          join(sdk, location === "entry" ? "index.js" : "npm-shrinkwrap.json");
      const outside = join(directory, "outside");
      await cp(local, outside, { recursive: true });
      await rm(local, { recursive: true });
      await symlink(outside, local);
      const before = await snapshot(directory);
      await assert.rejects(run(value), /outside this development checkout/);
      assert.deepEqual(await snapshot(directory), before);
    });
  });
}

test("successful promotion clears only hidden npm caches and leaves no stages", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const caches = [join(value.root, "node_modules/.package-lock.json")];
    for (const sdk of value.sdkDirectories) {
      caches.push(join(sdk, "node_modules/.package-lock.json"));
    }
    for (const name of packageNames) caches.push(join(value.root, "packages", name, "node_modules/.package-lock.json"));
    for (const path of caches) await json(path, { fixture: "hidden cache" });
    const sourceBefore = await snapshot(join(value.root, "node_modules/undici"));
    await run(value);
    for (const path of caches) await assert.rejects(lstat(path), { code: "ENOENT" });
    assert.deepEqual(await snapshot(join(value.root, "node_modules/undici")), sourceBefore);
    assert.ok(!Object.keys(await snapshot(value.root)).some((path: string): boolean => /\.(?:brace-expansion|undici)-security-/.test(path)));
  });
});

for (const onlyUndici of [false, true]) {
  test(`${onlyUndici ? "undici-only" : "combined"} promotion failure rolls back all installed packages and metadata`, async (): Promise<void> => {
    await withFixture(async (value: Fixture): Promise<void> => {
      const sdk = value.sdkDirectories[0];
      assert.ok(sdk);
      if (onlyUndici) await installedVersion(sdk, "brace-expansion", "5.0.12");
      const preload = join(value.root, "fail-undici.mts");
      await writeFile(preload, `import fs, { type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.promises.rename;
fs.promises.rename = async (source: PathLike, target: PathLike): Promise<void> => {
  if (target === process.env.TEST_UNDICI_PATH && String(source).endsWith("/replacement")) throw new Error("fixture undici failure");
  await original(source, target);
};
syncBuiltinESMExports();\n`);
      const before = await snapshot(value.root);
      await assert.rejects(execute(process.execPath, ["--import", preload, join(value.root, "scripts/patch-pi-host-security.mts")], {
        cwd: value.root, env: { ...process.env, TEST_UNDICI_PATH: join(sdk, "node_modules/undici") }, timeout: 10_000, maxBuffer: 65_536,
      }), /fixture undici failure/);
      assert.deepEqual(await snapshot(value.root), before);
      assert.match(await run(value), /7 checked, 7 patched/);
    });
  });
}

test("preflight rejects an escaping cache parent even when its SDK links back into scope", async (): Promise<void> => {
  await withFixture(async (value: Fixture, directory: string): Promise<void> => {
    const standalone = join(directory, "standalone");
    await json(join(standalone, "package.json"), { name: "subagents" });
    await host(standalone, sdkName);
    await rename(join(standalone, "node_modules"), join(standalone, "local-modules"));
    const external = join(directory, "external-modules");
    await mkdir(join(external, "@earendil-works"), { recursive: true });
    await symlink(join(standalone, "local-modules", sdkName), join(external, sdkName), "dir");
    await json(join(external, ".package-lock.json"), { protected: "outside selected root" });
    await symlink(external, join(standalone, "node_modules"), "dir");
    const before = await snapshot(directory);
    await assert.rejects(run(value, [standalone]), /outside this development checkout/);
    assert.deepEqual(await snapshot(directory), before);
  });
});

test("nested matcher replacement updates its actual shrinkwrap key, not the root dependency", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const sdk = value.sdkDirectories[0];
    assert.ok(sdk);
    const nested = join(sdk, "node_modules/minimatch/node_modules/brace-expansion");
    await mkdir(dirname(nested), { recursive: true });
    await cp(join(sdk, "node_modules/brace-expansion"), nested, { recursive: true });
    const rootBefore = await snapshot(join(sdk, "node_modules/brace-expansion"));
    await update(join(sdk, "npm-shrinkwrap.json"), (metadata: Record<string, unknown>): void => {
      const entries = record(metadata.packages);
      entries["node_modules/minimatch/node_modules/brace-expansion"] = { ...record(entries["node_modules/brace-expansion"]) };
      metadata.packages = entries;
    });
    await run(value);
    const metadata: unknown = JSON.parse(await readFile(join(sdk, "npm-shrinkwrap.json"), "utf8"));
    const entries = record(record(metadata).packages);
    assert.equal(record(entries["node_modules/brace-expansion"]).version, "5.0.9");
    assert.equal(record(entries["node_modules/minimatch/node_modules/brace-expansion"]).version, "5.0.12");
    assert.equal(await readFile(join(nested, "index.cjs"), "utf8"), "module.exports = 'patched';\n");
    assert.deepEqual(await snapshot(join(sdk, "node_modules/brace-expansion")), rootBefore);
    assert.match(await run(value), /7 checked, 0 patched/);
  });
});

test("a changed staged undici manifest is rejected before either library is promoted", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    const preload = join(value.root, "change-staged-undici.mts");
    await writeFile(preload, `import fs, { type CopyOptions } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const original = fs.promises.cp;
fs.promises.cp = async (source: string | URL, target: string | URL, options?: CopyOptions): Promise<void> => {
  await original(source, target, options);
  if (source === process.env.TEST_SOURCE_PATH) await fs.promises.writeFile(join(String(target), "package.json"), JSON.stringify({ name: "undici", version: "8.10.1" }));
};
syncBuiltinESMExports();\n`);
    const before = await snapshot(value.root);
    await assert.rejects(execute(process.execPath, ["--import", preload, join(value.root, "scripts/patch-pi-host-security.mts")], {
      cwd: value.root, env: { ...process.env, TEST_SOURCE_PATH: join(value.root, "node_modules/undici") }, timeout: 10_000, maxBuffer: 65_536,
    }), /Security source changed during staging/);
    assert.deepEqual(await snapshot(value.root), before);
    assert.match(await run(value), /7 checked, 7 patched/);
  });
});
