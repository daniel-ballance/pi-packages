import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SpawnOptions } from "./manager.js";

export interface Composition {
  model: string; tools: string[];
  extensions?: string[]; skills?: string[]; promptTemplates?: string[]; themes?: string[];
  systemPrompt?: string; appendSystemPrompt?: string; contextFiles?: boolean;
}
export interface PolicyConfig {
  version: 1;
  models: { id: string; description?: string }[];
  tools: string[];
  extensions: string[]; skills: string[]; promptTemplates: string[]; themes: string[];
  systemPrompt: boolean; appendSystemPrompt: boolean; contextFiles: boolean;
  maxChildren: number; workingDirectories: string[];
  peerMessageLimit: number;
}
export interface LocalModel {
  provider: string; id: string; input: readonly string[]; contextWindow: number; maxTokens: number;
  cost: unknown; thinkingLevels: readonly string[];
}
export const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  models: [
    { id: "openai-codex/gpt-6-luna:medium", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. Cheap ChatGPT-pool starting point for bounded exploration, extraction and grounded summaries. Require file evidence. Use Luna max for harder bounded work or Sol high for substantial implementation; prefer a suitable Grok option when conserving ChatGPT capacity." },
    { id: "openai-codex/gpt-6-luna:max", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. Stronger budget option in the ChatGPT pool for bounded reasoning, debugging and scoped implementation. This max setting retains a useful measured cost/capability tradeoff. Require evidence and tests; move to Sol high when the task exceeds it." },
    { id: "openai-codex/gpt-6-sol:high", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. ChatGPT-pool starting point for substantive implementation, multi-file debugging and interacting constraints. Require regression tests and review. Use Luna for simpler work; consider Sol max for a bounded escalation, or return findings to the parent if capability remains insufficient." },
    { id: "openai-codex/gpt-6-sol:max", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. Upper ChatGPT-pool subagent tier for difficult work where Sol high is insufficient and the extra cost is justified. Not a mandatory retry step. Require tests and evidence; return persistent blockers to the parent rather than repeatedly increasing effort." },
    { id: "xai/grok-4.6:low", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. Economical Grok-pool option for bounded investigation and a cross-provider second opinion, especially when preserving ChatGPT capacity for the parent. Require grounded evidence. Prefer Luna for global value when both pools are healthy; escalate demanding Grok work to 4.6 high." },
    { id: "xai/grok-4.6:high", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. Grok-pool option for substantive implementation, debugging and demanding review when conserving ChatGPT capacity or seeking another provider's perspective. Require tests and file evidence. Prefer low for simpler work; consider Grok 4.7 high only for a justified capability escalation." },
    { id: "xai/grok-4.7:high", description: "Provisional benchmark-informed guidance; Pi task performance is not yet calibrated. Upper Grok-pool subagent tier for difficult work that warrants a premium over Grok 4.6 high, particularly when ChatGPT capacity is constrained. Require tests and independent review. Return persistent blockers to the parent; higher effort is not an automatic improvement." },
  ],
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  extensions: [], skills: [], promptTemplates: [], themes: [],
  systemPrompt: true, appendSystemPrompt: true, contextFiles: true,
  maxChildren: 4, workingDirectories: ["."], peerMessageLimit: 0,
};
const RESOURCES = ["extensions", "skills", "promptTemplates", "themes"] as const;
const KNOWN = new Set(Object.keys(DEFAULT_POLICY));
export function splitModel(value: string) {
  const slash = value.indexOf("/");
  const colon = value.lastIndexOf(":");
  if (slash < 1 || colon <= slash + 1 || !value.slice(colon + 1)) throw new Error(`Expected exact provider/model:thinking, got ${value}`);
  return { provider: value.slice(0, slash), id: value.slice(slash + 1, colon), thinking: value.slice(colon + 1) };
}
function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) throw new Error(`${key} must be an array of non-empty strings`);
  return [...new Set(value)];
}
export function parsePolicy(value: unknown): PolicyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Policy must be an object");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!KNOWN.has(key)) throw new Error(`Unknown policy field: ${key}`);
  if (v.version !== 1 || !Array.isArray(v.models)) throw new Error("version: 1 and models array are required");
  const models = v.models.map(model => {
    if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("Each model must have an id and optional description");
    const m = model as Record<string, unknown>;
    if (Object.keys(m).some(k => !["id", "description"].includes(k)) || typeof m.id !== "string" || (m.description !== undefined && typeof m.description !== "string")) throw new Error("Invalid model entry");
    splitModel(m.id);
    return { id: m.id, description: m.description as string | undefined };
  });
  const flags: Record<string, boolean> = {};
  for (const flag of ["systemPrompt", "appendSystemPrompt", "contextFiles"]) {
    if (v[flag] !== undefined && typeof v[flag] !== "boolean") throw new Error(`${flag} must be boolean`);
    flags[flag] = v[flag] === true;
  }
  const maxChildren = v.maxChildren ?? 4;
  if (typeof maxChildren !== "number" || !Number.isInteger(maxChildren) || maxChildren < 1 || maxChildren > 64) throw new Error("maxChildren must be an integer from 1 to 64");
  const peerMessageLimit = v.peerMessageLimit === undefined ? 0 : v.peerMessageLimit;
  if (typeof peerMessageLimit !== "number" || !Number.isInteger(peerMessageLimit) || peerMessageLimit < 0 || peerMessageLimit > 1000) throw new Error("peerMessageLimit must be an integer from 0 to 1000");
  return {
    version: 1, models, tools: strings(v.tools ?? [], "tools"),
    extensions: strings(v.extensions ?? [], "extensions"), skills: strings(v.skills ?? [], "skills"),
    promptTemplates: strings(v.promptTemplates ?? [], "promptTemplates"), themes: strings(v.themes ?? [], "themes"),
    systemPrompt: flags.systemPrompt, appendSystemPrompt: flags.appendSystemPrompt, contextFiles: flags.contextFiles,
    maxChildren, workingDirectories: strings(v.workingDirectories ?? ["."], "workingDirectories"), peerMessageLimit,
  };
}
export interface PolicyEnvironment {
  cwd: string; agentDir: string; projectTrusted: boolean; guardPath: string;
  models: () => LocalModel[]; tools: () => string[];
}
export class SubagentPolicy {
  readonly source: string;
  readonly config?: PolicyConfig;
  readonly error?: string;
  readonly base: string;
  diagnostics: string[] = [];
  private ignoredProject?: string;
  constructor(readonly environment: PolicyEnvironment) {
    const project = resolve(environment.cwd, ".pi/subagents.json");
    const global = resolve(environment.agentDir, "subagents.json");
    if (existsSync(project) && !environment.projectTrusted) this.ignoredProject = `Ignored untrusted project policy: ${project}`;
    this.source = environment.projectTrusted && existsSync(project) ? project : existsSync(global) ? global : "built-in";
    this.base = this.source === "built-in" ? environment.cwd : dirname(this.source);
    try { this.config = parsePolicy(this.source === "built-in" ? DEFAULT_POLICY : JSON.parse(readFileSync(this.source, "utf8"))); }
    catch (error) { this.error = String(error); }
  }
  private path(value: string, base = this.base) {
    return realpathSync(resolve(base, value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value));
  }
  catalog() {
    this.diagnostics = this.ignoredProject ? [this.ignoredProject] : [];
    if (!this.config) {
      this.diagnostics.push(`${this.source}: ${this.error}`);
      return { source: this.source, spawnEnabled: false, error: "Invalid subagent policy. User can inspect /subagents diagnostics; fix and /reload.", models: [], tools: [] as string[], extensions: [] as string[], skills: [] as string[], promptTemplates: [] as string[], themes: [] as string[], workingDirectories: [] as string[], maxChildren: 0, peerMessageLimit: 0, systemPrompt: false, appendSystemPrompt: false, contextFiles: false };
    }
    const config = this.config;
    const available = this.environment.models();
    const models = config.models.flatMap(entry => {
      const requested = splitModel(entry.id);
      const model = available.find(m => m.provider === requested.provider && m.id === requested.id);
      if (!model || !model.thinkingLevels.includes(requested.thinking)) {
        this.diagnostics.push(`Unavailable model/authentication/thinking level: ${entry.id}`); return [];
      }
      return [{ ...entry, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost }];
    });
    const knownTools = new Set(this.environment.tools());
    const tools = config.tools.filter(tool => {
      if (tool === "peer_send") {
        if (config.peerMessageLimit > 0) return true;
        this.diagnostics.push("peer_send requires a positive peerMessageLimit (ignored)"); return false;
      }
      if (tool.startsWith("subagent_")) { this.diagnostics.push(`Forbidden recursive tool (ignored): ${tool}`); return false; }
      if (!knownTools.has(tool)) { this.diagnostics.push(`Tool not locally known (ignored): ${tool}`); return false; }
      return true;
    });
    const resources = Object.fromEntries(RESOURCES.map(key => [key, config[key].flatMap(value => {
      try {
        const path = this.path(value);
        // Exact files, not packages/globs/directories that can expand permissions.
        if (!statSync(path).isFile()) throw new Error("must be an explicit resource file");
        return [path];
      } catch (error) { this.diagnostics.push(`${key}: ${value}: ${error}`); return []; }
    })])) as Record<typeof RESOURCES[number], string[]>;
    const workingDirectories = config.workingDirectories.flatMap(value => {
      try {
        const path = this.path(value, this.environment.cwd);
        if (!statSync(path).isDirectory()) throw new Error("not a directory");
        return [path];
      } catch (error) { this.diagnostics.push(`workingDirectories: ${value}: ${error}`); return []; }
    });
    return {
      source: this.source, spawnEnabled: !!models.length && !!workingDirectories.length,
      models, tools, ...resources, workingDirectories,
      systemPrompt: config.systemPrompt, appendSystemPrompt: config.appendSystemPrompt,
      contextFiles: config.contextFiles, maxChildren: config.maxChildren, peerMessageLimit: config.peerMessageLimit,
      omittedEntries: this.diagnostics.length,
    };
  }
  private checkedDirectory(cwd: string, roots: string[]) {
    if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
    const directory = this.path(cwd);
    if (!statSync(directory).isDirectory() || !roots.some(root => {
      const rel = relative(root, directory); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    })) throw new Error("cwd is outside allowed workingDirectories");
    return directory;
  }
  directory(cwd: string) { return this.checkedDirectory(cwd, this.catalog().workingDirectories); }
  commandDirectory(cwd: string) {
    if (!this.catalog().tools.includes("bash")) throw new Error("Workflow commands require bash in the subagent tool policy");
    return this.directory(cwd);
  }
  compile(cwd: string, selection: Composition): Omit<SpawnOptions, "name" | "task"> {
    const catalog = this.catalog();
    if (!catalog.spawnEnabled) throw new Error("No spawnable configuration. Inspect subagent_catalog; user diagnostics: /subagents diagnostics.");
    const directory = this.checkedDirectory(cwd, catalog.workingDirectories);
    if (!catalog.models.some(m => m.id === selection.model)) throw new Error("Model/thinking selection is not currently allowed and usable; use subagent_catalog.");
    for (const tool of selection.tools) if (tool.startsWith("subagent_") || !catalog.tools.includes(tool)) throw new Error(`Tool not allowed: ${tool}`);
    const relativeToProject = relative(this.path(this.environment.cwd), directory);
    const withinProject = !isAbsolute(relativeToProject) && relativeToProject !== ".." && !relativeToProject.startsWith(`..${sep}`);
    const cliArgs = ["--no-skills", "--no-prompt-templates", "--no-themes", this.environment.projectTrusted && withinProject ? "--approve" : "--no-approve"];
    for (const key of RESOURCES) {
      const flag = { extensions: "-e", skills: "--skill", promptTemplates: "--prompt-template", themes: "--theme" }[key];
      for (const resource of selection[key] ?? []) {
        if (!catalog[key].includes(resource) || this.path(resource) !== resource) throw new Error(`Resource not allowed or changed: ${key}: ${resource}`);
        cliArgs.push(flag, resource);
      }
    }
    for (const [key, flag] of [["systemPrompt", "--system-prompt"], ["appendSystemPrompt", "--append-system-prompt"]] as const) {
      if (selection[key] !== undefined) {
        if (!catalog[key]) throw new Error(`${key} is not permitted`);
        cliArgs.push(flag, selection[key]!);
      }
    }
    const contextFiles = selection.contextFiles ?? catalog.contextFiles;
    if (contextFiles && !catalog.contextFiles) throw new Error("Context-file loading is not permitted");
    if (!contextFiles) cliArgs.push("--no-context-files");
    cliArgs.push("-e", this.environment.guardPath);
    return { cwd: directory, model: selection.model, tools: selection.tools, inheritExtensions: false, cliArgs, selection: { ...selection, contextFiles } };
  }
}
