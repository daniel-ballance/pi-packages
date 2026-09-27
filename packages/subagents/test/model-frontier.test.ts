import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
// @ts-expect-error Dependency-free CLI module intentionally ships as JavaScript.
import { analyze, dominates, frontierView, markdown, tradeoff, validateConfig } from "../skills/subagents/scripts/model-frontier.mjs";

test("repository preferences and skill resolve to the documented maintainer workflow", () => {
  const configUrl = new URL("../../../.pi/model-selection.json", import.meta.url);
  const config = validateConfig(JSON.parse(readFileSync(configUrl, "utf8")));
  assert.ok(config.parentOnlyModels.includes("openai-codex/gpt-6-astra"));
  const skillUrl = new URL("../../../.pi/skills/refresh-subagent-models/SKILL.md", import.meta.url);
  const skill = readFileSync(skillUrl, "utf8");
  assert.match(skill, /name: refresh-subagent-models/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.equal(new URL("../../model-selection.json", skillUrl).href, configUrl.href);
  const loaded = loadSkillsFromDir({ dir: fileURLToPath(new URL(".", skillUrl)), source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills[0]?.name, "refresh-subagent-models");
  assert.equal(loaded.skills[0]?.disableModelInvocation, true);
});

function fixture(): any {
  const definitions = [
    ["one/small", ["low", "high", "xhigh", "max"], true],
    ["one/large", ["medium", "high"], true],
    ["two/backup", ["high"], true],
    ["one/api-only", ["high"], false],
    ["local/model", ["high"], true],
  ] as const;
  const inventory = { schemaVersion: 1, complete: true, runtimeVerified: true, piVersion: "test-1", targetPiVersion: "test-1", checkedAt: "2026-09-27T00:00:00Z",
    models: definitions.map(([id, thinkingLevels, subscription]) => ({ id, provider: id.split("/")[0], model: id.split("/")[1], thinkingLevels, billing: { subscription } })) };
  const data = [
    ["one/small:low", 10, 0.01], ["one/small:high", 20, 0.02],
    ["one/small:xhigh", 25, 0.04], ["one/small:max", 26, 0.08],
    ["one/large:medium", 30, 0.06], ["one/large:high", 31, 0.09],
    ["two/backup:high", 24, 0.2],
  ] as const;
  const aa = { schemaVersion: 1, complete: true, intelligenceIndexVersion: 4.3, methodologyVersion: "v4.3.2", retrievedAt: "2026-09-27T00:00:00Z",
    data: data.map(([id, score, cost], i) => ({ id: String(i), slug: `model-${i}`, name: id,
      evaluations: { artificial_analysis_intelligence_index: score },
      artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: cost } },
      pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2, price_1m_cache_hit_tokens: 0.1 } })) };
  const mappings = { version: 1, mappings: aa.data.map(a => ({ piId: a.name, aaId: a.id, aaSlug: a.slug, aaName: a.name,
    reviewedAt: "2026-09-27", evidence: "https://example.test/methodology", notes: "Synthetic matched-effort fixture; not a deployment assertion." })) };
  const config = { version: 1, costMetric: "costPerTask", subscriptionPools: [{ id: "primary", providers: ["one"] }, { id: "backup", providers: ["two"] }],
    parentOnlyModels: ["one/large"], ladders: [["one/small", "one/large"]], scoreTolerances: [0, 1, 2], budgetsUsdPerTask: [0.001, 0.04, 0.08, 1] };
  return { inventory, aa, mappings, config };
}

test("global dominance does not eliminate independent pool choices; exclusions recompute dominance", () => {
  const report = analyze(fixture());
  assert.equal(report.coverage.measured, 7);
  assert.ok(!report.views.global.frontier.includes("two/backup:high"));
  assert.deepEqual(report.views.pools[1].subagents.frontier, ["two/backup:high"]);
  assert.ok(!report.views.global.frontier.includes("one/small:max"));
  assert.ok(report.views.subagents.frontier.includes("one/small:max"));
  assert.ok(report.excluded.some((r: any) => r.id === "one/api-only" && r.reason === "not-subscription"));
  assert.ok(report.excluded.some((r: any) => r.id === "local/model"));
});

test("strict dominance retains ties and uses unrounded scores; zero cost is measured", () => {
  const rows = [{ id: "a", score: 1, cost: 0 }, { id: "b", score: 1, cost: 0 }, { id: "c", score: 1.00001, cost: 1 }];
  const view = frontierView(rows, fixture().config);
  assert.deepEqual(view.frontier, ["a", "b", "c"]);
  assert.equal(view.adjacent[0].costMultiplier, null);
  assert.equal(view.adjacent[0].additionalCostPerPoint, null);
  assert.equal(view.adjacent[1].pointsPerCostDoubling, null);
  assert.equal(dominates(rows[0], rows[1]), false);
  assert.equal(tradeoff(rows[0], rows[1]).relation, "tie");
});

test("tradeoffs describe absolute and relative gains, reversals and all thinking pairs", () => {
  const t = tradeoff({ id: "a", score: 10, cost: 1 }, { id: "b", score: 12, cost: 2 });
  assert.equal(t.intelligenceGain, 2);
  assert.equal(t.additionalCost, 1);
  assert.equal(t.costIncreasePercent, 100);
  assert.equal(t.additionalCostPerPoint, 0.5);
  assert.equal(t.pointsPerCostDoubling, 2);
  const report = analyze(fixture());
  assert.equal(report.comparisons.thinking.length, 7);
  const crossover = report.comparisons.crossovers[0];
  assert.equal(crossover.fromBaseline.length, 3);
  assert.equal(crossover.versusSameModelMax[0].relation, "destination-dominates");
  assert.equal(crossover.versusSameModelMax[0].additionalCostPerPoint, null);
});

test("null/absent costs stay unranked; secondary pricing can still use them", () => {
  const input = fixture();
  input.aa.data[0].artificial_analysis_intelligence_index_cost = null;
  input.aa.data[1].evaluations.artificial_analysis_intelligence_index = null;
  input.aa.data[2].pricing.price_1m_cache_hit_tokens = null;
  const report = analyze(input);
  assert.equal(report.coverage.measured, 5);
  assert.equal(report.rows.find((r: any) => r.id === "one/small:low").reason, "missing-score-or-task-cost");
  assert.equal(report.rows.find((r: any) => r.id === "one/small:xhigh").blendedPrice, null);
  assert.ok(report.views.blendedTokenPrice.global.dominance.some((r: any) => r.id === "one/small:low"));
});

test("mapping coverage is explicit and changed identities do not fuzzy-match", () => {
  const input = fixture();
  input.mappings.mappings.shift();
  input.aa.data[1].name = "different effort";
  input.aa.data = input.aa.data.filter((r: any) => r.id !== "2");
  input.inventory.models[0].thinkingLevels = ["low", "high", "xhigh"];
  const report = analyze(input);
  assert.equal(report.rows.find((r: any) => r.id.endsWith(":low")).reason, "no-reviewed-mapping");
  assert.equal(report.rows.find((r: any) => r.id === "one/small:high").reason, "mapping-identity-changed");
  assert.equal(report.rows.find((r: any) => r.id === "one/small:xhigh").reason, "mapped-aa-entry-missing");
  assert.deepEqual(report.unusedMappings, ["one/small:max"]);
  assert.ok(report.comparisons.crossovers[0].missing.includes("one/small:max"));
});

test("runtime mismatch, partial snapshots, ambiguous pools and malformed data fail closed", () => {
  for (const change of [
    (x: any) => { x.inventory.piVersion = "other"; },
    (x: any) => { x.inventory.runtimeVerified = false; },
    (x: any) => { x.inventory.complete = false; },
    (x: any) => { x.aa.complete = false; },
    (x: any) => { x.config.subscriptionPools[1].providers.push("one"); },
    (x: any) => { x.config.autoApply = true; },
    (x: any) => { x.mappings.mappings.push(x.mappings.mappings[0]); },
    (x: any) => { delete x.mappings.mappings[0].notes; },
    (x: any) => { x.aa.data.push(x.aa.data[0]); },
    (x: any) => { x.aa.data[0].evaluations.artificial_analysis_intelligence_index = "30"; },
    (x: any) => { x.aa.data[0].artificial_analysis_intelligence_index_cost.cost_per_task.total_cost = -1; },
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => analyze(input));
  }
});

test("budget tolerances are explicit and return cheapest acceptable alternatives", () => {
  const report = analyze(fixture());
  const choices = report.views.subagents.budgetChoices;
  assert.equal(choices[0].bestScore, null);
  assert.deepEqual(choices[0].tolerances[0].cheapestIds, []);
  assert.deepEqual(choices[2].tolerances[0].cheapestIds, ["one/small:max"]);
  assert.deepEqual(choices[2].tolerances[1].cheapestIds, ["one/small:xhigh"]);
});

test("previous snapshot changes are explicit, with methodology/config drift warnings", () => {
  const input = fixture();
  const previous = analyze(input);
  const same = analyze({ ...input, previous });
  assert.equal(same.changes.comparableMethodology, true);
  assert.equal(same.changes.changed.length, 0);
  input.aa.methodologyVersion = "v4.3.3";
  input.aa.data[0].evaluations.artificial_analysis_intelligence_index += 1;
  input.config.parentOnlyModels = [];
  const changed = analyze({ ...input, previous });
  assert.equal(changed.changes.comparableMethodology, false);
  assert.equal(changed.changes.sameConfig, false);
  assert.ok(changed.changes.changed.some((r: any) => r.id === "one/small:low"));
  assert.match(changed.changes.warning, /descriptive/);
});

test("reports are deterministic and current-policy alternatives include skipping weak intermediate steps", () => {
  const input = fixture();
  const a = analyze({ ...input, policy: { models: [{ id: "one/small:xhigh" }, { id: "absent/model:high" }] } });
  const b = analyze({ ...input, policy: { models: [{ id: "one/small:xhigh" }, { id: "absent/model:high" }] } });
  assert.deepEqual(a, b);
  assert.deepEqual(a.comparisons.currentPolicy[0].alternatives.map((r: any) => r.to), ["one/small:max"]);
  assert.equal(a.comparisons.currentPolicy[1].measured, false);
  assert.match(markdown(a), /Pool backup/);
  assert.match(markdown(a), /Source: \[Artificial Analysis\]/);
  assert.match(markdown(a), /not a policy proposal/);
});

test("CLI runs offline, writes private new reports and input hashes, never modifies source or policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "frontier-test-"));
  try {
    const input = fixture();
    const paths: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      const path = join(dir, key + ".json");
      writeFileSync(path, JSON.stringify(value));
      paths.push(`--${key}`, path);
    }
    const policy = join(dir, "policy.json");
    const policyText = JSON.stringify({ models: [{ id: "one/small:high", description: "Keep me" }], tools: ["read"] });
    writeFileSync(policy, policyText);
    const script = fileURLToPath(new URL("../skills/subagents/scripts/model-frontier.mjs", import.meta.url));
    const out = join(dir, "output");
    const args = [script, ...paths, "--policy", policy, "--out", out];
    const run = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(out).sort(), ["report.json", "report.md"]);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, "report.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(out, "report.md")).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    assert.match(report.inputSha256.inventory, /^[a-f0-9]{64}$/);
    assert.equal(readFileSync(policy, "utf8"), policyText);
    assert.equal(spawnSync(process.execPath, args).status, 1);
    writeFileSync(join(dir, "inventory.json"), "secret-malformed-json");
    const bad = spawnSync(process.execPath, [...args.slice(0, -1), join(dir, "bad-output")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.ok(!bad.stderr.includes("secret-malformed-json"));
    assert.equal(spawnSync(process.execPath, [script, "--help"]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
