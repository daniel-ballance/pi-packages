import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function assertSafe(name: string, version: unknown, source: string): void {
  assert.ok(typeof version === "string", `${source}: version must be a string`);
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(parts, `${source}: stable version required`);
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  const patch = Number(parts[3]);
  assert.ok([major, minor, patch].every(Number.isSafeInteger));
  if (name === "@modelcontextprotocol/sdk") {
    assert.ok(major === 1 && minor >= 31, `${source}: MCP OAuth credential disclosure requires SDK >=1.31.0`);
  } else if (name === "fast-uri") {
    assert.ok(major === 3 && (minor > 1 || (minor === 1 && patch >= 8)), `${source}: fast-uri requires >=3.1.8`);
  } else if (name === "ip-address") {
    assert.ok(major === 10 && (minor > 7 || (minor === 7 && patch >= 1)), `${source}: ip-address requires >=10.7.1`);
  } else if (name === "proxy-addr") {
    assert.ok(major === 2 && (minor > 0 || patch >= 8), `${source}: proxy-addr requires >=2.0.8`);
  } else {
    assert.equal(name, "undici");
    assert.ok((major === 8 && (minor > 10 || (minor === 10 && patch >= 2))) ||
      (major === 7 && minor >= 30), `${source}: undici ${version} is below its reviewed security floor`);
  }
}

async function assertLock(path: string): Promise<number> {
  const lock: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof lock === "object" && lock !== null && "packages" in lock);
  assert.ok(typeof lock.packages === "object" && lock.packages !== null && !Array.isArray(lock.packages));
  const entries: [string, unknown][] = Object.entries(lock.packages);
  let count = 0;
  for (const [location, entry] of entries) {
    const name = ["@modelcontextprotocol/sdk", "undici", "fast-uri", "ip-address", "proxy-addr"]
      .find((candidate: string): boolean => location.endsWith(`node_modules/${candidate}`));
    if (name === undefined) continue;
    assert.ok(typeof entry === "object" && entry !== null && "version" in entry);
    assertSafe(name, entry.version, `${path}: ${location}`);
    count++;
  }
  return count;
}

test("root and standalone locks exclude vulnerable MCP SDK and undici versions", async (): Promise<void> => {
  let count = await assertLock(join(root, "package-lock.json"));
  for (const item of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const directory = join(root, "packages", item.name);
    if (!(await readdir(directory)).includes("package-lock.json")) continue;
    count += await assertLock(join(directory, "package-lock.json"));
  }
  assert.ok(count > 0);
});

test("pnpm graph excludes vulnerable MCP SDK and undici versions", async (): Promise<void> => {
  const text = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const start = text.indexOf("\npackages:\n");
  assert.ok(start >= 0, "pnpm package graph must be present");
  const entries = [...text.slice(start).matchAll(/^ {2}(?:'(@modelcontextprotocol\/sdk)@([^':()]+)(?:[^']*)'|(undici|fast-uri|ip-address|proxy-addr)@([^:()]+)(?:[^:]*)):/gm)];
  assert.ok(entries.length > 0);
  for (const item of entries) assertSafe(item[1] ?? item[3] ?? "", item[2] ?? item[4], "pnpm graph");
});

test("standalone MCP transitive security fixes stay above their reviewed floors", async (): Promise<void> => {
  const lock: unknown = JSON.parse(await readFile(join(root, "packages/mcp-client/package-lock.json"), "utf8"));
  assert.ok(typeof lock === "object" && lock !== null && "packages" in lock);
  assert.ok(typeof lock.packages === "object" && lock.packages !== null);
  const entries: [string, unknown][] = Object.entries(lock.packages);
  for (const name of ["fast-uri", "ip-address", "proxy-addr"]) {
    const found = entries.filter(([path]: [string, unknown]): boolean => path.endsWith(`node_modules/${name}`));
    assert.ok(found.length > 0);
    for (const [path, entry] of found) {
      assert.ok(typeof entry === "object" && entry !== null && "version" in entry);
      assertSafe(name, entry.version, path);
    }
  }
});

test("installed legacy development hosts actually resolve patched undici", async (): Promise<void> => {
  for (const name of ["mcp-client", "self-reload", "web-search"]) {
    const sdk = join(root, "packages", name, "node_modules/@earendil-works/pi-coding-agent");
    const require = createRequire(join(sdk, "dist/index.js"));
    const path = require.resolve("undici/package.json");
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
    assertSafe("undici", manifest.version, path);
  }
});

test("installed legacy MCP transport uses the patched SDK", async (): Promise<void> => {
  const require = createRequire(join(root, "packages/mcp-client/package.json"));
  const entry = require.resolve("@modelcontextprotocol/sdk/client/index.js");
  const path = join(dirname(entry), "../../../package.json");
  const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
  assertSafe("@modelcontextprotocol/sdk", manifest.version, path);
});
