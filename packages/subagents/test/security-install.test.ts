import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/patch-pi-host-security.mts", import.meta.url));
const sdkName = "@earendil-works/pi-coding-agent";
const packageNames = ["durable-subagents", "mcp-client", "self-reload", "subagents", "t3-subagents", "web-search"];

type Fixture = { root: string; sdkDirectories: string[]; braceDirectories: string[] };

async function json(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

async function host(directory: string, alias: string): Promise<string> {
  const sdk = join(directory, "node_modules", alias);
  await json(join(sdk, "package.json"), { name: sdkName, version: "0.99.2", main: "index.js" });
  await writeFile(join(sdk, "index.js"), "");
  await json(join(sdk, "node_modules/minimatch/package.json"), { name: "minimatch", main: "index.js" });
  await writeFile(join(sdk, "node_modules/minimatch/index.js"), "");
  await json(join(sdk, "node_modules/brace-expansion/package.json"), {
    name: "brace-expansion", version: "5.0.9", main: "index.cjs", dependencies: { "balanced-match": "^4.0.2" },
  });
  await writeFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "module.exports = 'old';\n");
  await json(join(sdk, "npm-shrinkwrap.json"), {
    packages: {
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
  await json(join(root, "package-lock.json"), {
    packages: { "node_modules/brace-expansion": {
      version: "5.0.12", resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
      integrity: "sha512-fixture",
    } },
  });
  await mkdir(join(root, "scripts"));
  await cp(script, join(root, "scripts/patch-pi-host-security.mts"));
  const sdkDirectories: string[] = [];
  for (const name of packageNames) sdkDirectories.push(await host(join(root, "packages", name), sdkName));
  sdkDirectories.push(await host(join(root, "packages/durable-subagents"), "pi-host-1"));
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

test("explicit install step patches all seven SDKs, preserves their code/other entries, and is idempotent", async (): Promise<void> => {
  await withFixture(async (value: Fixture): Promise<void> => {
    assert.match(await run(value), /7 checked, 7 patched/);
    for (const sdk of value.sdkDirectories) {
      assert.equal(await readFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'patched';\n");
      assert.equal(await readFile(join(sdk, "index.js"), "utf8"), "");
      const metadata: unknown = JSON.parse(await readFile(join(sdk, "npm-shrinkwrap.json"), "utf8"));
      assert.deepEqual(metadata, { packages: {
        "node_modules/brace-expansion": { version: "5.0.12", resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz", integrity: "sha512-fixture", license: "MIT" },
        "node_modules/untouched": { version: "1.2.3" },
      } });
    }
    assert.match(await run(value), /7 checked, 0 patched/);
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
    assert.match(await run(value, [standalone]), /1 checked, 1 patched/);
    assert.equal(await readFile(join(sdk, "node_modules/brace-expansion/index.cjs"), "utf8"), "module.exports = 'patched';\n");
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
    assert.match(await run(value), /7 checked, 7 patched/);
  });
});
