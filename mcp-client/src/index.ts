import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { connect } from './connection.js';
import { loadConfig, resolveConfig, MODERN, type ServerConfig } from './config.js';
import { present, boundedError } from './content.js';
import {
  headerBindings,
  parameterHeaders,
  type HeaderBinding,
  type ObjectValue,
} from './headers.js';
import { inputHandler, withMcpDialog } from './input.js';
import { McpOAuth } from './oauth.js';
import { RpcError, type Peer } from './peer.js';
import { HttpError } from './http.js';
import { validator } from './validation.js';
import { renderMcpCall } from './render.js';
import { healthStatus } from './status.js';
import { TASKS, TaskSchema, waitForTask, type SavedTask } from './tasks.js';

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
  oauth?: McpOAuth;
  tools: Map<string, ObjectValue>;
  bindings: Map<string, HeaderBinding[]>;
  dirty: boolean;
  refresh?: Promise<void>;
  subscriptions: Map<string, AbortController>;
  desired: Set<string>;
  subscriptionErrors: Map<string, string>;
  error?: string;
  discoveryError?: string;
}

export default function mcpClient(pi: ExtensionAPI) {
  const servers = new Map<string, ServerState>();
  const owned = new Set<string>();
  const tasks = new Map<string, SavedTask>();
  const waitingTasks = new Set<string>();
  const taskKey = (server: string, id: string) => JSON.stringify([server, id]);
  const persistTask = (task: SavedTask) => {
    tasks.set(taskKey(task.server, task.taskId), task);
    pi.appendEntry('mcp-task', { ...task, answered: [...task.answered] });
  };
  let shuttingDown = false;
  let currentContext: ExtensionContext;
  let invalidConfig = false;
  const registerTool: ExtensionAPI['registerTool'] = (definition) => {
    const execute = definition.execute;
    pi.registerTool({
      ...definition,
      async execute(...args) {
        try {
          return await execute(...args);
        } catch (error) {
          throw await boundedError(error);
        }
      },
    });
  };
  pi.registerEntryRenderer('mcp-admin', (entry) => {
    const data = entry.data as { text: string };
    return new Text(data.text, 0, 0);
  });
  const display = (result: Awaited<ReturnType<typeof present>>) =>
    pi.appendEntry('mcp-admin', {
      text: result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      details: result.details,
    });
  const identity = (state: ServerState) =>
    createHash('sha256')
      .update(JSON.stringify([state.config, state.oauth?.identity, currentContext.cwd]))
      .digest('hex');
  const persistSubscriptions = (name: string, state: ServerState) =>
    pi.appendEntry('mcp-subscriptions', {
      server: name,
      identity: identity(state),
      uris: [...state.desired],
    });
  function updateStatus() {
    if (!currentContext?.hasUI) return;
    const status = shuttingDown
      ? undefined
      : healthStatus(
          [...servers].map(([name, state]) => ({
            name,
            connected: !!state.peer,
            error: state.error ?? [...state.subscriptionErrors.values()].join('; '),
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
    const ended = () => {
      if (!abort.signal.aborted && !shuttingDown) {
        state.subscriptionErrors.set(key, 'Subscription ended or refused; /mcp refresh to retry');
        updateStatus();
      }
    };
    // A successful final response also closes the stream; it is not a live subscription.
    void state.peer
      .raw(
        'subscriptions/listen',
        { notifications },
        {
          signal: abort.signal,
          timeout: 2147483647,
          acknowledged: () => {
            state.subscriptionErrors.delete(key);
            updateStatus();
          },
        },
      )
      .then(ended, ended)
      .finally(() => {
        if (state.subscriptions.get(key) === abort) state.subscriptions.delete(key);
      });
  }
  async function restoreSubscriptions(name: string, state: ServerState, ctx: ExtensionContext) {
    const desired = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== 'mcp-subscriptions') continue;
      const data = entry.data as { server?: string; identity?: string; uris?: string[] };
      if (data.server === name && data.identity === identity(state) && Array.isArray(data.uris)) {
        desired.clear();
        for (const uri of data.uris) if (typeof uri === 'string') desired.add(uri);
      }
    }
    const previous = state.desired;
    state.desired = desired;
    const peer = state.peer;
    if (!peer) return;
    for (const uri of previous)
      if (!desired.has(uri)) {
        state.subscriptions.get(uri)?.abort();
        state.subscriptions.delete(uri);
        state.subscriptionErrors.delete(uri);
        if (peer.version !== MODERN) await peer.request('resources/unsubscribe', { uri });
      }
    for (const uri of desired)
      if (!previous.has(uri)) {
        if (!peer.capabilities.resources?.subscribe) {
          state.subscriptionErrors.set(uri, 'Resource subscriptions no longer supported');
          continue;
        }
        if (peer.version === MODERN) listen(name, get(name), uri, { resourceSubscriptions: [uri] });
        else await peer.request('resources/subscribe', { uri });
      }
    updateStatus();
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
            !tool.inputSchema ||
            typeof tool.inputSchema !== 'object' ||
            Array.isArray(tool.inputSchema) ||
            next.has(tool.name)
          )
            throw new Error('Invalid or duplicate tool definition');
          // A fresh catalog does not imply changed schemas. Keep Pi definitions stable.
          if (
            state.tools.has(tool.name) &&
            JSON.stringify(state.tools.get(tool.name)) === JSON.stringify(tool)
          ) {
            next.set(tool.name, tool);
            bindings.set(tool.name, state.bindings.get(tool.name) ?? []);
            continue;
          }
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
          registerTool({
            name: id,
            label: `${name}: ${tool.title ?? tool.name}`,
            description: `[MCP server ${name}] ${tool.description ?? tool.name}\nOutput limited to 2000 lines / 50 KiB; full oversized results saved locally.`,
            // MCP arguments are always an object; preserve refs/composition and validate the original below.
            parameters: Type.Unsafe<ObjectValue>({ ...tool.inputSchema, type: 'object' }),
            renderCall: renderMcpCall(name, { ...tool, name: tool.name }),
            async execute(_id, args, signal, onUpdate, toolContext) {
              currentContext = toolContext;
              const current = get(name);
              if (
                current.peer !== peer ||
                JSON.stringify(current.tools.get(tool.name)) !== JSON.stringify(tool)
              )
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
              if (result.resultType === 'task') {
                persistTask({
                  server: name,
                  identity: identity(current),
                  taskId: result.taskId,
                  tool: tool.name,
                  status: result.status,
                  answered: [],
                  outputSchema: tool.outputSchema,
                });
                return present({
                  ...result,
                  server: name,
                  note: 'Use mcp_tasks to wait, inspect, or cancel this task. Do not repeat the original tool call.',
                });
              }
              if (!Array.isArray(result.content)) throw new Error('Invalid tools/call content');
              if (output && !result.isError && !output(result.structuredContent))
                throw new Error('MCP structuredContent does not match outputSchema');
              return present(result, `${name}/${tool.name}`);
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
        ...new Set(
          [...activeBefore]
            .filter((id) => !removed.has(id))
            .concat(state.config.toolLoading === 'eager' ? added : []),
        ),
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
    tasks.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'mcp-task') {
        const task = entry.data as SavedTask;
        if (
          typeof task?.server === 'string' &&
          typeof task?.taskId === 'string' &&
          Array.isArray(task.answered)
        )
          tasks.set(taskKey(task.server, task.taskId), task);
      }
    }
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
            desired: new Set(),
            subscriptionErrors: new Map(),
          };
          servers.set(name, state);
          try {
            const config = resolveConfig(unresolved, ctx.cwd);
            state.config = config;
            if (config.transport !== 'stdio' && config.oauth)
              state.oauth = await new McpOAuth(
                config.url,
                config.oauth,
                join(getAgentDir(), 'mcp-auth'),
              ).load();
            const capabilities = {
              ...(config.roots !== undefined ? { roots: {} } : {}),
              ...((config.elicitation || config.elicitationUrl) && ctx.hasUI
                ? {
                    elicitation: {
                      ...(config.elicitation ? { form: {} } : {}),
                      ...(config.elicitationUrl ? { url: {} } : {}),
                    },
                  }
                : {}),
              ...(config.sampling && ctx.hasUI
                ? { sampling: config.samplingTools ? { tools: {} } : {} }
                : {}),
              ...(config.tasks ? { extensions: { [TASKS]: {} } } : {}),
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
                  async (url) => {
                    const command =
                      process.platform === 'darwin'
                        ? 'open'
                        : process.platform === 'win32'
                          ? 'rundll32'
                          : 'xdg-open';
                    const result = await pi.exec(
                      command,
                      process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
                      { timeout: config.timeout },
                    );
                    if (result.code !== 0) throw new Error('Could not open browser');
                  },
                );
                peer.onrecovering = () => {
                  state.dirty = true;
                };
                peer.onrecovered = async () => {
                  state.dirty = true;
                  if (peer.capabilities.resources?.subscribe)
                    for (const uri of state.desired) await peer.raw('resources/subscribe', { uri });
                };
                peer.onnotification = (method, params) => {
                  if (method === 'notifications/tools/list_changed') state.dirty = true;
                  if (
                    method === 'notifications/prompts/list_changed' ||
                    method === 'notifications/resources/list_changed'
                  ) {
                    peer.catalogExpiry.clear();
                    notify(
                      currentContext,
                      `MCP ${name}: ${method.includes('prompts') ? 'prompt' : 'resource'} catalog changed`,
                    );
                  }
                  if (method === 'notifications/elicitation/complete')
                    notify(currentContext, `MCP ${name}: URL elicitation completed`);
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
              state.oauth,
            );
            if (shuttingDown) {
              await peer.close();
              return;
            }
            state.peer = peer;
            await refresh(name, state, ctx);
            const lists = {
              ...(peer.capabilities.tools?.listChanged ? { toolsListChanged: true } : {}),
              ...(peer.capabilities.prompts?.listChanged ? { promptsListChanged: true } : {}),
              ...(peer.capabilities.resources?.listChanged ? { resourcesListChanged: true } : {}),
            };
            if (peer.version === MODERN && Object.keys(lists).length)
              listen(name, get(name), 'lists', lists);
            await restoreSubscriptions(name, state, ctx);
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
  pi.on('session_tree', async (_event, ctx) => {
    currentContext = ctx;
    tasks.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'mcp-task') {
        const task = entry.data as SavedTask;
        if (
          typeof task?.server === 'string' &&
          typeof task?.taskId === 'string' &&
          Array.isArray(task.answered)
        )
          tasks.set(taskKey(task.server, task.taskId), task);
      }
    }
    for (const [name, state] of servers) {
      try {
        await restoreSubscriptions(name, state, ctx);
      } catch {
        state.error = 'Could not restore branch subscriptions; /reload to retry';
      }
    }
    updateStatus();
  });
  pi.on('model_select', (_event, ctx) => {
    currentContext = ctx;
  });
  const refreshStale = async (ctx: ExtensionContext) => {
    currentContext = ctx;
    for (const [name, state] of servers)
      if (
        state.peer &&
        (state.dirty || (state.peer.catalogExpiry.get('tools/list') ?? Infinity) <= Date.now())
      ) {
        try {
          await refresh(name, state, ctx);
        } catch {
          // Persistent status carries discovery failures without repeated notifications.
        }
      }
  };
  pi.on('before_agent_start', async (_event, ctx) => refreshStale(ctx));
  pi.on('turn_start', async (_event, ctx) => refreshStale(ctx));
  pi.on('tool_result', (event) => {
    if (
      (owned.has(event.toolName) || event.toolName === 'mcp_tasks') &&
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

  registerTool({
    name: 'mcp_tasks',
    label: 'MCP Tasks',
    description:
      'List locally recorded MCP task handles, inspect, wait for, or cancel a 2026 task. Waiting uses native approval for input and respects polling intervals. Aborting a wait does not cancel server work; use cancel explicitly. Never repeat the original tool call to resume a task.',
    parameters: Type.Object({
      action: Type.String({ enum: ['list', 'get', 'wait', 'cancel'] }),
      server: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal, onUpdate, ctx) {
      currentContext = ctx;
      if (args.action === 'list')
        return present({
          tasks: [...tasks.values()]
            .filter(
              (task) =>
                (!args.server || args.server === task.server) &&
                servers.has(task.server) &&
                task.identity === identity(servers.get(task.server)!),
            )
            .map(({ server, taskId, tool, status }) => ({ server, taskId, tool, status })),
        });
      if (!args.server || !args.taskId) throw new Error('Expected server and taskId');
      const state = get(args.server);
      if (
        !state.config.tasks ||
        state.peer.version !== MODERN ||
        !state.peer.capabilities.extensions?.[TASKS]
      )
        throw new Error('2026 task extension not enabled by both peers');
      const task = tasks.get(taskKey(args.server, args.taskId));
      if (!task || task.identity !== identity(state))
        throw new Error('Task is not recorded for this server identity');
      if (args.action === 'get') {
        const result = TaskSchema.parse(
          await state.peer.request('tasks/get', { taskId: task.taskId }, { signal }),
        );
        if (result.taskId !== task.taskId) throw new Error('Mismatched task ID');
        task.status = result.status;
        persistTask(task);
        return present(result);
      }
      if (args.action === 'cancel')
        return present(
          await state.peer.request('tasks/cancel', { taskId: task.taskId }, { signal }),
        );
      if (args.action !== 'wait') throw new Error('Invalid task action');
      const key = taskKey(args.server, args.taskId);
      if (waitingTasks.has(key)) throw new Error('Already waiting on this MCP task');
      waitingTasks.add(key);
      let result: ObjectValue;
      try {
        result = await waitForTask(
          state.peer,
          task,
          AbortSignal.any([AbortSignal.timeout(state.config.timeout), ...(signal ? [signal] : [])]),
          () => persistTask(task),
          (status) =>
            onUpdate?.({ content: [{ type: 'text', text: `MCP task: ${status}` }], details: {} }),
        );
      } finally {
        waitingTasks.delete(key);
      }
      const schema = task.outputSchema;
      if (
        !Array.isArray(result.content) ||
        (schema && !result.isError && !validator(schema)(result.structuredContent))
      )
        throw new Error('Invalid task tool result');
      return present(result, `${args.server}/${task.tool}`);
    },
  });
  registerTool({
    name: 'mcp_search_tools',
    label: 'Find MCP Tools',
    description:
      'Search configured MCP tool catalogs and activate matching tools using Pi native deferred loading. Returns names and descriptions, not full schemas.',
    parameters: Type.Object({
      query: Type.String(),
      server: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      await refreshStale(ctx);
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [...servers]
        .filter(([name, state]) => state.peer && (!args.server || args.server === name))
        .flatMap(([server, state]) =>
          [...state.tools.values()].map((tool) => ({
            name: toolName(server, tool.name),
            server,
            originalName: tool.name,
            description: tool.description ?? tool.name,
            title: tool.title,
            annotations: tool.annotations,
            icons: tool.icons,
            score: terms.reduce(
              (n, term) =>
                n +
                Number(
                  `${server} ${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(term),
                ),
              0,
            ),
          })),
        )
        .filter((m) => !terms.length || m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, args.limit ?? 5);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...matches.map((m) => m.name)])]);
      return present({ tools: matches });
    },
  });
  registerTool({
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
          serverInfo: state.peer?.serverInfo,
          instructions: state.peer?.instructions,
          subscriptions: [...state.desired],
          subscriptionErrors: [...state.subscriptionErrors.values()],
          tools: state.tools.size,
          error: state.error,
          discoveryError: state.discoveryError,
        })),
      });
    },
  });
  registerTool({
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
  registerTool({
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
      if (state.peer.version !== '2024-11-05') requireCapability(state, 'completions');
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
      'MCP: status | refresh | sampling | login SERVER | logout SERVER | prompts SERVER | prompt JSON | subscribe JSON | unsubscribe JSON (see README)',
    handler: async (args, ctx) => {
      currentContext = ctx;
      const [, action = 'status', text = ''] = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
      try {
        if (!action || action === 'status') {
          const status = [...servers].map(([name, s]) => ({
            server: name,
            version: s.peer?.version,
            tools: s.tools.size,
            capabilities: s.peer?.capabilities,
            serverInfo: s.peer?.serverInfo,
            instructions: s.peer?.instructions,
            subscriptions: [...s.desired],
            subscriptionErrors: [...s.subscriptionErrors.values()],
            error: s.error,
            discoveryError: s.discoveryError,
          }));
          const result = await present({
            servers: status,
            ...(invalidConfig
              ? { error: 'MCP configuration invalid; check mcp.json and /reload' }
              : {}),
          });
          display(result);
        } else if (action === 'login' || action === 'logout') {
          const state = servers.get(text);
          if (!state?.oauth) throw new Error('Configure oauth for this HTTP server first');
          await ctx.waitForIdle();
          if (action === 'logout') {
            await state.peer?.close().catch(() => {});
            await state.oauth.logout();
          } else {
            if (!ctx.hasUI) throw new Error('OAuth login requires interactive approval');
            await withMcpDialog(() =>
              state.oauth!.login(async (url) => {
                if (
                  !(await ctx.ui.confirm(
                    `MCP ${text}: authorize this server?`,
                    `Open this authorization URL in your browser, then return to Pi:\n${url.href}`,
                    { timeout: state.config.timeout },
                  ))
                )
                  throw new Error('OAuth declined');
                const command =
                  process.platform === 'darwin'
                    ? 'open'
                    : process.platform === 'win32'
                      ? 'rundll32'
                      : 'xdg-open';
                const result = await pi.exec(
                  command,
                  process.platform === 'win32'
                    ? ['url.dll,FileProtocolHandler', url.href]
                    : [url.href],
                  { timeout: state.config.timeout },
                );
                if (result.code !== 0) throw new Error('Could not open browser');
              }, state.config.timeout),
            );
          }
          await ctx.reload();
          return;
        } else if (action === 'sampling') {
          const entries = ctx.sessionManager
            .getBranch()
            .filter((entry) => entry.type === 'custom' && entry.customType === 'mcp-sampling-usage')
            .map((entry) => (entry as { data: unknown }).data);
          const result = await present({
            samplingUsageOnCurrentBranch: entries,
            note: 'Separate from Pi footer totals; excludes abandoned branches.',
          });
          display(result);
        } else if (action === 'refresh') {
          await ctx.waitForIdle();
          for (const [name, state] of servers) {
            await refresh(name, state, ctx);
            if (!state.peer || state.peer.version !== MODERN) continue;
            for (const key of state.subscriptionErrors.keys()) {
              if (key === 'lists')
                listen(name, get(name), key, {
                  ...(state.peer.capabilities.tools?.listChanged ? { toolsListChanged: true } : {}),
                  ...(state.peer.capabilities.prompts?.listChanged
                    ? { promptsListChanged: true }
                    : {}),
                  ...(state.peer.capabilities.resources?.listChanged
                    ? { resourcesListChanged: true }
                    : {}),
                });
              else if (state.desired.has(key))
                listen(name, get(name), key, { resourceSubscriptions: [key] });
            }
          }
          // Recovery clears the status silently; no success toast.
        } else if (action === 'prompts') {
          const state = get(text);
          requireCapability(state, 'prompts');
          const result = await present({
            prompts: await state.peer.list('prompts/list', 'prompts'),
          });
          display(result);
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
          if (action === 'subscribe') state.desired.add(params.uri);
          else {
            state.desired.delete(params.uri);
            state.subscriptionErrors.delete(params.uri);
          }
          persistSubscriptions(params.server, state);
          updateStatus();
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
