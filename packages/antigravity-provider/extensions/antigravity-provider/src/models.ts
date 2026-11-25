import type { NewSessionResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-acp";
export type AntigravityModel = Model<typeof API_ID>;

const LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ThoughtLevel = typeof LEVELS[number];
const TARGET: Record<ThinkingLevel | "off", ThoughtLevel> = {
  off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh",
};
const LEVELS_THROUGH_HIGH = LEVELS.slice(0, 3);
const BASELINE = [
  ["gemini-4-neon", "Gemini 4 Neon", LEVELS],
  ["gemini-4-carbon", "Gemini 4 Carbon", LEVELS_THROUGH_HIGH],
  ["gemini-4-argon", "Gemini 4 Argon", LEVELS_THROUGH_HIGH],
  ["gemini-4-hydrogen", "Gemini 4 Hydrogen", LEVELS],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)", []],
  ["gemini-pro-orchestrator", "Orchestrator (Carbon)", []],
  ["gemini-pro-orchestrator-argon", "Orchestrator (Argon)", []],
  ["gemini-3.8-flash", "Gemini 3.8 Flash", LEVELS_THROUGH_HIGH],
  ["claude-opus-5-5", "Claude Opus 5.5", LEVELS_THROUGH_HIGH],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", LEVELS_THROUGH_HIGH],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", []],
] as const;

export function thinkingFor(levels: readonly ThoughtLevel[], reasoning: ThinkingLevel | undefined): ThoughtLevel | undefined {
  const target = LEVELS.indexOf(TARGET[reasoning ?? "off"]);
  return LEVELS.filter(level => levels.includes(level)).sort((a, b) =>
    Math.abs(LEVELS.indexOf(a) - target) - Math.abs(LEVELS.indexOf(b) - target))[0];
}

function model(id: string, name: string, levels: readonly ThoughtLevel[]): AntigravityModel {
  return {
    id, name, api: API_ID, provider: PROVIDER_ID, baseUrl: "", input: ["text", "image"],
    reasoning: levels.length > 0,
    thinkingLevelMap: levels.length ? Object.fromEntries(Object.keys(TARGET).map(level => [level,
      level === "off" ? null : thinkingFor(levels, level as ThinkingLevel)])) : undefined,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // agy reports a window on use, not in the catalog. Non-Gemini windows and output limits are estimates.
    contextWindow: id.startsWith("gemini-") ? 1_048_576 : id.startsWith("claude-") ? 200_000 : 131_072,
    maxTokens: 32_768,
  };
}

export function baselineModels(): AntigravityModel[] {
  return BASELINE.map(([id, name, levels]) => model(id, name, levels));
}

type Select = Extract<SessionConfigOption, { type: "select" }>;

export function findConfigSelect(config: readonly SessionConfigOption[] | null | undefined, id: string) {
  return config?.find((option): option is Select => option.type === "select" && option.id === id);
}

function configSelectChoices(option: Select | undefined) {
  return option?.options.flatMap(row => "options" in row ? row.options : [row]) ?? [];
}

export type AgySessionResponse = NewSessionResponse & {
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] };
};

export function catalog(session: AgySessionResponse) {
  const available = new Set(session.models?.availableModels.map(model => model.modelId));
  return configSelectChoices(findConfigSelect(session.configOptions, "model")).map(({ value: id, name }) => {
    const levels = LEVELS.filter(level => available.has(`${id}-${level}`));
    return { model: model(id, name, levels), levels };
  });
}

export function thoughtOptions(config: readonly SessionConfigOption[] | null | undefined): ThoughtLevel[] {
  const values = new Set(configSelectChoices(findConfigSelect(config, "thought_level")).map(row => row.value));
  return LEVELS.filter(level => values.has(level));
}
