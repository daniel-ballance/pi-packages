import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { connect } from './connection.js';
import { loadConfig, resolveConfig, MODERN, type ServerConfig } from './config.js';
import { present } from './content.js';
import {
  headerBindings,
  parameterHeaders,
  type HeaderBinding,
  type ObjectValue,
} from './headers.js';
import { inputHandler } from './input.js';
import { RpcError, type Peer } from './peer.js';
import { HttpError } from './http.js';
import { validator } from './validation.js';
import { renderMcpCall } from './render.js';
import { healthStatus } from './status.js';

export function toolName(server: string, name: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([server, name]))
    .digest('hex')
    .slice(0, 16);
  return `mcp_${`${server}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}_${hash}`;
}
interface ServerState {
  config: ServerConfig;
  peer?: Peer;
  tools: Map<string, ObjectValue>;
  bindings: Map<string, HeaderBinding[]>;
  dirty: boolean;
  refresh?: Promise<void>;
  subscriptions: Map<string, AbortController>;
  error?: string;
  discoveryError?: string;
}

export default function mcpClient(pi: ExtensionAPI) {
  const servers = new Map<string, ServerState>();
  const owned = new Set<string>();
  let shuttingDown = false;
  let currentContext: ExtensionContext;
  let invalidConfig = false;
  function updateStatus() {
    if (!currentContext?.hasUI) return;
    const status = shuttingDown
      ? undefined
      : healthStatus(
          [...servers].map(([name, state]) => ({
            name,
            connected: !!state.peer,
            error: state.error,
            discoveryError: state.discoveryError,
          })),
          invalidConfig,
        );
    currentContext.ui.setStatus(
      'mcp-client',
      status ? currentContext.ui.theme.fg(status.level, status.text) : undefined,
    );
  }
  const notify = (
    ctx: ExtensionContext,
    text: string,
    level: 'info' | 'warning' | 'error' = 'info',
  ) => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
  const get = (name: string) => {
    const state = servers.get(name);
    if (!state?.peer)
      throw new Error(`MCP server ${name} is unavailable. Use /mcp status and /reload.`);
    return state as ServerState & { peer: Peer };
  };
  const requireCapability = (state: ServerState & { peer: Peer }, capability: string) => {
    if (!state.peer.capabilities[capability])
      throw new Error(`Server does not advertise ${capability}`);
  };
  function listen(
    name: string,
    state: ServerState & { peer: Peer },
    key: string,
    notifications: ObjectValue,
  ) {
    state.subscriptions.get(key)?.abort();
    const abort = new AbortController();
    state.subscriptions.set(key, abort);
    // Long-lived stream remains pending until server shutdown; no model turn is triggered.
    void state.peer
      .raw('subscriptions/listen', { notifications }, { signal: abort.signal, timeout: 2147483647 })
      .catch(() => {
        if (!abort.signal.aborted && !shuttingDown) {
          state.error = 'Subscription ended; /reload to reconnect';
          updateStatus();
        }
      })
      .finally(() => {
        if (state.subscriptions.get(key) === abort) state.subscriptions.delete(key);
      });
  }
  async function refresh(name: string, state: ServerState, ctx: ExtensionContext): Promise<void> {
    if (state.refresh) return state.refresh;
    const peer = state.peer;
    if (!peer) return;
    const work = async () => {
      state.dirty = false;
      if (!peer.capabilities.tools) return;
      const tools = await peer.list('tools/list', 'tools');
      if (shuttingDown || state.peer !== peer) return;
      const activeBefore = new Set(pi.getActiveTools());
      const next = new Map<string, ObjectValue>();
      const bindings = new Map<string, HeaderBinding[]>();
      const added: string[] = [];
      for (const tool of tools) {
        try {
          if (
            typeof tool.name !== 'string' ||
            !tool.name ||
            tool.inputSchema?.type !== 'object' ||
            next.has(tool.name)
          )
            throw new Error('Invalid or duplicate tool definition');
          const input = validator(tool.inputSchema);
          const output = tool.outputSchema ? validator(tool.outputSchema) : undefined;
          const mirror =
            state.config.transport === 'http' && peer.version === MODERN
              ? headerBindings(tool.inputSchema)
              : [];
          const id = toolName(name, tool.name);
          if (!owned.has(id) && pi.getAllTools().some((t) => t.name === id))
            throw new Error('Tool name already registered by another extension');
          const isNew = !owned.has(id) || !state.tools.has(tool.name);
          pi.registerTool({
            name: id,
            label: `${name}: ${tool.title ?? tool.name}`,
            description: `[MCP server ${name}] ${tool.description ?? tool.name}\nOutput limited to 2000 lines / 50 KiB; full oversized results saved locally.`,
            parameters: Type.Unsafe<ObjectValue>(tool.inputSchema),
            renderCall: renderMcpCall(name, { ...tool, name: tool.name }),
            async execute(_id, args, signal, onUpdate, toolContext) {
              currentContext = toolContext;
              const current = get(name);
              if (current.peer !== peer || !current.tools.has(tool.name))
                throw new Error('MCP tool no longer available; refresh discovery');
              if (!input(args)) throw new Error('Arguments do not match MCP inputSchema');
              const result = await peer.request(
                'tools/call',
                { name: tool.name, arguments: args },
                {
                  signal,
                  progress: (progress) =>
                    onUpdate?.({
                      content: [
                        {
                          type: 'text',
                          text: `MCP progress: ${String(progress.progress)}${progress.total === undefined ? '' : ` / ${progress.total}`}`,
                        },
                      ],
                      details: { mcpError: false },
                    }),
                },
              );
              if (!Array.isArray(result.content)) throw new Error('Invalid tools/call content');
              if (output && !result.isError && !output(result.structuredContent))
                throw new Error('MCP structuredContent does not match outputSchema');
              return present(result);
            },
          });
          next.set(tool.name, tool);
          bindings.set(tool.name, mirror);
          if (isNew) added.push(id);
          owned.add(id);
        } catch {
          notify(
            ctx,
            `MCP ${name}: excluded invalid tool ${String(tool.name).slice(0, 100)}`,
            'warning',
          );
        }
      }
      const removed = new Set(
        [...state.tools.keys()]
          .filter((tool) => !next.has(tool))
          .map((tool) => toolName(name, tool)),
      );
      state.tools = next;
      state.bindings = bindings;
      pi.setActiveTools([
        ...new Set([...activeBefore].filter((id) => !removed.has(id)).concat(added)),
      ]);
    };
    state.refresh = work()
      .then(() => {
        state.discoveryError = undefined;
      })
      .catch((error) => {
        state.discoveryError = 'Tool discovery failed; /mcp refresh to retry';
        state.dirty = true;
        throw error;
      })
      .finally(() => {
        state.refresh = undefined;
        updateStatus();
      });
    return state.refresh;
  }
  pi.on('session_start', async (_event, ctx) => {
    shuttingDown = false;
    currentContext = ctx;
    invalidConfig = false;
    updateStatus();
    const paths = [join(getAgentDir(), 'mcp.json')];
    if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, CONFIG_DIR_NAME, 'mcp.json'));
    let configs: Record<string, ServerConfig>;
    try {
      configs = await loadConfig(paths);
    } catch {
      invalidConfig = true;
      updateStatus();
      return;
    }
    await Promise.all(
      Object.entries(configs)
        .filter(([, c]) => !c.disabled)
        .map(async ([name, unresolved]) => {
          const state: ServerState = {
            config: unresolved,
            tools: new Map(),
            bindings: new Map(),
            dirty: true,
            subscriptions: new Map(),
          };
          servers.set(name, state);
          try {
            const config = resolveConfig(unresolved, ctx.cwd);
            state.config = config;
            const capabilities = {
              ...(config.roots !== undefined ? { roots: {} } : {}),
              ...(config.elicitation && ctx.hasUI ? { elicitation: { form: {} } } : {}),
              ...(config.sampling && ctx.hasUI ? { sampling: {} } : {}),
            };
            const peer = await connect(
              config,
              capabilities,
              (peer) => {
                peer.oninput = inputHandler(
                  name,
                  config,
                  () => currentContext,
                  (usage, model) => {
                    pi.appendEntry('mcp-sampling-usage', { server: name, model, usage });
                    notify(
                      currentContext,
                      `MCP ${name}: sampled ${usage.totalTokens} tokens, estimated $${usage.cost.total.toFixed(6)}. See /mcp sampling (separate from Pi footer totals).`,
                    );
                  },
                );
                peer.onnotification = (method, params) => {
                  if (method === 'notifications/tools/list_changed') state.dirty = true;
                  if (method === 'notifications/resources/updated')
                    notify(
                      ctx,
                      `MCP ${name}: resource updated ${String(params.uri).slice(0, 200)}`,
                    );
                  if (method === 'notifications/message' && config.logLevel)
                    notify(
                      ctx,
                      `MCP ${name} log: ${String(JSON.stringify(params.data)).slice(0, 1000)}`,
                    );
                  // Logs/instructions are not automatically injected into the model context.
                };
                peer.onclose = () => {
                  if (state.peer !== peer || shuttingDown) return;
                  state.peer = undefined;
                  state.error = 'Connection closed; /reload to reconnect';
                  updateStatus();
                  pi.setActiveTools(
                    pi
                      .getActiveTools()
                      .filter(
                        (id) =>
                          ![...state.tools.keys()].some((tool) => toolName(name, tool) === id),
                      ),
                  );
                };
              },
              (tool, args) => parameterHeaders(state.bindings.get(tool) ?? [], args),
            );
            if (shuttingDown) {
              await peer.close();
              return;
            }
            state.peer = peer;
            await refresh(name, state, ctx);
            if (peer.version === MODERN && peer.capabilities.tools?.listChanged)
              listen(name, get(name), 'lists', { toolsListChanged: true });
          } catch (error) {
            const reason =
              error instanceof RpcError
                ? `RPC error ${error.code}`
                : error instanceof HttpError
                  ? `HTTP ${error.status}`
                  : (error as NodeJS.ErrnoException)?.code === 'ENOENT'
                    ? 'executable not found'
                    : error instanceof Error &&
                        /^Missing environment variable: [A-Za-z_][A-Za-z0-9_]*$/.test(error.message)
                      ? error.message
                      : 'connection or discovery failed';
            await state.peer?.close().catch(() => {});
            state.peer = undefined;
            state.error = `${reason}; check server configuration and /reload`;
          } finally {
            updateStatus();
          }
        }),
    );
  });
  pi.on('model_select', (_event, ctx) => {
    currentContext = ctx;
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    currentContext = ctx;
    for (const [name, state] of servers)
      if (state.dirty && state.peer) {
        try {
          await refresh(name, state, ctx);
        } catch {
          // Persistent status carries discovery failures without repeated notifications.
        }
      }
  });
  pi.on('tool_result', (event) => {
    if (
      owned.has(event.toolName) &&
      (event.details as { mcpError?: boolean } | undefined)?.mcpError
    )
      return { isError: true };
  });
  pi.on('session_shutdown', async () => {
    shuttingDown = true;
    updateStatus();
    await Promise.all(
      [...servers.values()].map(async (state) => {
        for (const abort of state.subscriptions.values()) abort.abort();
        await state.peer?.close().catch(() => {});
      }),
    );
    servers.clear();
  });

  pi.registerTool({
    name: 'mcp_status',
    label: 'MCP Servers',
    renderCall: renderMcpCall('MCP', { name: 'status', title: 'Servers' }),
    description:
      'List configured MCP server names, connection status and advertised capabilities. Use before accessing MCP resources or completions.',
    parameters: Type.Object({}),
    async execute() {
      return present({
        ...(invalidConfig
          ? { error: 'MCP configuration invalid; check mcp.json and /reload' }
          : {}),
        servers: [...servers].map(([name, state]) => ({
          name,
          version: state.peer?.version,
          capabilities: state.peer?.capabilities,
          tools: state.tools.size,
          error: state.error,
          discoveryError: state.discoveryError,
        })),
      });
    },
  });
  pi.registerTool({
    name: 'mcp_resources',
    label: 'MCP Resources',
    renderCall: renderMcpCall('MCP', { name: 'resources', title: 'Resources' }),
    description:
      'List MCP resources/templates or read a resource URI from a configured server. Does not fetch links automatically. Output limited to 2000 lines / 50 KiB.',
    parameters: Type.Object({
      server: Type.String(),
      action: Type.String({ enum: ['list', 'templates', 'read'] }),
      uri: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      currentContext = ctx;
      const state = get(args.server);
      requireCapability(state, 'resources');
      const method = {
        list: 'resources/list',
        templates: 'resources/templates/list',
        read: 'resources/read',
      }[args.action];
      if (!method || (args.action === 'read' && !args.uri))
        throw new Error('Invalid resource action or missing URI');
      return present(
        await state.peer.request(
          method,
          args.action === 'read'
            ? { uri: args.uri }
            : args.cursor === undefined
              ? {}
              : { cursor: args.cursor },
          { signal },
        ),
      );
    },
  });
  pi.registerTool({
    name: 'mcp_complete',
    label: 'MCP Completion',
    renderCall: renderMcpCall('MCP', { name: 'complete', title: 'Argument completion' }),
    description:
      'Complete an MCP prompt argument or resource-template variable. Use the exact prompt name or template URI.',
    parameters: Type.Object({
      server: Type.String(),
      type: Type.String({ enum: ['ref/prompt', 'ref/resource'] }),
      name: Type.String(),
      argument: Type.String(),
      value: Type.String(),
      context: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    async execute(_id, args, signal) {
      const state = get(args.server);
      requireCapability(state, 'completions');
      if (!['ref/prompt', 'ref/resource'].includes(args.type))
        throw new Error('Invalid completion reference');
      return present(
        await state.peer.request(
          'completion/complete',
          {
            ref: { type: args.type, [args.type === 'ref/prompt' ? 'name' : 'uri']: args.name },
            argument: { name: args.argument, value: args.value },
            ...(args.context ? { context: { arguments: args.context } } : {}),
          },
          { signal },
        ),
      );
    },
  });
  pi.registerCommand('mcp', {
    description:
      'MCP: status | refresh | sampling | prompts SERVER | prompt JSON | subscribe JSON | unsubscribe JSON (see package README)',
    handler: async (args, ctx) => {
      currentContext = ctx;
      const [action = 'status', ...rest] = args.trim().split(/\s+/);
      const text = rest.join(' ');
      try {
        if (!action || action === 'status') {
          const status = [...servers].map(([name, s]) => ({
            server: name,
            version: s.peer?.version,
            tools: s.tools.size,
            capabilities: s.peer?.capabilities,
            error: s.error,
            discoveryError: s.discoveryError,
          }));
          const result = await present({
            servers: status,
            ...(invalidConfig
              ? { error: 'MCP configuration invalid; check mcp.json and /reload' }
              : {}),
          });
          pi.sendMessage(
            { customType: 'mcp-status', content: result.content, display: true },
            { deliverAs: 'nextTurn' },
          );
        } else if (action === 'sampling') {
          const entries = ctx.sessionManager
            .getBranch()
            .filter((entry) => entry.type === 'custom' && entry.customType === 'mcp-sampling-usage')
            .map((entry) => (entry as { data: unknown }).data);
          const result = await present({
            samplingUsageOnCurrentBranch: entries,
            note: 'Separate from Pi footer totals; excludes abandoned branches.',
          });
          pi.sendMessage(
            { customType: 'mcp-sampling', content: result.content, display: true },
            { deliverAs: 'nextTurn' },
          );
        } else if (action === 'refresh') {
          await ctx.waitForIdle();
          for (const [name, state] of servers) await refresh(name, state, ctx);
          // Recovery clears the status silently; no success toast.
        } else if (action === 'prompts') {
          const state = get(text);
          requireCapability(state, 'prompts');
          const result = await present({
            prompts: await state.peer.list('prompts/list', 'prompts'),
          });
          pi.sendMessage(
            { customType: 'mcp-prompts', content: result.content, display: true },
            { deliverAs: 'nextTurn' },
          );
        } else if (action === 'prompt') {
          const params = JSON.parse(text);
          if (
            typeof params.server !== 'string' ||
            typeof params.name !== 'string' ||
            (params.arguments !== undefined &&
              (!params.arguments ||
                typeof params.arguments !== 'object' ||
                Array.isArray(params.arguments) ||
                Object.values(params.arguments).some((v) => typeof v !== 'string')))
          )
            throw new Error('Expected server, name and optional string-valued arguments');
          const state = get(params.server);
          requireCapability(state, 'prompts');
          const response = await state.peer.request('prompts/get', {
            name: params.name,
            arguments: params.arguments ?? {},
          });
          // Preserve server roles as data, never impersonate a user or system message.
          const result = await present(response);
          pi.sendMessage(
            { customType: 'mcp-prompt', content: result.content, display: true },
            { deliverAs: 'nextTurn' },
          );
          notify(ctx, 'MCP prompt added as reference context for your next message');
        } else if (action === 'subscribe' || action === 'unsubscribe') {
          const params = JSON.parse(text);
          if (typeof params.server !== 'string' || typeof params.uri !== 'string')
            throw new Error('Expected server and uri');
          const state = get(params.server);
          requireCapability(state, 'resources');
          if (!state.peer.capabilities.resources.subscribe)
            throw new Error('Resource subscriptions unsupported');
          if (state.peer.version === MODERN) {
            if (action === 'subscribe')
              listen(params.server, state, params.uri, { resourceSubscriptions: [params.uri] });
            else {
              state.subscriptions.get(params.uri)?.abort();
              state.subscriptions.delete(params.uri);
            }
          } else await state.peer.request(`resources/${action}`, { uri: params.uri });
          notify(ctx, `MCP resource ${action} requested`);
        } else throw new Error('Unknown /mcp action; see README');
      } catch {
        notify(
          ctx,
          'MCP command failed. Check arguments, server status and advertised capabilities.',
          'error',
        );
      }
    },
  });
}
