import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SpawnOptions } from "./manager.js";
import { allows, parseChildLimit, reportedLimit, type ChildLimit } from "./child-limit.js";
import { BUILTINS, parseChildSettings, parseMcpPolicy, type Builtin, type ChildSettings, type McpPolicy } from "./child-policy.js";
import { parseLoopPolicy, type LoopPolicy } from "./loop.js";
import { isProxiedTool } from "./nesting.js";

export interface Composition {
  model: string; tools: string[];
  extensions?: string[]; skills?: string[]; promptTemplates?: string[]; themes?: string[];
  systemPrompt?: string; appendSystemPrompt?: string; contextFiles?: boolean;
  mcpServers?: string[];
}
export interface PolicyConfig {
  version: 1;
  models: { id: string; description?: string }[];
  tools: string[];
  extensions: string[]; skills: string[]; promptTemplates: string[]; themes: string[];
  /** Subsets of `extensions`/`tools` merged into every composition without a parent selection. */
  alwaysExtensions: string[]; alwaysTools: string[];
  systemPrompt: boolean; appendSystemPrompt: boolean; contextFiles: boolean;
  maxChildren: ChildLimit; workingDirectories: string[];
  peerMessageLimit: number;
  providerExtensions?: Record<string, string>;
  childSettings?: ChildSettings;
  mcp?: McpPolicy;
  /** Parent wake loops; absent means disabled. */
  loops?: LoopPolicy;
  /** How deep the Child tree may grow; absent means 1, Children that cannot delegate. */
  maxDepth?: number;
}
export type PolicyFile = Omit<PolicyConfig, "maxChildren"> & { maxChildren: number };
export interface LocalModel {
  provider: string; id: string; input: readonly string[]; contextWindow: number; maxTokens: number;
  cost: unknown; thinkingLevels: readonly string[]; api?: string; type?: string;
}
// The built-in policy, used only when no subagents.json exists. It is a menu across the
// common providers so that multi-model workflows (pistack's roles, cross-family review)
// work with no setup; entries the user cannot reach are dropped silently. Unlike a user's
// file, where every optional field is off until set, it turns on nesting and loops.
const MENU: { id: string; description: string }[] = [
  { id: "openai-codex/gpt-6-luna:medium", description: "Fast and cheap: lookups, triage, routine edits." },
  { id: "openai-codex/gpt-6-luna:high", description: "Fast, more thorough." },
  { id: "openai-codex/gpt-6.1-sol:medium", description: "Strong general model." },
  { id: "openai-codex/gpt-6.1-sol:high", description: "Strong general model, more thinking." },
  { id: "openai-codex/gpt-6.1-sol:xhigh", description: "Hardest code and judgment." },
  { id: "openai/gpt-6.1-sol:high", description: "Strong general model (API key)." },
  { id: "xai/grok-4.7:high", description: "Code work." },
  { id: "xai/grok-4.7:xhigh", description: "Code work, more thinking." },
  { id: "anthropic/claude-opus-5-5:high", description: "Judgment and prose." },
  { id: "anthropic/claude-opus-5-5:xhigh", description: "Judgment and prose, hardest tasks." },
  { id: "anthropic/claude-sonnet-5-5:high", description: "Cheaper Claude reviewer." },
  { id: "google/gemini-3.1-pro-preview:high", description: "Another family for review panels." },
];
export const DEFAULT_POLICY: PolicyFile = {
  version: 1,
  models: MENU,
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "todo",
    "subagent_catalog", "subagent_spawn", "subagent_wait", "subagent_read", "subagent_close", "subagent_list", "subagent_send"],
  extensions: [], skills: [], promptTemplates: [], themes: [],
  alwaysExtensions: [], alwaysTools: [],
  systemPrompt: true, appendSystemPrompt: true, contextFiles: true,
  maxChildren: 6, workingDirectories: ["."], peerMessageLimit: 0,
  maxDepth: 2,
  loops: { enabled: true, minIntervalMs: 60_000, maxIterations: 50, maxDurationMs: 8 * 60 * 60_000 },
};
/** The claude-subscription provider ships as an extension, so Children get it only by selecting that file. */
export function builtInPolicy(claudeSubscription?: string): PolicyFile {
  if (!claudeSubscription) return DEFAULT_POLICY;
  return {
    ...DEFAULT_POLICY,
    models: [...MENU,
      { id: "claude-subscription/claude-opus-5-5:high", description: "Judgment and prose (Claude subscription)." },
      { id: "claude-subscription/claude-opus-5-5:xhigh", description: "Judgment and prose, hardest tasks (Claude subscription)." },
      { id: "claude-subscription/claude-sonnet-5-5:high", description: "Cheaper Claude reviewer (Claude subscription)." }],
    extensions: [claudeSubscription],
    providerExtensions: { "claude-subscription": claudeSubscription },
  };
}
const RESOURCES = ["extensions", "skills", "promptTemplates", "themes"] as const;
const KNOWN = new Set([...Object.keys(DEFAULT_POLICY), "providerExtensions", "childSettings", "mcp", "loops", "maxDepth"]);
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
  const maxChildren = parseChildLimit(v.maxChildren);
  const peerMessageLimit = v.peerMessageLimit === undefined ? 0 : v.peerMessageLimit;
  if (typeof peerMessageLimit !== "number" || !Number.isInteger(peerMessageLimit) || peerMessageLimit < 0 || peerMessageLimit > 1000) throw new Error("peerMessageLimit must be an integer from 0 to 1000");
  const extensions = strings(v.extensions ?? [], "extensions");
  for (const extension of extensions) if (extension.startsWith("builtin:") && !BUILTINS.includes(extension as Builtin)) throw new Error(`Forbidden or unknown built-in extension: ${extension}`);
  const tools = strings(v.tools ?? [], "tools");
  const alwaysExtensions = strings(v.alwaysExtensions ?? [], "alwaysExtensions");
  for (const extension of alwaysExtensions) if (!extensions.includes(extension)) throw new Error(`alwaysExtensions entry must also be listed in extensions: ${extension}`);
  const alwaysTools = strings(v.alwaysTools ?? [], "alwaysTools");
  for (const tool of alwaysTools) if (!tools.includes(tool)) throw new Error(`alwaysTools entry must also be listed in tools: ${tool}`);
  // Delegation is chosen per Child; a leaf at maxDepth must never receive it.
  for (const tool of alwaysTools) if (isProxiedTool(tool)) throw new Error(`alwaysTools cannot include delegation tools: ${tool}`);
  const maxDepth = v.maxDepth ?? 1;
  if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) throw new Error("maxDepth must be an integer from 1 to 4");
  let providerExtensions: Record<string, string> = {};
  if (v.providerExtensions !== undefined) {
    if (!v.providerExtensions || typeof v.providerExtensions !== "object" || Array.isArray(v.providerExtensions)) throw new Error("providerExtensions must map provider IDs to resource files");
    for (const [provider, file] of Object.entries(v.providerExtensions)) if (!provider.trim() || typeof file !== "string" || !file.trim() || file.startsWith("builtin:")) throw new Error("providerExtensions requires explicit extension files");
    providerExtensions = v.providerExtensions as Record<string, string>;
  }
  return {
    version: 1, models, tools, alwaysTools,
    extensions, alwaysExtensions, skills: strings(v.skills ?? [], "skills"),
    providerExtensions, childSettings: parseChildSettings(v.childSettings), mcp: parseMcpPolicy(v.mcp),
    ...(v.loops === undefined ? {} : { loops: parseLoopPolicy(v.loops) }),
    ...(v.maxDepth === undefined ? {} : { maxDepth }),
    promptTemplates: strings(v.promptTemplates ?? [], "promptTemplates"), themes: strings(v.themes ?? [], "themes"),
    systemPrompt: flags.systemPrompt, appendSystemPrompt: flags.appendSystemPrompt, contextFiles: flags.contextFiles,
    maxChildren, workingDirectories: strings(v.workingDirectories ?? ["."], "workingDirectories"), peerMessageLimit,
  };
}
export interface PolicyEnvironment {
  cwd: string; agentDir: string; projectTrusted: boolean; guardPath: string;
  models: () => LocalModel[]; tools: () => string[];
  toolSources?: () => Record<string, string>;
  /** The policy used when no subagents.json exists; DEFAULT_POLICY if omitted. */
  builtIn?: PolicyFile;
  /** Providers an extension registered in this session. Children start with --no-extensions, so they lack them. */
  extensionProviders?: () => readonly string[];
}
export class SubagentPolicy {
  readonly source: string;
  readonly config?: PolicyConfig;
  readonly error?: string;
  readonly base: string;
  diagnostics: string[] = [];
  private ignoredProject?: string;
  get childLimit(): ChildLimit {
    return this.config?.maxChildren ?? { kind: "off" };
  }
  constructor(readonly environment: PolicyEnvironment) {
    const project = resolve(environment.cwd, ".pi/subagents.json");
    const global = resolve(environment.agentDir, "subagents.json");
    if (existsSync(project) && !environment.projectTrusted) this.ignoredProject = `Ignored untrusted project policy: ${project}`;
    this.source = environment.projectTrusted && existsSync(project) ? project : existsSync(global) ? global : "built-in";
    this.base = this.source === "built-in" ? environment.cwd : dirname(this.source);
    try { this.config = parsePolicy(this.source === "built-in" ? environment.builtIn ?? DEFAULT_POLICY : JSON.parse(readFileSync(this.source, "utf8"))); }
    catch (error) { this.error = String(error); }
  }
  private path(value: string, base = this.base) {
    return realpathSync(resolve(base, value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value));
  }
  catalog() {
    this.diagnostics = this.ignoredProject ? [this.ignoredProject] : [];
    if (!this.config) {
      this.diagnostics.push(`${this.source}: ${this.error}`);
      return { source: this.source, spawnEnabled: false, error: "Invalid subagent policy. User can inspect /subagents diagnostics; fix and /reload.", models: [], tools: [] as string[], extensions: [] as string[], skills: [] as string[], promptTemplates: [] as string[], themes: [] as string[], alwaysExtensions: [] as string[], alwaysTools: [] as string[], workingDirectories: [] as string[], maxChildren: reportedLimit(this.childLimit), peerMessageLimit: 0, systemPrompt: false, appendSystemPrompt: false, contextFiles: false, loops: { enabled: false }, maxDepth: 1 };
    }
    const config = this.config;
    const available = this.environment.models();
    const models = config.models.flatMap(entry => {
      const requested = splitModel(entry.id);
      const model = available.find(m => m.provider === requested.provider && m.id === requested.id);
      if (model?.api === "pi-virtual" || (model?.type && model.type !== "chat")) {
        this.diagnostics.push(`Virtual/non-chat model not permitted: ${entry.id}`); return [];
      }
      const providerFile = config.providerExtensions?.[requested.provider];
      if (providerFile) {
        try {
          const path = this.path(providerFile);
          if (!statSync(path).isFile() || !config.extensions.some(e => {
            try { return !e.startsWith("builtin:") && this.path(e) === path; } catch { return false; }
          })) throw new Error("provider extension is not allowlisted");
        } catch { this.diagnostics.push(`Unavailable provider extension for ${entry.id}`); return []; }
      }
      if (!model || !model.thinkingLevels.includes(requested.thinking)) {
        // The built-in menu lists models most users cannot reach; only a user's own entries are news.
        if (this.source !== "built-in") this.diagnostics.push(`Unavailable model/authentication/thinking level: ${entry.id}`);
        return [];
      }
      // Children start with --no-extensions: a provider an extension registered exists in a
      // Child only if the composition selects that extension.
      const fromExtension = !providerFile && !!this.environment.extensionProviders?.().includes(requested.provider);
      return [{ ...entry, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost,
        ...(fromExtension ? { requiresExtension: "Its provider comes from an extension: select that extension in extensions, or map the provider in providerExtensions." } : {}) }];
    });
    const knownTools = new Set(this.environment.tools());
    if (config.extensions.includes("builtin:codemode")) knownTools.add("codemode");
    if (config.extensions.includes("builtin:tool-search")) knownTools.add("tool_search");
    const tools = config.tools.filter(tool => {
      if (tool === "peer_send") {
        if (config.peerMessageLimit > 0) return true;
        this.diagnostics.push("peer_send requires a positive peerMessageLimit (ignored)"); return false;
      }
      if (tool.startsWith("subagent_")) {
        if (isProxiedTool(tool) && (config.maxDepth ?? 1) > 1) return true;
        this.diagnostics.push(isProxiedTool(tool) ? `Forbidden recursive tool (ignored; delegation needs maxDepth above 1): ${tool}` : `Forbidden recursive tool (ignored): ${tool}`);
        return false;
      }
      if (!knownTools.has(tool)) { this.diagnostics.push(`Tool not locally known (ignored): ${tool}`); return false; }
      return true;
    });
    const resources = Object.fromEntries(RESOURCES.map(key => [key, config[key].flatMap(value => {
      try {
        if (key === "extensions" && BUILTINS.includes(value as Builtin)) return [value];
        const path = this.path(value);
        // Exact files, not packages/globs/directories that can expand permissions.
        if (!statSync(path).isFile()) throw new Error("must be an explicit resource file");
        return [path];
      } catch (error) { this.diagnostics.push(`${key}: ${value}: ${error}`); return []; }
    })])) as Record<typeof RESOURCES[number], string[]>;
    // Missing always-on entries disable spawning rather than silently composing children without them.
    let alwaysUnavailable = false;
    const alwaysExtensions = config.alwaysExtensions.flatMap(value => {
      try {
        const resolved = BUILTINS.includes(value as Builtin) ? value : this.path(value);
        if (resources.extensions.includes(resolved)) return [resolved];
      } catch {}
      this.diagnostics.push(`alwaysExtensions: ${value}: unavailable; spawning disabled`); alwaysUnavailable = true; return [];
    });
    const alwaysTools = config.alwaysTools.filter(tool => {
      if (tools.includes(tool)) return true;
      this.diagnostics.push(`alwaysTools: ${tool}: unavailable; spawning disabled`); alwaysUnavailable = true; return false;
    });
    const workingDirectories = config.workingDirectories.flatMap(value => {
      try {
        const path = this.path(value, this.environment.cwd);
        if (!statSync(path).isDirectory()) throw new Error("not a directory");
        return [path];
      } catch (error) { this.diagnostics.push(`workingDirectories: ${value}: ${error}`); return []; }
    });
    return {
      source: this.source, spawnEnabled: allows(this.childLimit, 1) && !!models.length && !!workingDirectories.length && !alwaysUnavailable,
      models, tools, ...resources, alwaysExtensions, alwaysTools, workingDirectories,
      systemPrompt: config.systemPrompt, appendSystemPrompt: config.appendSystemPrompt,
      contextFiles: config.contextFiles, maxChildren: reportedLimit(this.childLimit), peerMessageLimit: config.peerMessageLimit,
      omittedEntries: this.diagnostics.length,
      providerExtensions: config.providerExtensions, childSettings: config.childSettings,
      mcp: config.mcp,
      loops: config.loops ?? { enabled: false },
      maxDepth: config.maxDepth ?? 1,
      notes: ["Built-ins require explicit extension and tool selections; classifiers and virtual models are denied.",
        config.childSettings?.cacheWarming === "off" ? "Child cache warming suppressed by decision hook." : "Cache warming inherits GLOBAL Pi settings (may cost money); project off is insufficient.",
        "Unspecified codemode mode/budget inherit Pi settings; mcp.autoEnableCodemode never grants tools.",
        "MCP connections require explicit credential inheritance consent; this is not credential isolation."],
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
  /** Check a directory that does not exist yet, through the real path of its nearest existing ancestor. */
  newDirectory(path: string) {
    if (!isAbsolute(path)) throw new Error("cwd must be absolute");
    const missing: string[] = [];
    let existing = path;
    while (!existsSync(existing)) { missing.unshift(basename(existing)); existing = dirname(existing); }
    const real = join(realpathSync(existing), ...missing);
    if (!this.catalog().workingDirectories.some(root => {
      const rel = relative(root, real); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    })) throw new Error("cwd is outside allowed workingDirectories");
    return real;
  }
  commandDirectory(cwd: string) {
    if (!this.catalog().tools.includes("bash")) throw new Error("Workflow commands require bash in the subagent tool policy");
    return this.directory(cwd);
  }
  /** depth: the new Child's depth, 1 for a Child of the root Parent. */
  compile(cwd: string, requested: Composition, depth = 1): Omit<SpawnOptions, "name" | "task"> {
    const catalog = this.catalog();
    if (!catalog.spawnEnabled) throw new Error("No spawnable configuration. Inspect subagent_catalog; user diagnostics: /subagents diagnostics.");
    // Always-on entries become part of the saved composition, so resume revalidates them like explicit choices.
    const union = (always: string[], chosen?: string[]) => always.length ? [...new Set([...(chosen ?? []), ...always])] : chosen;
    const selection: Composition = { ...requested, tools: union(catalog.alwaysTools, requested.tools)!, extensions: union(catalog.alwaysExtensions, requested.extensions) };
    if (selection.extensions === undefined) delete selection.extensions;
    const directory = this.checkedDirectory(cwd, catalog.workingDirectories);
    if (!catalog.models.some(m => m.id === selection.model)) throw new Error("Model/thinking selection is not currently allowed and usable; use subagent_catalog.");
    for (const tool of selection.tools) if (!catalog.tools.includes(tool) || (tool.startsWith("subagent_") && !isProxiedTool(tool))) throw new Error(`Tool not allowed: ${tool}`);
    const maxDepth = this.config!.maxDepth ?? 1;
    if (depth > maxDepth) throw new Error(`No Child may run at depth ${depth}: maxDepth is ${maxDepth}.`);
    if (selection.tools.some(isProxiedTool) && depth >= maxDepth) throw new Error(`A Child at depth ${depth} cannot delegate: maxDepth is ${maxDepth}.`);
    const relativeToProject = relative(this.path(this.environment.cwd), directory);
    const withinProject = !isAbsolute(relativeToProject) && relativeToProject !== ".." && !relativeToProject.startsWith(`..${sep}`);
    const cliArgs = ["--no-skills", "--no-prompt-templates", "--no-themes", this.environment.projectTrusted && withinProject ? "--approve" : "--no-approve"];
    for (const key of RESOURCES) {
      const flag = { extensions: "-e", skills: "--skill", promptTemplates: "--prompt-template", themes: "--theme" }[key];
      for (const resource of selection[key] ?? []) {
        const builtin = key === "extensions" && BUILTINS.includes(resource as Builtin);
        if (!catalog[key].includes(resource) || (!builtin && this.path(resource) !== resource)) throw new Error(`Resource not allowed or changed: ${key}: ${resource}`);
        // Factories are installed by the guard, not ambient unconfigured built-ins.
        if (!builtin) cliArgs.push(flag, resource);
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
    const builtins = (selection.extensions ?? []).filter(e => BUILTINS.includes(e as Builtin)) as Builtin[];
    const toolSources: Record<string, string> = {};
    const parentSources = this.environment.toolSources?.() ?? {};
    for (const tool of selection.tools) {
      const builtin = ({ codemode: "builtin:codemode", tool_search: "builtin:tool-search" } as Record<string, Builtin>)[tool];
      // The mandatory guard registers the proxied delegation tools inside the Child.
      let source = (builtin && builtins.includes(builtin)) || isProxiedTool(tool) ? this.environment.guardPath : parentSources[tool];
      if (source && source !== this.environment.guardPath && !source.startsWith("builtin:")) source = this.path(source);
      if (builtin && this.config!.extensions.includes(builtin) && !builtins.includes(builtin)) throw new Error(`${tool} requires selecting ${builtin}`);
      if (source && source !== this.environment.guardPath) {
        if (source.startsWith("builtin:")) {
          if (!["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"].includes(tool) || source !== `builtin:${tool}`) throw new Error(`Tool ${tool} requires its managed built-in selection`);
        } else if (!(selection.extensions ?? []).includes(source)) throw new Error(`Tool ${tool} requires selecting provider extension ${source}`);
      }
      if (source) toolSources[tool] = source;
    }
    const providerFile = this.config!.providerExtensions?.[splitModel(selection.model).provider];
    if (providerFile && !(selection.extensions ?? []).includes(this.path(providerFile))) throw new Error("Model requires selecting its provider extension");
    if (!providerFile && !(selection.extensions ?? []).some(e => !e.startsWith("builtin:")) && this.environment.extensionProviders?.().includes(splitModel(selection.model).provider)) {
      throw new Error(`${selection.model} comes from a provider an extension registers, and Children start without extensions: select that extension, or ask the user to map the provider in providerExtensions.`);
    }
    const mcpPolicy = this.config!.mcp ?? { servers: [], inheritCredentials: false };
    const servers = [...new Set(selection.mcpServers ?? [])].map(name => {
      const grant = mcpPolicy.servers.find(s => s.name === name);
      if (!grant) throw new Error(`MCP server not allowed: ${name}`);
      return grant;
    });
    if (servers.length && (!builtins.includes("builtin:mcp") || !mcpPolicy.inheritCredentials)) throw new Error("MCP requires builtin:mcp and explicit mcp.inheritCredentials consent");
    if (servers.length && !selection.tools.some(t => t === "codemode" || t === "tool_search")) throw new Error("MCP requires selecting codemode or tool_search");
    cliArgs.push("-e", this.environment.guardPath);
    return { cwd: directory, model: selection.model, tools: selection.tools, inheritExtensions: false, cliArgs, selection: { ...selection, contextFiles },
      childPolicy: { version: 1, builtins, toolSources, model: selection.model, settings: this.config!.childSettings ?? {},
        mcp: { servers, inheritCredentials: mcpPolicy.inheritCredentials }, agentDir: this.environment.agentDir,
        projectTrusted: this.environment.projectTrusted && withinProject } };
  }
}
