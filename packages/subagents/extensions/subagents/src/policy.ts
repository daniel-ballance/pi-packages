import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SpawnOptions } from "./manager.js";
import { BUILTINS, parseChildSettings, parseMcpPolicy, type Builtin, type ChildSettings, type McpPolicy } from "./child-policy.js";

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
  systemPrompt: boolean; appendSystemPrompt: boolean; contextFiles: boolean;
  maxChildren: number; workingDirectories: string[];
  peerMessageLimit: number;
  providerExtensions?: Record<string, string>;
  childSettings?: ChildSettings;
  mcp?: McpPolicy;
}
export interface LocalModel {
  provider: string; id: string; input: readonly string[]; contextWindow: number; maxTokens: number;
  cost: unknown; thinkingLevels: readonly string[]; api?: string; type?: string;
}
export const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  models: [
    { id: "openai-codex/gpt-6-luna:medium", description: "Default execution model; verify availability in subagent_catalog." },
  ],
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  extensions: [], skills: [], promptTemplates: [], themes: [],
  systemPrompt: true, appendSystemPrompt: true, contextFiles: true,
  maxChildren: 4, workingDirectories: ["."], peerMessageLimit: 0,
};
const RESOURCES = ["extensions", "skills", "promptTemplates", "themes"] as const;
const KNOWN = new Set([...Object.keys(DEFAULT_POLICY), "providerExtensions", "childSettings", "mcp"]);
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
  const extensions = strings(v.extensions ?? [], "extensions");
  for (const extension of extensions) if (extension.startsWith("builtin:") && !BUILTINS.includes(extension as Builtin)) throw new Error(`Forbidden or unknown built-in extension: ${extension}`);
  let providerExtensions: Record<string, string> = {};
  if (v.providerExtensions !== undefined) {
    if (!v.providerExtensions || typeof v.providerExtensions !== "object" || Array.isArray(v.providerExtensions)) throw new Error("providerExtensions must map provider IDs to resource files");
    for (const [provider, file] of Object.entries(v.providerExtensions)) if (!provider.trim() || typeof file !== "string" || !file.trim() || file.startsWith("builtin:")) throw new Error("providerExtensions requires explicit extension files");
    providerExtensions = v.providerExtensions as Record<string, string>;
  }
  return {
    version: 1, models, tools: strings(v.tools ?? [], "tools"),
    extensions, skills: strings(v.skills ?? [], "skills"),
    providerExtensions, childSettings: parseChildSettings(v.childSettings), mcp: parseMcpPolicy(v.mcp),
    promptTemplates: strings(v.promptTemplates ?? [], "promptTemplates"), themes: strings(v.themes ?? [], "themes"),
    systemPrompt: flags.systemPrompt, appendSystemPrompt: flags.appendSystemPrompt, contextFiles: flags.contextFiles,
    maxChildren, workingDirectories: strings(v.workingDirectories ?? ["."], "workingDirectories"), peerMessageLimit,
  };
}
export interface PolicyEnvironment {
  cwd: string; agentDir: string; projectTrusted: boolean; guardPath: string;
  models: () => LocalModel[]; tools: () => string[];
  toolSources?: () => Record<string, string>;
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
        this.diagnostics.push(`Unavailable model/authentication/thinking level: ${entry.id}`); return [];
      }
      return [{ ...entry, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost }];
    });
    const knownTools = new Set(this.environment.tools());
    if (config.extensions.includes("builtin:codemode")) knownTools.add("codemode");
    if (config.extensions.includes("builtin:tool-search")) knownTools.add("tool_search");
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
        if (key === "extensions" && BUILTINS.includes(value as Builtin)) return [value];
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
      providerExtensions: config.providerExtensions, childSettings: config.childSettings,
      mcp: config.mcp,
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
      let source = builtin && builtins.includes(builtin) ? this.environment.guardPath : parentSources[tool];
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
