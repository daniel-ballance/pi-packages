import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const inventoryScript = new URL("../skills/subagents/scripts/model-inventory.mjs", import.meta.url).href;
async function main(args: string[], options?: { timeoutMs?: number }) {
  const module = await import(inventoryScript);
  return module.main(args, options);
}
function fakePi(dir: string, body: string) {
  const path = join(dir, "fake-pi");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}
const fakeBody = `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('pi 0.87.1\\n'); process.exit(0); }
fs.writeFileSync(process.env.TEST_ARGS, JSON.stringify(args));
const path = process.env.PI_MODEL_INVENTORY_OUTPUT;
const version = process.env.PI_MODEL_INVENTORY_TARGET_VERSION;
const row = { id: 'test/model', provider: 'test', model: 'model', api: 'safe-api', input: ['text'], contextWindow: 100,
  maxOutputTokens: 50, thinkingLevels: ['medium'], thinkingLevelMap: null,
  pricing: { unit: 'safe', rates: { input: 1 } }, billing: { oauth: true, subscription: true } };
const inventory = { checkedAt: 'fixed', piVersion: version, targetPiVersion: version, runtimeVerified: true,
  schemaVersion: 1, complete: true, excluded: JSON.parse(process.env.PI_MODEL_INVENTORY_EXCLUDE), models: [row] };
fs.writeFileSync(path, JSON.stringify(inventory), { flag: 'wx', mode: 0o600 });
`;

test("runtime mode launches exact Pi offline without inference and emits verified, sanitized metadata exclusively", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-runtime-test-"));
  try {
    const argsPath = join(dir, "args.json");
    const pi = fakePi(dir, `process.env.TEST_ARGS = ${JSON.stringify(argsPath)};\n${fakeBody}`);
    const output = join(dir, "out.json");
    await main(["--pi", pi, "--extension", "/reviewed/provider.ts", "--extension", "/reviewed/second.ts",
      "--exclude", "test/ignored", "--out", output]);
    const actualArgs: string[] = JSON.parse(readFileSync(argsPath, "utf8"));
    for (const flag of ["--offline", "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--extension"]) {
      assert.ok(actualArgs.includes(flag), `missing ${flag}`);
    }
    assert.ok(!actualArgs.includes("--print") && !actualArgs.includes("--model"));
    assert.equal(actualArgs.filter(value => value === "--extension").length, 3);
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(result.runtimeVerified, true);
    assert.equal(result.piVersion, "0.87.1");
    assert.equal(result.targetPiVersion, result.piVersion);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(result.excluded, ["test/ignored"]);
    assert.throws(() => writeFileSync(output, "overwrite", { flag: "wx" }));
    assert.doesNotMatch(JSON.stringify(result), /SECRET|Authorization|headers|apiKey|baseUrl|endpoint/i);
    await assert.rejects(main(["--pi", pi, "--out", output]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtime version mismatch, failed child, and timeout fail closed with generic errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-runtime-failure-"));
  try {
    const mismatch = fakePi(dir, `
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('pi 0.87.1'); process.exit(0); }
fs.writeFileSync(process.env.PI_MODEL_INVENTORY_OUTPUT, JSON.stringify({ runtimeVerified: true, piVersion: '0.1.0', targetPiVersion: '0.87.1', schemaVersion: 1, complete: true }), { flag: 'wx' });
`);
    await assert.rejects(main(["--pi", mismatch]), /child failed|inventory validation failed/);
    const failure = fakePi(dir, `if (process.argv[2] === '--version') { console.log('pi 0.87.1'); process.exit(0); } console.error('SECRET_DIAGNOSTIC'); process.exit(7);`);
    await assert.rejects(main(["--pi", failure]), error => !String(error).includes("SECRET_DIAGNOSTIC"));
    const sleeping = fakePi(dir, `if (process.argv[2] === '--version') { console.log('pi 0.87.1'); process.exit(0); } setInterval(() => {}, 1000);`);
    await assert.rejects(main(["--pi", sleeping], { timeoutMs: 40 }), /child failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exporter exists at the launched path and reads the runtime registry without resolving credentials", async () => {
  const exporterUrl = new URL("../skills/subagents/scripts/model-inventory-extension.ts", import.meta.url);
  const { default: exporter } = await import(exporterUrl.href);
  const { VERSION } = await import("@earendil-works/pi-coding-agent");
  const dir = mkdtempSync(join(tmpdir(), "inventory-exporter-test-"));
  const output = join(dir, "inventory.json");
  const keys = ["PI_MODEL_INVENTORY_OUTPUT", "PI_MODEL_INVENTORY_TARGET_VERSION", "PI_MODEL_INVENTORY_EXCLUDE"];
  const previous = keys.map(k => process.env[k]);
  try {
    process.env.PI_MODEL_INVENTORY_OUTPUT = output;
    process.env.PI_MODEL_INVENTORY_TARGET_VERSION = VERSION;
    process.env.PI_MODEL_INVENTORY_EXCLUDE = "[]";
    let handler: any, stopped = false;
    exporter({ on(event: string, callback: any) { assert.equal(event, "session_start"); handler = callback; } });
    const ctx = { shutdown() { stopped = true; }, modelRegistry: {
      getError: () => undefined,
      getAvailable: () => [{ provider: "test", id: "model", reasoning: false, input: ["text"],
        headers: { Authorization: "SECRET" }, baseUrl: "PRIVATE", apiKey: "SECRET", cost: { input: 1, output: 2 } }],
      isUsingOAuth: () => true,
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
    } };
    await handler({}, ctx);
    assert.equal(stopped, true);
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(result.piVersion, VERSION);
    assert.equal(result.models[0].billing.subscription, true);
    assert.deepEqual(result.models[0].thinkingLevels, ["off"]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|Authorization|baseUrl|apiKey/);
    process.env.PI_MODEL_INVENTORY_OUTPUT = join(dir, "mismatch.json");
    process.env.PI_MODEL_INVENTORY_TARGET_VERSION = "mismatch";
    await handler({}, ctx);
    assert.equal(existsSync(join(dir, "mismatch.json")), false);
  } finally {
    keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime launcher rejects unparseable version and suppresses child output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-runtime-version-"));
  try {
    const invalid = fakePi(dir, "console.log('SECRET_VERSION_OUTPUT');");
    await assert.rejects(main(["--pi", invalid]), error => !String(error).includes("SECRET_VERSION_OUTPUT"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
