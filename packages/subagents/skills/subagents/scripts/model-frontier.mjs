#!/usr/bin/env node
/** Offline evidence analysis. Never selects policy entries or invokes a model. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const text = (v) => typeof v === "string" && v.length > 0;
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function object(v, keys, label) {
  requireValue(v && typeof v === "object" && !Array.isArray(v), `Invalid ${label}`);
  requireValue(Object.keys(v).every(k => keys.includes(k)), `Unknown ${label} field`);
}
function unique(values, label) {
  requireValue(new Set(values).size === values.length, `Duplicate ${label}`);
}
function strings(values, label) {
  requireValue(Array.isArray(values) && values.every(text), `Invalid ${label}`);
  unique(values, label);
}
function splitId(id) {
  requireValue(text(id), "Invalid Pi identity");
  const i = id.lastIndexOf(":");
  const model = id.slice(0, i), thinking = id.slice(i + 1);
  requireValue(i > 0 && model.includes("/") && LEVELS.includes(thinking), "Invalid Pi model:thinking identity");
  return { model, thinking };
}
function optionalNumber(v, label) {
  requireValue(v == null || number(v), `Invalid ${label}`);
  return v ?? null;
}

export function validateConfig(config) {
  object(config, ["version", "costMetric", "subscriptionPools", "parentOnlyModels", "ladders", "scoreTolerances", "budgetsUsdPerTask"], "configuration");
  requireValue(config.version === 1 && config.costMetric === "costPerTask", "Unsupported configuration version or cost metric");
  requireValue(Array.isArray(config.subscriptionPools) && config.subscriptionPools.length > 0, "Subscription pools required");
  const providers = [];
  for (const pool of config.subscriptionPools) {
    object(pool, ["id", "providers"], "pool");
    requireValue(text(pool.id), "Pool identity required");
    strings(pool.providers, "pool providers");
    requireValue(pool.providers.length > 0, "Pool providers required");
    providers.push(...pool.providers);
  }
  unique(config.subscriptionPools.map(p => p.id), "pool");
  unique(providers, "provider pool assignment");
  strings(config.parentOnlyModels, "parent-only models");
  requireValue(config.parentOnlyModels.every(id => id.includes("/")), "Parent-only entries must be provider/model identities");
  requireValue(Array.isArray(config.ladders), "Ladders required");
  for (const ladder of config.ladders) {
    strings(ladder, "ladder models");
    requireValue(ladder.length >= 2 && ladder.every(id => id.includes("/")), "Ladder requires at least two provider/model identities");
  }
  for (const key of ["scoreTolerances", "budgetsUsdPerTask"]) {
    requireValue(Array.isArray(config[key]) && config[key].every(number), `Invalid ${key}`);
    unique(config[key], key);
  }
  return config;
}

export function dominates(a, b) {
  return a.score >= b.score && a.cost <= b.cost && (a.score > b.score || a.cost < b.cost);
}
export function tradeoff(a, b) {
  const intelligenceGain = b.score - a.score, additionalCost = b.cost - a.cost;
  const costMultiplier = a.cost > 0 ? b.cost / a.cost : null;
  const increasing = intelligenceGain > 0 && additionalCost > 0;
  return {
    from: a.id, to: b.id, intelligenceGain, additionalCost, costMultiplier,
    costIncreasePercent: costMultiplier === null ? null : (costMultiplier - 1) * 100,
    additionalCostPerPoint: increasing ? additionalCost / intelligenceGain : null,
    pointsPerCostDoubling: increasing && costMultiplier !== null ? intelligenceGain / Math.log2(costMultiplier) : null,
    relation: dominates(b, a) ? "destination-dominates" : dominates(a, b) ? "source-dominates" :
      a.score === b.score && a.cost === b.cost ? "tie" : "tradeoff",
  };
}
export function frontierView(rows, config) {
  const sorted = [...rows].sort((a, b) => a.cost - b.cost || b.score - a.score || order(a.id, b.id));
  const dominance = sorted.map(b => ({ id: b.id, dominators: sorted.filter(a => dominates(a, b)).map(a => a.id) }));
  const frontier = sorted.filter((_, i) => dominance[i].dominators.length === 0);
  const budgetChoices = [...config.budgetsUsdPerTask].sort((a, b) => a - b).map(budget => {
    const available = sorted.filter(r => r.cost <= budget);
    const bestScore = available.length ? Math.max(...available.map(r => r.score)) : null;
    return { budget, bestScore, tolerances: [...config.scoreTolerances].sort((a, b) => a - b).map(tolerance => {
      const choices = bestScore === null ? [] : available.filter(r => r.score >= bestScore - tolerance);
      const cheapest = choices[0]?.cost;
      return { tolerance, cheapestIds: choices.filter(r => r.cost === cheapest).map(r => r.id) };
    }) };
  });
  return { frontier: frontier.map(r => r.id), dominance,
    adjacent: frontier.slice(1).map((r, i) => tradeoff(frontier[i], r)), budgetChoices };
}

export function analyze({ inventory, aa, mappings, config, policy = null, previous = null }) {
  validateConfig(config);
  requireValue(inventory.schemaVersion === 1 && inventory.complete === true && inventory.runtimeVerified === true &&
    text(inventory.piVersion) && inventory.piVersion === inventory.targetPiVersion, "A complete runtime-verified Pi inventory is required; use model-inventory.mjs --pi");
  requireValue(Array.isArray(inventory.models), "Invalid inventory models");
  requireValue(aa.schemaVersion === 1 && aa.complete === true && number(aa.intelligenceIndexVersion) && Array.isArray(aa.data), "A complete AA snapshot is required");
  requireValue(text(inventory.checkedAt) && !Number.isNaN(Date.parse(inventory.checkedAt)) &&
    text(aa.retrievedAt) && !Number.isNaN(Date.parse(aa.retrievedAt)), "Snapshot retrieval timestamps required");
  requireValue(aa.methodologyVersion == null || (typeof aa.methodologyVersion === "string" && /^v\d+\.\d+\.\d+$/.test(aa.methodologyVersion) &&
    Number(aa.methodologyVersion.slice(1).split(".").slice(0, 2).join(".")) === aa.intelligenceIndexVersion), "Invalid or mismatched AA methodology version");
  unique(inventory.models.map(m => m.id), "inventory identity");
  unique(aa.data.map(m => m.id), "AA identity");
  unique(aa.data.map(m => m.slug), "AA slug");
  for (const m of inventory.models) {
    requireValue(text(m.provider) && text(m.model) && m.id === `${m.provider}/${m.model}`, "Invalid inventory identity");
    strings(m.thinkingLevels, "thinking levels");
    requireValue(m.thinkingLevels.every(l => LEVELS.includes(l)), "Unsupported thinking level");
    requireValue(typeof m.billing?.subscription === "boolean", "Missing subscription classification");
  }
  for (const m of aa.data) requireValue(text(m.id) && text(m.slug) && text(m.name), "Invalid AA identity");
  object(mappings, ["version", "mappings"], "mapping document");
  requireValue(mappings.version === 1 && Array.isArray(mappings.mappings), "Invalid mapping document");
  unique(mappings.mappings.map(m => m.piId), "Pi mapping");
  const mapped = new Map();
  for (const m of mappings.mappings) {
    object(m, ["piId", "aaId", "aaSlug", "aaName", "reviewedAt", "evidence", "notes"], "mapping");
    splitId(m.piId);
    requireValue([m.aaId, m.aaSlug, m.aaName, m.reviewedAt, m.evidence, m.notes].every(text), "Mapping requires identities, review date, evidence and deployment notes");
    requireValue(!Number.isNaN(Date.parse(m.reviewedAt)), "Invalid mapping review date");
    mapped.set(m.piId, m);
  }
  const aaById = new Map(aa.data.map(r => [r.id, r]));
  const poolByProvider = new Map(config.subscriptionPools.flatMap(p => p.providers.map(provider => [provider, p.id])));
  const rows = [], excluded = [], warnings = [];
  const encountered = new Set();
  for (const model of [...inventory.models].sort((a, b) => order(a.id, b.id))) {
    const pool = poolByProvider.get(model.provider);
    if (!pool || !model.billing.subscription) {
      excluded.push({ id: model.id, reason: !pool ? "provider-outside-reviewed-hosted-pools" : "not-subscription" });
      continue;
    }
    for (const level of model.thinkingLevels) {
      const id = `${model.id}:${level}`, mapping = mapped.get(id);
      encountered.add(id);
      const base = { id, model: model.id, thinking: level, pool, parentOnly: config.parentOnlyModels.includes(model.id) };
      if (!mapping) { rows.push({ ...base, status: "unranked", reason: "no-reviewed-mapping" }); continue; }
      const a = aaById.get(mapping.aaId);
      if (!a) { rows.push({ ...base, status: "unranked", reason: "mapped-aa-entry-missing" }); continue; }
      if (a.slug !== mapping.aaSlug || a.name !== mapping.aaName) {
        rows.push({ ...base, status: "unranked", reason: "mapping-identity-changed" }); continue;
      }
      const score = optionalNumber(a.evaluations?.artificial_analysis_intelligence_index, "Intelligence Index");
      const cost = optionalNumber(a.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost, "cost per task");
      const pricing = a.pricing ?? {};
      const prices = ["price_1m_cache_hit_tokens", "price_1m_input_tokens", "price_1m_output_tokens"].map(k => optionalNumber(pricing[k], k));
      const blendedPrice = prices.every(number) ? prices[0] * 0.7 + prices[1] * 0.2 + prices[2] * 0.1 : null;
      rows.push({ ...base, aaId: a.id, aaSlug: a.slug, aaName: a.name, mapping,
        score, cost, blendedPrice, status: score !== null && cost !== null ? "measured" : "unranked",
        ...(score === null || cost === null ? { reason: "missing-score-or-task-cost" } : {}) });
    }
  }
  const unusedMappings = mappings.mappings.filter(m => !encountered.has(m.piId)).map(m => m.piId).sort(order);
  if (unusedMappings.length) warnings.push("Mappings exist for unavailable, unsupported or out-of-scope combinations; review unusedMappings.");
  if (!aa.methodologyVersion) warnings.push("AA patch methodology version not recorded; API major.minor alone cannot identify all methodology changes.");
  const missingExclusions = config.parentOnlyModels.filter(id => !inventory.models.some(m => m.id === id));
  if (missingExclusions.length) warnings.push(`Parent-only identities absent from inventory; review for stale exclusions: ${missingExclusions.join(", ")}`);
  warnings.push("Name/effort mappings are reviewed hypotheses, not proof of API/subscription deployment equivalence. Unknown quota is not free capacity.");
  const measured = rows.filter(r => r.status === "measured");
  const subagents = measured.filter(r => !r.parentOnly);
  const views = { global: frontierView(measured, config), subagents: frontierView(subagents, config),
    pools: config.subscriptionPools.map(pool => ({ pool: pool.id,
      full: frontierView(measured.filter(r => r.pool === pool.id), config),
      subagents: frontierView(subagents.filter(r => r.pool === pool.id), config) })) };
  // Secondary unit-price comparison includes rows missing task-cost data, when price/score exist.
  const blended = rows.filter(r => number(r.score) && number(r.blendedPrice)).map(r => ({ ...r, cost: r.blendedPrice }));
  const blendConfig = { ...config, budgetsUsdPerTask: [] };
  views.blendedTokenPrice = { unit: "USD per million tokens, computed 7:2:1 cache-hit/input/output; not task cost",
    global: frontierView(blended, blendConfig), subagents: frontierView(blended.filter(r => !r.parentOnly), blendConfig) };
  const byId = new Map(measured.map(r => [r.id, r]));
  const comparisons = { thinking: [], crossovers: [], currentPolicy: [] };
  for (const model of [...new Set(measured.map(r => r.model))].sort(order)) {
    const options = measured.filter(r => r.model === model).sort((a, b) => LEVELS.indexOf(a.thinking) - LEVELS.indexOf(b.thinking));
    for (let i = 0; i < options.length; i++) for (let j = i + 1; j < options.length; j++) comparisons.thinking.push(tradeoff(options[i], options[j]));
  }
  for (const ladder of config.ladders) for (let i = 0; i < ladder.length - 1; i++) {
    const ids = [`${ladder[i]}:xhigh`, `${ladder[i]}:max`, `${ladder[i + 1]}:medium`, `${ladder[i + 1]}:high`];
    const baseline = byId.get(ids[0]), sameMax = byId.get(ids[1]);
    comparisons.crossovers.push({ baseline: ids[0], candidates: ids.slice(1),
      missing: ids.filter(id => !byId.has(id)),
      fromBaseline: baseline ? ids.slice(1).filter(id => byId.has(id)).map(id => tradeoff(baseline, byId.get(id))) : [],
      versusSameModelMax: sameMax ? ids.slice(2).filter(id => byId.has(id)).map(id => tradeoff(sameMax, byId.get(id))) : [] });
  }
  if (policy !== null) {
    requireValue(Array.isArray(policy.models), "Policy requires a models array");
    for (const entry of policy.models) {
      splitId(entry.id);
      const baseline = byId.get(entry.id);
      comparisons.currentPolicy.push({ id: entry.id, measured: Boolean(baseline),
        alternatives: baseline ? subagents.filter(r => r.score > baseline.score || dominates(r, baseline)).map(r => tradeoff(baseline, r)) : [] });
    }
  }
  const report = { schemaVersion: 1, sources: { piVersion: inventory.piVersion, inventoryCheckedAt: inventory.checkedAt,
    aaRetrievedAt: aa.retrievedAt, intelligenceIndexVersion: aa.intelligenceIndexVersion, methodologyVersion: aa.methodologyVersion ?? null },
    config, warnings, coverage: { inventoryModels: inventory.models.length, eligibleCombinations: rows.length,
      measured: measured.length, unranked: rows.length - measured.length }, rows, excluded, unusedMappings, views, comparisons };
  if (previous !== null) {
    requireValue(previous.schemaVersion === 1 && Array.isArray(previous.rows) && previous.sources && previous.views?.subagents, "Invalid previous report");
    const old = new Map(previous.rows.map(r => [r.id, r]));
    const now = new Map(rows.map(r => [r.id, r]));
    const comparable = previous.sources.intelligenceIndexVersion === report.sources.intelligenceIndexVersion &&
      text(report.sources.methodologyVersion) && previous.sources.methodologyVersion === report.sources.methodologyVersion;
    const sameConfig = JSON.stringify(previous.config) === JSON.stringify(config);
    report.changes = { comparableMethodology: comparable, sameConfig,
      warning: !comparable || !sameConfig ? "Methodology or preferences differ/are unknown; changes are descriptive, not a like-for-like performance trend." : null,
      added: rows.filter(r => !old.has(r.id)).map(r => r.id),
      removed: previous.rows.filter(r => !now.has(r.id)).map(r => r.id),
      changed: rows.filter(r => old.has(r.id) && ["status", "reason", "score", "cost", "aaId", "aaName", "aaSlug", "parentOnly", "pool"].some(k => r[k] !== old.get(r.id)[k])).map(r => ({ id: r.id, before: old.get(r.id), after: r })),
      frontierAdded: views.subagents.frontier.filter(id => !previous.views.subagents.frontier.includes(id)),
      frontierRemoved: previous.views.subagents.frontier.filter(id => !views.subagents.frontier.includes(id)),
      poolFrontiers: [...new Set([...views.pools.map(p => p.pool), ...(previous.views.pools ?? []).map(p => p.pool)])].sort(order).map(pool => {
        const before = previous.views.pools?.find(p => p.pool === pool)?.subagents.frontier ?? [];
        const after = views.pools.find(p => p.pool === pool)?.subagents.frontier ?? [];
        return { pool, added: after.filter(id => !before.includes(id)), removed: before.filter(id => !after.includes(id)) };
      }),
    };
  }
  // A saved report must remain a snapshot even when a caller edits its input preferences.
  return structuredClone(report);
}

const cell = value => String(value ?? "unknown").replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
const fmt = n => n == null ? "—" : Number(n.toFixed(4)).toString();
export function markdown(report) {
  const lines = ["# Subscription model frontier", "", "Source: [Artificial Analysis](https://artificialanalysis.ai/data-api/docs). Private analysis; review licensing before redistribution.",
    "", `Pi ${cell(report.sources.piVersion)}; AA index ${cell(report.sources.intelligenceIndexVersion)}; methodology ${cell(report.sources.methodologyVersion)}.`,
    `Coverage: ${report.coverage.measured}/${report.coverage.eligibleCombinations} eligible combinations measured.`, "",
    "This is evidence, not a policy proposal. Index points are not percent intelligence or task-success probabilities.", "",
    ...report.warnings.map(w => `- ${w}`)];
  const rows = new Map(report.rows.map(r => [r.id, r]));
  function view(title, v, price = false) {
    lines.push("", `## ${title}`, "", "| Pi configuration | Intelligence | Cost |", "|---|---:|---:|");
    for (const id of v.frontier) {
      const r = rows.get(id);
      lines.push(`| ${cell(id)} | ${fmt(r.score)} | ${fmt(price ? r.blendedPrice : r.cost)} |`);
    }
    if (!v.frontier.length) lines.push("No measured candidates.");
    lines.push("", price ? "Cost: USD/million tokens (computed 7:2:1 blend)." : "Cost: AA USD/task (not subscription quota or cost per successful task).");
    lines.push("", "### Adjacent tradeoffs", "", "| From → to | Δ index | Δ cost | Cost × | Δ cost/point | Points/doubling |", "|---|---:|---:|---:|---:|---:|");
    for (const t of v.adjacent) lines.push(`| ${cell(t.from)} → ${cell(t.to)} | ${fmt(t.intelligenceGain)} | ${fmt(t.additionalCost)} | ${fmt(t.costMultiplier)} | ${fmt(t.additionalCostPerPoint)} | ${fmt(t.pointsPerCostDoubling)} |`);
  }
  view("Full eligible frontier", report.views.global);
  view("Subagent-constrained frontier", report.views.subagents);
  for (const p of report.views.pools) {
    view(`Pool ${cell(p.pool)} — full`, p.full);
    view(`Pool ${cell(p.pool)} — subagents`, p.subagents);
  }
  view("Secondary blended-token-price frontier — subagents", report.views.blendedTokenPrice.subagents, true);
  lines.push("", "## Model-up / effort-down comparisons", "");
  for (const c of report.comparisons.crossovers) {
    lines.push(`### From ${cell(c.baseline)}`, "");
    if (c.missing.length) lines.push(`Unmeasured: ${c.missing.map(cell).join(", ")}.`, "");
    for (const t of [...c.fromBaseline, ...c.versusSameModelMax]) lines.push(`- ${cell(t.from)} → ${cell(t.to)}: ${fmt(t.intelligenceGain)} index points, ${fmt(t.costMultiplier)}× cost (${t.relation}).`);
  }
  lines.push("", "## Coverage gaps", "");
  for (const r of report.rows.filter(r => r.status !== "measured")) lines.push(`- ${cell(r.id)}: ${r.reason}`);
  for (const r of report.excluded) lines.push(`- ${cell(r.id)}: ${r.reason}`);
  for (const id of report.unusedMappings) lines.push(`- ${cell(id)}: unused mapping (unavailable/unsupported/out of scope)`);
  if (report.changes) lines.push("", "## Changes since previous report", "", `Comparable methodology: ${report.changes.comparableMethodology}; same preferences: ${report.changes.sameConfig}.`,
    report.changes.warning ?? "", `Added combinations: ${report.changes.added.map(cell).join(", ") || "none"}.`,
    `Removed combinations: ${report.changes.removed.map(cell).join(", ") || "none"}.`,
    `Changed evidence: ${report.changes.changed.map(r => cell(r.id)).join(", ") || "none"}.`,
    `New subagent frontier points: ${report.changes.frontierAdded.map(cell).join(", ") || "none"}.`,
    `Departed subagent frontier points: ${report.changes.frontierRemoved.map(cell).join(", ") || "none"}.`,
    ...report.changes.poolFrontiers.map(p => `Pool ${cell(p.pool)}: added ${p.added.map(cell).join(", ") || "none"}; removed ${p.removed.map(cell).join(", ") || "none"}.`));
  lines.push("", "Full dominance lists, budget/tolerance sensitivity, all within-model thinking comparisons and current-policy alternatives are in report.json.",
    "Small score gaps require judgment. Tolerances are preferences, not confidence intervals. Points/doubling describe a measured step, not extrapolated returns.", "");
  return lines.join("\n");
}

export function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: Object.fromEntries(["inventory", "aa", "mappings", "config", "policy", "previous", "out"].map(k => [k, { type: "string" }]).concat([["help", { type: "boolean" }]])) });
  if (values.help) {
    console.log("Usage: node model-frontier.mjs --inventory FILE --aa FILE --mappings FILE --config FILE --out NEW_DIRECTORY [--policy FILE] [--previous REPORT_JSON]\nOffline analysis only; writes private report.json/report.md, never policy. Missing evidence remains unranked. Requires runtime-verified inventory and complete AA snapshot.");
    return;
  }
  requireValue(["inventory", "aa", "mappings", "config", "out"].every(k => text(values[k])), "Required arguments missing");
  const inputs = {}, hashes = {};
  for (const key of ["inventory", "aa", "mappings", "config", "policy", "previous"]) {
    if (!values[key]) continue;
    const stat = statSync(values[key]);
    requireValue(stat.isFile() && stat.size <= 32 * 1024 * 1024, "Input must be a regular file at most 32 MiB");
    const raw = readFileSync(values[key]);
    requireValue(raw.length <= 32 * 1024 * 1024, "Input exceeds 32 MiB");
    inputs[key] = JSON.parse(raw.toString("utf8"));
    hashes[key] = createHash("sha256").update(raw).digest("hex");
  }
  const report = { ...analyze(inputs), inputSha256: hashes };
  mkdirSync(values.out, { mode: 0o700 });
  writeFileSync(resolve(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(values.out, "report.md"), markdown(report), { flag: "wx", mode: 0o600 });
  console.log(`Analysis complete: ${report.coverage.measured}/${report.coverage.eligibleCombinations} combinations measured. Private reports written.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch {
    // Inputs and errors may contain private metadata. No raw parser/network/config error logging.
    console.error("Frontier analysis failed. Check --help, input schemas, runtime alignment and new output directory; no policy was changed.");
    process.exitCode = 1;
  }
}
