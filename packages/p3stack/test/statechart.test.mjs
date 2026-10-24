import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { installedRenderer, installedTlc } from "./statechart-installed.mjs";

const upstream = new URL("../vendor/pstack/pstack/skills/statechart/scripts/", import.meta.url);
const emitted = new URL("../skills/statechart/scripts/", import.meta.url);
const fixture = mkdtempSync(join(tmpdir(), "p3stack-statechart-"));
const previousPath = process.env.PATH;
const previousOffline = process.env.npm_config_offline;
const realMise = spawnSync("sh", ["-c", "command -v mise"], { encoding: "utf8" }).stdout.trim();
const denied = join(fixture, "provisioning-attempts");
writeFileSync(join(fixture, "mise"), `#!/bin/sh
if [ "$1" = install ]; then
  printf '%s\\n' "$*" >> ${JSON.stringify(denied)}
  echo 'Real host provisioning is forbidden in package tests.' >&2
  exit 78
fi
${realMise ? `exec ${JSON.stringify(realMise)} "$@"` : "exit 127"}
`, { mode: 0o755 });
process.env.PATH = `${fixture}:${previousPath}`;
process.env.npm_config_offline = "true";
after(() => {
  process.env.PATH = previousPath;
  if (previousOffline === undefined) delete process.env.npm_config_offline;
  else process.env.npm_config_offline = previousOffline;
  try { assert.equal(readdirSync(fixture).includes("provisioning-attempts"), false, "unexpected real mise install"); }
  finally { rmSync(fixture, { recursive: true, force: true }); }
});
cpSync(upstream, join(fixture, "scripts"), { recursive: true });
const suite = join(fixture, "scripts/test/statechart.test.mjs");
let source = readFileSync(suite, "utf8");
const probes = [
  ["const tools = (() => {\n  try {\n    return findTlc();\n  } catch {\n    return null;\n  }\n})();", "const tools = installedTlc(TLC_TOOL, JAVA_TOOL);"],
  ["const lib = await loadRenderer().catch(() => null);", "const lib = await installedRenderer(cacheDir());"],
];
for (const [before, replacement] of probes) {
  assert.equal(source.split(before).length, 2, "upstream capability probe changed");
  source = source.replace(before, replacement);
}
const helper = new URL("./statechart-installed.mjs", import.meta.url).href;
writeFileSync(suite, `import { installedTlc, installedRenderer } from ${JSON.stringify(helper)};\n${source}`);
await import(pathToFileURL(suite).href);

test("statechart availability probes never provision missing tools", async () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 1, stdout: "" };
  };
  assert.equal(installedTlc("tlc", "java", { env: {}, exists: () => false, run }), null);
  assert.deepEqual(calls, [["mise", "where", "tlc"], ["mise", "which", "java", "--tool", "java"]]);
  assert.deepEqual(installedTlc("tlc", "java", {
    env: { TLA2TOOLS: "/installed/tlc.jar", JAVA: "/installed/java" },
    exists: () => true, run: () => assert.fail("explicit installed tools need no mise"),
  }), { jar: "/installed/tlc.jar", java: "/installed/java" });
  assert.equal(await installedRenderer("/missing", {
    exists: () => false, load: () => assert.fail("missing renderer must not load or install"),
  }), null);
  const renderer = { render() {} };
  assert.equal(await installedRenderer("/installed", { exists: () => true, load: async () => renderer }), renderer);
});

test("statechart runtime resources match upstream without shipping test fixtures", () => {
  const sourceFiles = readdirSync(upstream, { recursive: true }).filter(path =>
    !path.startsWith("test/") && /\.(?:mjs|cfg|tla)$/.test(path)
  ).sort();
  const outputFiles = readdirSync(emitted, { recursive: true }).filter(path =>
    /\.(?:mjs|cfg|tla|mmd)$/.test(path)
  ).sort();
  assert.deepEqual(outputFiles, sourceFiles);
  assert.ok(!readdirSync(emitted).includes("test"));
  for (const path of sourceFiles) {
    assert.deepEqual(readFileSync(new URL(path, emitted)), readFileSync(new URL(path, upstream)), path);
  }
});
