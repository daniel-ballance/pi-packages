import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../..", import.meta.url));

// Current dependency line: all three 2026 denial-of-service advisories are
// patched in 5.0.12. A deliberate major upgrade must review this contract.
function assertPatched(version: unknown, source: string): void {
  assert.ok(typeof version === "string", `${source}: version must be a string`);
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(parts, `${source}: expected a stable semantic version`);
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  const patch = Number(parts[3]);
  assert.ok([major, minor, patch].every(Number.isSafeInteger));
  assert.ok(major === 5 && (minor > 0 || patch >= 12),
    `${source}: brace-expansion ${version} is below the reviewed 5.0.12 security floor`);
}

async function assertNpmLockPatched(path: string): Promise<number> {
  const lock: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof lock === "object" && lock !== null && "packages" in lock);
  assert.ok(typeof lock.packages === "object" && lock.packages !== null && !Array.isArray(lock.packages));
  const entries: [string, unknown][] = Object.entries(lock.packages);
  let count = 0;
  for (const [location, entry] of entries) {
    if (!location.endsWith("node_modules/brace-expansion")) continue;
    assert.ok(typeof entry === "object" && entry !== null && "version" in entry);
    assertPatched(entry.version, `${path}: ${location}`);
    count++;
  }
  return count;
}

test("installed Pi host resolves patched brace-expansion despite its published shrinkwrap", async (): Promise<void> => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const matcherRequire = createRequire(sdkRequire.resolve("minimatch"));
  const path = matcherRequire.resolve("brace-expansion/package.json");
  const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
  assertPatched(manifest.version, path);
});

test("collection npm lock contains only patched brace-expansion entries", async (): Promise<void> => {
  assert.ok(await assertNpmLockPatched(join(root, "package-lock.json")) > 0);
});

test("standalone npm locks contain only patched brace-expansion entries", async (): Promise<void> => {
  let count = 0;
  for (const name of ["mcp-client", "p3stack", ...["claude-subscription", "computer-use", "self-reload", "subagents", "todo", "web-search"].map(name => `p3stack/${name}`)]) {
    const directory = join(root, "packages", name);
    if (!(await readdir(directory)).includes("package-lock.json")) continue;
    count += await assertNpmLockPatched(join(directory, "package-lock.json"));
  }
  assert.ok(count > 0, "standalone locks must exercise the security floor");
});

test("pnpm lock contains only patched brace-expansion entries", async (): Promise<void> => {
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const versions = [...lock.matchAll(/^ {2}brace-expansion@([^:]+):/gm)];
  assert.ok(versions.length > 0, "pnpm packages/snapshots must exercise the security floor");
  for (const match of versions) assertPatched(match[1], "pnpm-lock.yaml");
});
