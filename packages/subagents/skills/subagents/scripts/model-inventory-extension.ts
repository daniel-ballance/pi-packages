import { writeFileSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publicModel } from "./model-inventory.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const output = process.env.PI_MODEL_INVENTORY_OUTPUT;
      const targetPiVersion = process.env.PI_MODEL_INVENTORY_TARGET_VERSION;
      const excluded = JSON.parse(process.env.PI_MODEL_INVENTORY_EXCLUDE ?? "[]") as string[];
      if (!output || !targetPiVersion || VERSION !== targetPiVersion || !Array.isArray(excluded)) {
        throw new Error("invalid inventory request");
      }
      const registry = ctx.modelRegistry;
      if (registry.getError()) throw new Error("registry unavailable");
      const models = await registry.getAvailable();
      if (registry.getError()) throw new Error("registry unavailable");
      const inventory = {
        checkedAt: new Date().toISOString(), piVersion: VERSION, targetPiVersion,
        runtimeVerified: true, schemaVersion: 1, complete: true,
        scope: "Availability from the target Pi runtime, including loaded providers and configured authentication. Availability is not a successful inference test.",
        excluded,
        models: models.filter(model => !excluded.includes(model.id) && !excluded.includes(`${model.provider}/${model.id}`))
          .map(model => {
            const provider = registry.getProvider(model.provider);
            return publicModel(model, getSupportedThinkingLevels(model), {
              oauth: registry.isUsingOAuth(model),
              subscription: registry.isUsingOAuth(model) && provider?.auth?.oauth?.isSubscription === true,
            });
          }).sort((a, b) => a.id.localeCompare(b.id)),
      };
      writeFileSync(output, JSON.stringify(inventory, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      // Fail closed without leaking provider metadata, credentials, or paths to stdout/stderr.
    } finally {
      ctx.shutdown();
    }
  });
}
