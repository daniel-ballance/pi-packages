#!/usr/bin/env node
/** Read-only model metadata; never request inference or serialize credentials. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    exclude: { type: "string", multiple: true, default: [] },
    out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node model-inventory.mjs [--exclude model-id|provider/model-id]... [--out NEW_FILE]\n" +
      "Uses the installed Pi SDK and current Pi agent directory. Disables catalog network refresh; no inference.\n" +
      "Only public metadata is emitted. Existing output files are never overwritten.\n" +
      "Cross-check pi --offline --list-models for providers registered by extensions in a full Pi launch.");
    return;
  }
  const { ModelRuntime, VERSION } = await import("@earendil-works/pi-coding-agent");
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  if (runtime.getError()) throw new Error("Pi model configuration could not be loaded completely");
  const models = (await runtime.getAvailable()).filter(m =>
    !values.exclude.includes(m.id) && !values.exclude.includes(`${m.provider}/${m.id}`));
  const inventory = {
    checkedAt: new Date().toISOString(), piVersion: VERSION,
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
