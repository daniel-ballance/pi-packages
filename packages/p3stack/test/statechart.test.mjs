import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
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
cpSync(new URL("../vendor/pstack/pstack/skills/statechart/", import.meta.url), join(fixture, "statechart"), { recursive: true });
const scripts = join(fixture, "statechart/scripts");
const require = createRequire(import.meta.url);
mkdirSync(join(fixture, "node_modules"));
symlinkSync(dirname(require.resolve("fast-check/package.json")), join(fixture, "node_modules/fast-check"), "dir");
const rendererSuite = join(scripts, "test/render.test.ts");
let source = readFileSync(rendererSuite, "utf8");
const installStart = source.indexOf("const install = ");
const installEnd = source.indexOf("\nlet render:", installStart);
assert.ok(installStart >= 0 && installEnd > installStart, "upstream renderer provisioning helper changed");
source = source.slice(0, installStart) + `const install = (name: string) => createRequire(path.join(cache, name, "package.json"));
let rendererAvailable = true;
try {
  install("test-pele-1.9.0").resolve("pele");
  install("test-mermaid-11.16.0").resolve("mermaid");
  install("test-mermaid-11.16.0").resolve("jsdom");
} catch { rendererAvailable = false; }
const before = (fn: () => unknown) => { if (rendererAvailable) nodeBefore(fn); };
const test = (name: string, fn: () => unknown) => nodeTest(name, {
  skip: !rendererAvailable && "renderer packages are not installed; tests never provision them",
}, fn);
` + source.slice(installEnd);
source = source.replace('import { before, test } from "node:test";', 'import { before as nodeBefore, test as nodeTest } from "node:test";');
writeFileSync(rendererSuite, source);

writeFileSync(join(fixture, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(denied)}
echo 'Real npm provisioning is forbidden in package tests.' >&2
exit 78
`, { mode: 0o755 });

test("upstream statechart compiler, corpus, CLI, and differential suites", () => {
  const suites = readdirSync(join(scripts, "test")).filter(name => name.endsWith(".test.ts")).sort();
  assert.ok(suites.includes("differential.test.ts") && suites.includes("cli.test.ts"));
  const tools = installedTlc("tlc", "java");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (tools) { env.TLA2TOOLS = tools.jar; env.JAVA = tools.java; }
  else { delete env.TLA2TOOLS; delete env.JAVA; }
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...suites.map(name => join(scripts, "test", name))], {
    env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  process.stdout.write(result.stdout ?? "");
  assert.match(result.stdout, /# tests [1-9][0-9]*/, "upstream test runner must report executed tests");
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
});

test("emitted statechart launcher replays the committed corpus through its translated modules", () => {
  const corpus = join(scripts, "test/corpus/Login");
  const result = spawnSync(fileURLToPath(new URL("statechart", emitted)), [
    join(corpus, "Login.tla"), "--view", join(corpus, "view.mjs"), "--out", join(fixture, "emitted-output"),
  ], {
    env: { ...process.env, JAVA: join(scripts, "test/java.ts"), TLA2TOOLS: "tla2tools.jar", STATECHART_REPLAY: corpus },
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
  assert.ok(result.status === 0 || result.status === 1, result.stdout);
  for (const name of ["chart.mmd", "report.md"])
    assert.equal(readFileSync(join(fixture, "emitted-output", name), "utf8"), readFileSync(join(corpus, name), "utf8"));
});

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

test("statechart runtime resources preserve the compiler without shipping test fixtures", () => {
  const sourceFiles = readdirSync(upstream, { recursive: true }).filter(path =>
    !path.startsWith("test/") && (path === "statechart" || /\.(?:ts|json)$/.test(path))
  ).sort();
  const mapped = path => path === "passes/loop-check.ts" ? "passes/cycle-check.ts" : path;
  const outputFiles = readdirSync(emitted, { recursive: true }).filter(path =>
    path === "statechart" || /\.(?:ts|json)$/.test(path)
  ).sort();
  assert.deepEqual(outputFiles, sourceFiles.map(mapped).sort());
  assert.ok(!readdirSync(emitted).includes("test"));
  for (const path of sourceFiles) {
    if (path === "statechart" || path === "pipeline.ts") continue;
    assert.deepEqual(readFileSync(new URL(mapped(path), emitted)), readFileSync(new URL(path, upstream)), path);
  }
});
