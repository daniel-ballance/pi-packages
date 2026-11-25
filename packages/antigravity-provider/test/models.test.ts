import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { baselineModels, catalog, thinkingFor, type AgySessionResponse } from "../extensions/antigravity-provider/src/models.js";

const recorded = JSON.parse(readFileSync(new URL("fixtures/session-new.json", import.meta.url), "utf8")) as AgySessionResponse;

test("parses agy's model selectors and variant suffixes into Pi model families", () => {
  const models = catalog(recorded);
  assert.deepEqual(models.map(row => row.model.id), baselineModels().map(model => model.id));
  const levels = (id: string) => models.find(row => row.model.id === id)?.levels;
  assert.deepEqual(levels("gemini-4-neon"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(levels("gemini-3.8-flash"), ["low", "medium", "high"]);
  assert.deepEqual(levels("claude-opus-5-5"), ["low", "medium", "high"]);
  assert.deepEqual(levels("gpt-oss-120b-medium"), []);
  assert.deepEqual(levels("gemini-pro-orchestrator-neon"), []);
  assert.equal(models[0].model.contextWindow, 1_048_576);
  assert.equal(models[0].model.thinkingLevelMap?.off, null);
});

test("maps unsupported/off thinking to the nearest available level", () => {
  assert.equal(thinkingFor(["low", "medium", "high"], undefined), "low");
  assert.equal(thinkingFor(["medium", "high"], "minimal"), "medium");
  assert.equal(thinkingFor(["low", "high"], "medium"), "low");
  assert.equal(thinkingFor(["high", "xhigh"], "max"), "xhigh");
  assert.equal(thinkingFor(["low", "high"], "xhigh"), "high");
  assert.equal(thinkingFor([], "low"), undefined);
});
