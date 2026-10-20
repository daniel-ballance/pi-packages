import type { EffortLevel, ModelInfo, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "claude-subscription";
export const PROVIDER_NAME = "Claude subscription (Agent SDK)";
/** Custom API id: these models stream through the Agent SDK, not an HTTP endpoint Pi knows. */
export const API_ID = "claude-agent-sdk";
export type SubscriptionModel = Model<typeof API_ID>;

// Turns are priced as the API would bill them, as Pi prices other subscription providers.
// A model newer than Pi's catalog has no known price, so it counts as free until Pi lists it.
const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function isEffort(value: unknown): value is EffortLevel {
  return EFFORTS.some(effort => effort === value);
}

/** A model as this provider lists it: same limits and API prices, served through the Agent SDK. */
export function rehome(model: Model<Api>): SubscriptionModel {
  return {
    id: model.id,
    name: model.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "",
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    inputLimits: model.inputLimits,
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/** Pi's own Claude catalog, so limits and thinking levels follow the installed Pi release. */
export function baselineModels(): SubscriptionModel[] {
  return getBuiltinModels("anthropic").map(rehome);
}

/**
 * Models the signed-in account offers, as reported by Claude Code. Pi's catalog supplies
 * the metadata for models it knows; a model newer than the installed Pi gets conservative limits.
 */
export function discoveredModels(reported: readonly ModelInfo[], baseline: readonly SubscriptionModel[]): SubscriptionModel[] {
  const known = new Map(baseline.map(model => [model.id, model]));
  const models = new Map<string, SubscriptionModel>();
  for (const info of reported) {
    // Aliases such as "opus" resolve to a concrete id; the bare "default" row repeats one of them.
    const id = info.resolvedModel ?? info.value;
    if (!id.startsWith("claude-") || models.has(id)) continue;
    const match = known.get(id);
    if (match) {
      // A copy: the caller corrects its limits, and the baseline stays as Pi ships it.
      models.set(id, { ...match });
      continue;
    }
    const levels = info.supportedEffortLevels ?? [];
    const level = (effort: EffortLevel): EffortLevel | null => levels.includes(effort) ? effort : null;
    models.set(id, {
      id,
      name: info.displayName.startsWith("Claude") ? info.displayName : `Claude ${info.displayName}`,
      api: API_ID,
      provider: PROVIDER_ID,
      baseUrl: "",
      reasoning: levels.length > 0 || info.supportsAdaptiveThinking === true,
      // A model that reports effort levels takes adaptive thinking, which cannot be switched off.
      thinkingLevelMap: levels.length > 0
        ? { off: null, minimal: null, low: level("low"), medium: level("medium"), high: level("high"), xhigh: level("xhigh"), max: level("max") }
        : undefined,
      input: ["text", "image"],
      cost: UNKNOWN_COST,
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
  }
  return [...models.values()];
}

export interface Thinking {
  thinking: ThinkingConfig;
  effort?: EffortLevel;
}

const DEFAULT_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384,
};

/** Effort for a level, as Pi's own Anthropic adapter picks it: the model's map first, then the nearest level it surely has. */
function effortFor(model: Model<Api>, level: ThinkingLevel | undefined): EffortLevel {
  const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
  if (isEffort(mapped)) return mapped;
  return level === "minimal" || level === "low" ? "low" : level === "medium" ? "medium" : "high";
}

/**
 * Translate Pi's thinking level for a Claude Code session. Models with a level map take
 * adaptive thinking steered by effort; the older ones take a token budget.
 */
export function thinkingFor(model: Model<Api>, options: Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets"> | undefined): Thinking {
  const level = options?.reasoning;
  if (model.thinkingLevelMap) {
    // `off: null` marks a model whose thinking cannot be disabled; without a level it runs at Pi's default effort.
    if (!level && model.thinkingLevelMap.off !== null) return { thinking: { type: "disabled" } };
    return { thinking: { type: "adaptive", display: "summarized" }, effort: effortFor(model, level) };
  }
  if (!level || !model.reasoning) return { thinking: { type: "disabled" } };
  const budgets: Partial<Record<ThinkingLevel, number>> = options?.thinkingBudgets ?? {};
  return { thinking: { type: "enabled", budgetTokens: budgets[level] ?? DEFAULT_BUDGETS[level], display: "summarized" } };
}
