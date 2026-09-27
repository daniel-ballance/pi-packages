#!/usr/bin/env node
/** Read-only model metadata; never request inference or serialize credentials. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function publicModel(model, levels, billing) {
  return {
    id: `${model.provider}/${model.id}`, provider: model.provider, model: model.id,
    api: model.api, input: model.input, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
    thinkingLevels: levels, thinkingLevelMap: model.thinkingLevelMap,
    pricing: { unit: "USD per million tokens; registry estimates, not billing", rates: model.cost },
    billing,
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

function runChild(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failed = false;
    let timer, killer;
    const cleanup = () => { clearTimeout(timer); clearTimeout(killer); };
    const fail = () => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), 250);
      killer.unref?.();
      // Wait for close before rejecting so temporary files outlive the child.
    };
    const append = (current, chunk) => {
      if (current.length + chunk.length > MAX_CAPTURE_BYTES) { fail(); return current; }
      return Buffer.concat([current, chunk]);
    };
    timer = setTimeout(fail, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      cleanup();
      if (failed || code !== 0 || signal) reject(new Error("child failed"));
      else resolvePromise({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

function parseVersion(text) {
  const match = text.match(/(?:^|\b)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\b|$)/);
  if (!match) throw new Error("version failed");
  return match[1];
}

async function runRuntime(executable, excluded, reviewedExtensions, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const version = parseVersion((await runChild(executable, ["--version"], { timeoutMs })).stdout);
  const directory = mkdtempSync(join(tmpdir(), "pi-model-inventory-"));
  const outputPath = join(directory, "inventory.json");
  try {
    const exporter = fileURLToPath(new URL("./model-inventory-extension.ts", import.meta.url));
    const args = ["--offline", "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve"];
    for (const extension of reviewedExtensions) args.push("--extension", extension);
    args.push("--extension", exporter);
    const env = { ...process.env, PI_MODEL_INVENTORY_OUTPUT: outputPath,
      PI_MODEL_INVENTORY_TARGET_VERSION: version, PI_MODEL_INVENTORY_EXCLUDE: JSON.stringify(excluded) };
    await runChild(executable, args, { env, timeoutMs });
    const inventory = JSON.parse(readFileSync(outputPath, "utf8"));
    if (inventory.runtimeVerified !== true || inventory.piVersion !== version || inventory.targetPiVersion !== version ||
        inventory.schemaVersion !== 1 || inventory.complete !== true) throw new Error("inventory validation failed");
    return inventory;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const { values } = parseArgs({ args, options: {
    exclude: { type: "string", multiple: true, default: [] },
    extension: { type: "string", multiple: true, default: [] },
    pi: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node model-inventory.mjs [--pi EXECUTABLE] [--extension REVIEWED_EXTENSION]... [--exclude model-id|provider/model-id]... [--out NEW_FILE]\n" +
      "--pi launches that exact Pi executable offline with a metadata-only exporter; no inference.\n" +
      "Without --pi, uses the installed Pi SDK. Only public metadata is emitted; output is never overwritten.");
    return;
  }
  if (!values.pi && values.extension.length) throw new Error("--extension requires --pi");
  if (values.pi) {
    const inventory = await runRuntime(values.pi, values.exclude, values.extension, options.timeoutMs);
    const text = JSON.stringify(inventory, null, 2) + "\n";
    if (values.out) writeFileSync(values.out, text, { flag: "wx", mode: 0o600 });
    else process.stdout.write(text);
    return;
  }
  const { ModelRuntime, VERSION } = await import("@earendil-works/pi-coding-agent");
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  if (runtime.getError()) throw new Error("Pi model configuration could not be loaded completely");
  const models = (await runtime.getAvailable()).filter(m =>
    !values.exclude.includes(m.id) && !values.exclude.includes(`${m.provider}/${m.id}`));
  const inventory = {
    checkedAt: new Date().toISOString(), piVersion: VERSION, runtimeVerified: false,
    targetPiVersion: null, schemaVersion: 1, complete: true,
    scope: "Current Pi SDK availability (models.json and configured authentication); not the subagent allowlist or model-cycling shortlist. Does not load extension-registered providers. Availability is not a successful inference test.",
    excluded: values.exclude,
    models: models.map(m => publicModel(m, getSupportedThinkingLevels(m), {
      oauth: runtime.isUsingOAuth(m.provider), subscription: runtime.isUsingSubscription(m.provider),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const text = JSON.stringify(inventory, null, 2) + "\n";
  if (values.out) writeFileSync(values.out, text, { flag: "wx", mode: 0o600 });
  else process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Provider errors can contain endpoint/configuration details. Do not dump them.
    console.error("Inventory failed. Check arguments, output-file existence, installed Pi SDK dependencies, and pi --offline --list-models. No credentials were printed by this script.");
    process.exitCode = 1;
  });
}
