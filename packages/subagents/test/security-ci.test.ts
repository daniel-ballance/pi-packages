import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(join(repository, "packages/agent-skills/package.json"));
const yamlDirectory = dirname(require.resolve("yaml/package.json"));

test("current-runtime CI merges security overrides and restores workspace bytes on success or failure", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-security-ci-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "packages/agent-skills/node_modules"), { recursive: true });
    await mkdir(join(root, "packages/subagents"));
    for (const file of ["ci-install.sh", "package-manager.sh"]) {
      await cp(join(repository, "scripts", file), join(root, "scripts", file));
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-packages-repo" }));
    await writeFile(join(root, "packages/agent-skills/package.json"), JSON.stringify({ name: "agent-skills" }));
    await symlink(yamlDirectory, join(root, "packages/agent-skills/node_modules/yaml"), "dir");
    await writeFile(join(root, "packages/subagents/package.json"), JSON.stringify({
      name: "subagents", peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.99.2" },
    }));
    await writeFile(join(root, "packages/subagents/package-lock.json"), "{}");
    const workspace = "# Preserve this exact original document\npackages:\n  - packages/*\noverrides:\n  'undici@>=8.0.0 <8.10.2': '8.10.2'\n";
    await writeFile(join(root, "pnpm-workspace.yaml"), workspace);
    // External package-manager boundary only: no network or real installs.
    await writeFile(join(root, "bin/pnpm"), "#!/bin/sh\nexec node \"$TEST_CI_ROOT/probe.mjs\" \"$@\"\n", { mode: 0o755 });
    await writeFile(join(root, "scripts/patch-pi-host-security.mts"), "console.log('fixture explicit patch');\n");
    await writeFile(join(root, "probe.mjs"), `import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const root = process.env.TEST_CI_ROOT;
const { parse } = createRequire(root + "/packages/agent-skills/package.json")("yaml");
if (process.argv.includes("--no-frozen-lockfile")) {
  const value = parse(readFileSync(root + "/pnpm-workspace.yaml", "utf8"));
  if (value.overrides["undici@>=8.0.0 <8.10.2"] !== "8.10.2" || value.overrides["@earendil-works/pi-coding-agent@<1.0.0"] !== "0.99.2") throw new Error("overrides lost");
  writeFileSync(root + "/observed.json", JSON.stringify(value.overrides));
  if (process.env.TEST_CI_FAIL === "1") process.exit(7);
}\n`);
    const environment = {
      ...process.env, PACKAGE_MANAGER: "pnpm", TEST_CI_ROOT: root,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    };
    await execute("bash", [join(root, "scripts/ci-install.sh"), "0.99.2"], { cwd: root, env: environment, timeout: 10_000 });
    assert.equal(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"), workspace);
    const overrides: unknown = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
    assert.deepEqual(overrides, {
      "undici@>=8.0.0 <8.10.2": "8.10.2", "@earendil-works/pi-coding-agent@<1.0.0": "0.99.2",
    });
    await assert.rejects(execute("bash", [join(root, "scripts/ci-install.sh"), "0.99.2"], {
      cwd: root, env: { ...environment, TEST_CI_FAIL: "1" }, timeout: 10_000,
    }), { code: 7 });
    assert.equal(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"), workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
