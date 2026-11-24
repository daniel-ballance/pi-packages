import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This fixture doesn't install Vitest. Its defineConfig helper is an identity;
// load the actual edited module, including expressions and test-mode callbacks.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "vitest/config") return { url: "data:text/javascript,export const defineConfig = config => config", shortCircuit: true };
  return next(specifier, context);
} });
const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
assert.match(scripts?.test, /^\s*vitest\s+run\s+--coverage(?:=true)?\s*$/, "fixture test command must run Vitest with coverage");
process.env.NODE_ENV = "test";
process.env.VITEST = "true";
const { default: exported } = await import(pathToFileURL(resolve("vitest.config.ts")));
const config = await (typeof exported === "function" ? exported({ mode: "test", command: "serve" }) : exported);
assert.equal(config?.test?.coverage?.thresholds?.lines, 80);
