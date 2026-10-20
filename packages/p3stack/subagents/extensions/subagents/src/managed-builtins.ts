import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type ExtensionAPI, type LoadedMcpConfig, type McpServerConfig, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { permitsMcpTool, type ChildPolicy } from "./child-policy.js";

/** Adapt policy at Pi's public factory boundaries; Pi owns discovery, transports and execution. */
export function installManagedBuiltins(pi: ExtensionAPI, policy: ChildPolicy, permits: (name: string) => boolean) {
  const mcpTools = new Map<string, boolean>();
  const errors: string[] = [];
  const inventory = () => pi.getAllTools().filter(t => permits(t.name));
  const filtered: ExtensionAPI = {
    ...pi,
    getAllTools: inventory,
    setActiveTools: names => pi.setActiveTools(names.filter(permits)),
    registerTool: definition => {
      const original = definition as ToolDefinition;
      pi.registerTool({ ...original,
        prepareLoadout: original.prepareLoadout ? loadout => original.prepareLoadout!({ ...loadout,
          declared: loadout.declared.filter(t => permits(t.name)), callable: loadout.callable.filter(t => permits(t.name)), registered: loadout.registered.filter(t => permits(t.name)),
        }) : undefined,
        // Tool context capabilities (including executeTool) can be non-enumerable.
        // Preserve the real context rather than copying away its descriptors.
        execute: (id, args, signal, update, ctx) => original.execute(id, args, signal, update, new Proxy(ctx, {
          get: (target, key) => key === "tools" ? target.tools.filter(t => permits(t.name)) : Reflect.get(target, key, target),
        })),
      });
    },
  };
  if (policy.builtins.includes("builtin:codemode")) createCodemodeExtension({ ...policy.settings.codemode, models: false })(filtered);
  if (policy.builtins.includes("builtin:tool-search")) createToolSearchExtension()(filtered);

  if (policy.builtins.includes("builtin:mcp")) {
    // Never let a native /mcp command mutate personal config/auth or enable ungranted servers.
    // Extension registrations are excluded too, including registrations after startup.
    const mcpApi: ExtensionAPI = { ...filtered, getMcpServers: () => [], registerCommand: () => {},
      registerTool: definition => {
        // Pi 0.99.2's native adapter labels tools with their ORIGINAL server/tool names.
        // Use that mapping, not a reversible guess at sanitized/hashed tool identifiers.
        const slash = definition.label.indexOf("/");
        const server = definition.label.slice(0, slash), raw = definition.label.slice(slash + 1);
        const grant = policy.mcp.servers.find(s => s.name === server);
        const allowed = slash > 0 && !!grant && permitsMcpTool(grant, raw) && definition.exposure !== "hidden";
        mcpTools.set(definition.name, allowed);
        pi.registerTool({ ...definition, exposure: allowed ? definition.exposure : "hidden", defaultActive: allowed ? definition.defaultActive : false });
      },
    };
    createMcpExtension({
      loadConfig: ctx => {
        const loaded: LoadedMcpConfig = { servers: [], errors: [], autoEnableCodemode: false };
        if (policy.mcp.servers.length && !policy.mcp.inheritCredentials) {
          errors.push("MCP credential inheritance not authorized"); return loaded;
        }
        const files = new Map<string, Record<string, unknown>>();
        const configAt = (path: string) => {
          if (!files.has(path)) {
            const parsed = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
                (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)))) throw new Error("Invalid MCP config");
            files.set(path, parsed.mcpServers ?? {});
          }
          return files.get(path)!;
        };
        for (const grant of policy.mcp.servers) {
          try {
            let source = join(policy.agentDir, "mcp.json"), scope: "global" | "project" = "global";
            let value = configAt(source)[grant.name];
            if (grant.project && policy.projectTrusted) {
              const project = join(ctx.cwd, ".pi/mcp.json"), candidate = configAt(project)[grant.name];
              if (candidate !== undefined) { value = candidate; source = project; scope = "project"; }
            }
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing MCP server");
            if (scope === "project" && "auth" in value) throw new Error("Project provider auth is forbidden");
            // registerMcpServer is Pi's PUBLIC validation boundary. getMcpServers below
            // retrieves its validated copy; the factory's registry view is still empty.
            pi.registerMcpServer(grant.name, value as McpServerConfig);
            const registered = pi.getMcpServers().find(s => s.name === grant.name);
            if (!registered) throw new Error("Missing validated MCP registration");
            loaded.servers.push({ name: grant.name, config: registered.config, source, scope });
          } catch { errors.push(`MCP server ${grant.name}: unavailable, invalid configuration, or forbidden project auth`); }
        }
        // An invalid selected entry must not partially start other servers.
        if (errors.length) loaded.servers = [];
        loaded.errors = [...errors];
        return loaded;
      },
      updateConfig: () => { throw new Error("Managed MCP configuration is read-only"); },
    })(mcpApi);
  }
  return { mcpTools, errors };
}
