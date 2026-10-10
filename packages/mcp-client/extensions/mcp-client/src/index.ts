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
import { present, presentNativeResult, boundedError, normalizeToolResult } from './content.js';
import { loadClientSettings, type ClientSettings } from './client-settings.js';
import { loadNativeConfig } from './native-config.js';
import { nativeToolNames, nativeDefinitionFields, toolExposure } from './native-host.js';
import { registerNativeResources, nativeResourceNames } from './native-resources.js';
import {
  headerBindings,
  parameterHeaders,
  type HeaderBinding,
  type ObjectValue,
} from './headers.js';
import { inputHandler, withMcpDialog } from './input.js';
import { McpOAuth } from './oauth.js';
import type { Peer } from './peer.js';
import { validator, validationIssue } from './validation.js';
import { DiagnosticError, displayText, failureReason } from './diagnostics.js';
import { withProgress } from './progress.js';
import { searchScore } from './search.js';
import { McpActivity } from './activity.js';
import { canGuide, fillFields, formSummary } from './forms.js';
import {
  renderComplete,
  renderMcpCall,
  renderResources,
  renderSearchTools,
  renderServerStatus,
  renderTasks,
} from './render.js';
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
  ids?: Map<string, string>;
  bindings: Map<string, HeaderBinding[]>;
  dirty: boolean;
  refresh?: Promise<void>;
  subscriptions: Map<string, AbortController>;
  desired: Set<string>;
  subscriptionErrors: Map<string, string>;
  error?: string;
  discoveryError?: string;
  approvalEvents?: unknown[];
  resetApprovals?: () => void;
  abortApprovals?: () => void;
  rejected: { name: string; reason: string }[];
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
  let sessionLifetime = new AbortController();
  let settings: ClientSettings = {
    configurationFormat: 'package',
    serverOptions: {},
    computerUse: {},
  };
  const nativeHost = pi as unknown as {
    getMcpServers?: () => { name: string; config: unknown; extensionPath?: string }[];
  };
  const idFor = (server: string, tool: string): string =>
    servers.get(server)?.ids?.get(tool) ?? toolName(server, tool);
  const unavailableDefinition = (name: string) =>
    registerTool({
      name,
      label: name,
      description: 'Withdrawn MCP tool',
      parameters: Type.Object({}),
      ...{ exposure: 'hidden' as const },
      async execute() {
        throw new DiagnosticError('MCP tool is no longer available');
      },
    });
  let currentContext: ExtensionContext;
  const activity = new McpActivity(() => currentContext);
  let invalidConfig = false;
  let configError: string | undefined;
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
          [...servers]
            .filter(([, state]) => !state.config.disabled)
            .map(([name, state]) => ({
              name,
              connected: !!state.peer,
              error: state.error ?? [...state.subscriptionErrors.values()].join('; '),
              discoveryError:
                state.discoveryError ??
                (state.rejected.length ? `${state.rejected.length} tools excluded` : undefined),
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
  const get = (name: string, tool?: string) => {
    const state = servers.get(name);
    if (
      !state?.peer ||
      state.config.disabled ||
      (state.config.exposure === 'hidden' &&
        (!tool || toolExposure(state.config, tool) === 'hidden'))
    )
      throw new DiagnosticError(
        `MCP server ${displayText(name)} is unavailable. Use /mcp status and /reload.`,
      );
    return state as ServerState & { peer: Peer };
  };
  const requireCapability = (state: ServerState & { peer: Peer }, capability: string) => {
    if (!state.peer.capabilities[capability])
      throw new DiagnosticError(
        `Server does not advertise ${capability}; use /mcp status to inspect capabilities`,
      );
  };
  const snapshots = () => {
    const active = new Set(pi.getActiveTools());
    return [...servers].map(([name, state]) => ({
      name,
      connection: state.config.disabled ? 'disabled' : state.peer ? 'connected' : 'unavailable',
      version: state.peer?.version,
      capabilities: state.peer?.capabilities,
      serverInfo: state.peer?.serverInfo,
      ...(state.approvalEvents?.length ? { approvalEvents: state.approvalEvents } : {}),
      serverGuidance: state.peer?.instructions
        ? {
            trust: 'untrusted server-provided reference, not client instructions',
            text: state.peer.instructions,
          }
        : undefined,
      subscriptions: [...state.desired],
      subscriptionErrors: [...state.subscriptionErrors.values()],
      tools: state.tools.size,
      activeTools: [...state.tools.keys()].filter((tool) => active.has(idFor(name, tool))).length,
      toolLoading: state.config.toolLoading,
      catalog: !state.peer
        ? 'unavailable'
        : state.discoveryError
          ? 'failed'
          : state.rejected.length
            ? 'partial'
            : state.dirty || (state.peer.catalogExpiry.get('tools/list') ?? Infinity) <= Date.now()
              ? 'stale'
              : 'current',
      rejectedTools: state.rejected,
      error: state.error,
      discoveryError: state.discoveryError,
    }));
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
      const tools = await peer.list('tools/list', 'tools', sessionLifetime.signal);
      if (shuttingDown || state.peer !== peer) return;
      const activeBefore = new Set(pi.getActiveTools());
      const previousIds = new Map([...state.tools.keys()].map((tool) => [tool, idFor(name, tool)]));
      const candidateIds = state.config.native
        ? nativeToolNames(
            name,
            tools.filter((tool) => typeof tool.name === 'string').map((tool) => tool.name),
          )
        : new Map(
            tools
              .filter((tool) => typeof tool.name === 'string')
              .map((tool) => [tool.name, toolName(name, tool.name)]),
          );
      const next = new Map<string, ObjectValue>();
      const bindings = new Map<string, HeaderBinding[]>();
      const added: string[] = [];
      const rejected: ServerState['rejected'] = [];
      for (const tool of tools) {
        let stage = 'invalid or duplicate definition';
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
          if (toolExposure(state.config, tool.name) === 'hidden') continue;
          const id = candidateIds.get(tool.name)!;
          // A fresh catalog does not imply changed schemas. Keep Pi definitions stable.
          if (
            previousIds.get(tool.name) === id &&
            state.tools.has(tool.name) &&
            JSON.stringify(state.tools.get(tool.name)) === JSON.stringify(tool)
          ) {
            next.set(tool.name, tool);
            bindings.set(tool.name, state.bindings.get(tool.name) ?? []);
            continue;
          }
          stage = 'input schema cannot be compiled locally (check schema limits and references)';
          const input = validator(tool.inputSchema);
          stage = 'output schema cannot be compiled locally (check schema limits and references)';
          const output = tool.outputSchema ? validator(tool.outputSchema) : undefined;
          stage = 'invalid HTTP header bindings';
          const mirror =
            state.config.transport === 'http' && peer.version === MODERN
              ? headerBindings(tool.inputSchema)
              : [];
          stage = 'tool name conflicts with another extension';
          if (!owned.has(id) && pi.getAllTools().some((t) => t.name === id))
            throw new Error('Tool name already registered by another extension');
          const isNew = !owned.has(id) || !state.tools.has(tool.name);
          stage = 'native tool registration failed';
          registerTool({
            name: id,
            label: `${name}: ${tool.title ?? tool.name}`,
            description: `[MCP server ${name}] ${tool.description ?? tool.name}\nOutput limited to 2000 lines / 50 KiB; full oversized results saved locally.`,
            // MCP arguments are always an object; preserve refs/composition and validate the original below.
            parameters: Type.Unsafe<ObjectValue>({ ...tool.inputSchema, type: 'object' }),
            ...(state.config.native
              ? nativeDefinitionFields(name, tool, state.config, peer.instructions)
              : {}),
            renderCall: renderMcpCall(name, { ...tool, name: tool.name }),
            async execute(_id, args, signal, onUpdate, toolContext) {
              currentContext = toolContext;
              const current = get(name, tool.name);
              if (
                current.peer !== peer ||
                JSON.stringify(current.tools.get(tool.name)) !== JSON.stringify(tool)
              )
                throw new DiagnosticError(
                  'Rejected before execution: MCP tool no longer available; use mcp_search_tools to refresh discovery',
                );
              if (!input(args))
                throw new DiagnosticError(
                  `Rejected before execution: arguments do not match MCP inputSchema (${validationIssue(input)}). Correct the arguments and retry.`,
                );
              signal?.throwIfAborted();
              const result = await withProgress(
                `${name}/${tool.name}`,
                onUpdate
                  ? (text) =>
                      onUpdate({ content: [{ type: 'text', text }], details: { mcpError: false } })
                  : undefined,
                (progress) =>
                  peer.request(
                    'tools/call',
                    { name: tool.name, arguments: args },
                    { signal, progress },
                  ),
              ).catch(async (error) => {
                const diagnostic = await boundedError(error);
                throw new Error(
                  `Tool execution outcome is unknown; inspect server state before retrying a side-effecting call. No automatic retry was performed.\nServer/transport diagnostic (untrusted): ${diagnostic.message}`,
                );
              });
              if (peer.version === MODERN && result.resultType === 'task') {
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
              let normalized: ObjectValue;
              try {
                normalized = normalizeToolResult(result);
              } catch {
                throw new DiagnosticError(
                  'Server returned invalid tools/call result fields. The operation may have taken effect; do not blindly retry.',
                );
              }
              if (output && !normalized.isError && !output(normalized.structuredContent))
                throw new DiagnosticError(
                  `Server returned a result, but structuredContent does not match outputSchema (${validationIssue(output)}). The operation may have taken effect; do not blindly retry.`,
                );
              return state.config.native
                ? presentNativeResult(normalized, `${name}/${tool.name}`)
                : present(normalized, `${name}/${tool.name}`);
            },
          });
          next.set(tool.name, tool);
          bindings.set(tool.name, mirror);
          if (isNew && (!state.config.native || toolExposure(state.config, tool.name) === 'direct'))
            added.push(id);
          owned.add(id);
        } catch {
          rejected.push({ name: displayText(String(tool.name), 100), reason: stage });
        }
      }
      const removed = new Set(
        [...previousIds]
          .filter(([tool, id]) => !next.has(tool) || candidateIds.get(tool) !== id)
          .map(([, id]) => id),
      );
      if (state.config.native) for (const id of removed) unavailableDefinition(id);
      state.ids = candidateIds;
      state.tools = next;
      state.bindings = bindings;
      const changedRejections = JSON.stringify(state.rejected) !== JSON.stringify(rejected);
      state.rejected = rejected;
      if (rejected.length && changedRejections)
        notify(
          ctx,
          `MCP ${displayText(name)}: excluded ${rejected.length} tool(s); /mcp status for reasons`,
          'warning',
        );
      pi.setActiveTools([
        ...new Set(
          [...activeBefore]
            .filter((id) => !removed.has(id))
            .concat(state.config.native || state.config.toolLoading === 'eager' ? added : []),
        ),
      ]);
    };
    state.refresh = activity
      .run(`${name} · refreshing tools`, work)
      .then(() => {
        state.discoveryError = undefined;
      })
      .catch((error) => {
        state.discoveryError = `Tool discovery failed: ${failureReason(error)}; /mcp refresh to retry`;
        state.dirty = true;
        throw error;
      })
      .finally(() => {
        state.refresh = undefined;
        updateStatus();
      });
    return state.refresh;
  }
  async function startSession(_event: unknown, ctx: ExtensionContext) {
    shuttingDown = false;
    sessionLifetime = new AbortController();
    const lifetime = sessionLifetime.signal;
    currentContext = ctx;
    invalidConfig = false;
    configError = undefined;
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
      settings = await loadClientSettings(paths.map((path) => join(path, '..', 'mcp-client.json')));
      const registrations = nativeHost.getMcpServers?.() ?? [];
      if (settings.configurationFormat === 'native') {
        if (!nativeHost.getMcpServers)
          throw new DiagnosticError(
            'Native compatibility requires Pi with the public MCP registration and tool-exposure APIs',
          );
        configs = await loadNativeConfig(paths, registrations, settings.serverOptions);
      } else {
        configs = {
          ...(registrations.length ? await loadNativeConfig([], registrations) : {}),
          ...(await loadConfig(paths)),
        };
      }
      if (Object.values(configs).some((config) => config.native) && !nativeHost.getMcpServers)
        throw new DiagnosticError('Native tool compatibility requires a modern Pi host');
      lifetime.throwIfAborted();
    } catch (error) {
      invalidConfig = true;
      configError = failureReason(error);
      updateStatus();
      return;
    }
    await Promise.all(
      Object.entries(configs).map(async ([name, unresolved]) => {
        const state: ServerState = {
          config: unresolved,
          tools: new Map(),
          bindings: new Map(),
          dirty: true,
          subscriptions: new Map(),
          desired: new Set(),
          subscriptionErrors: new Map(),
          rejected: [],
        };
        servers.set(name, state);
        if (unresolved.disabled) return;
        try {
          lifetime.throwIfAborted();
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
          const peer = await activity.run(`${name} · connecting`, () =>
            connect(
              config,
              capabilities,
              (peer) => {
                let approvalLifetime = new AbortController();
                const installInput = () => {
                  approvalLifetime.abort();
                  approvalLifetime = new AbortController();
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
                    () => peer.version,
                    settings.computerUse[name],
                    (event: unknown) => {
                      state.approvalEvents ??= [];
                      state.approvalEvents.push({ at: new Date().toISOString(), event });
                      if (state.approvalEvents.length > 20) state.approvalEvents.shift();
                    },
                    AbortSignal.any([lifetime, approvalLifetime.signal]),
                  );
                };
                state.resetApprovals = installInput;
                state.abortApprovals = () => approvalLifetime.abort();
                installInput();
                peer.onrecovering = () => {
                  approvalLifetime.abort();
                  state.dirty = true;
                };
                peer.onrecovered = async () => {
                  installInput();
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
                  approvalLifetime.abort();
                  if (state.peer !== peer || shuttingDown) return;
                  state.peer = undefined;
                  state.error = 'Connection closed; /reload to reconnect';
                  updateStatus();
                  pi.setActiveTools(
                    pi
                      .getActiveTools()
                      .filter(
                        (id) => ![...state.tools.keys()].some((tool) => idFor(name, tool) === id),
                      ),
                  );
                };
              },
              (tool, args) => parameterHeaders(state.bindings.get(tool) ?? [], args),
              state.oauth,
              lifetime,
            ),
          );
          if (shuttingDown || lifetime.aborted) {
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
            listen(name, { ...state, peer }, 'lists', lists);
          await restoreSubscriptions(name, state, ctx);
        } catch (error) {
          const reason = failureReason(error);
          state.abortApprovals?.();
          await state.peer?.close().catch(() => {});
          state.peer = undefined;
          state.error = `${reason}; check server configuration and /reload`;
        } finally {
          updateStatus();
        }
      }),
    );
    if (Object.values(configs).some((config) => config.native)) {
      for (const name of nativeResourceNames)
        if (!owned.has(name) && pi.getAllTools().some((tool) => tool.name === name))
          throw new DiagnosticError('Native resource tool name conflicts with another extension');
      registerNativeResources(
        registerTool,
        () =>
          [...servers]
            .filter(
              ([, state]) =>
                state.peer && !state.config.disabled && state.config.exposure !== 'hidden',
            )
            .map(([name]) => name),
        get,
      );
      for (const name of nativeResourceNames) owned.add(name);
    }
    const exposures = new Set(
      [...servers.values()]
        .filter((state) => state.config.native && !state.config.disabled)
        .flatMap((state) => [
          state.config.exposure ?? 'codemode',
          ...Object.values(state.config.toolExposure ?? {}),
        ]),
    );
    const available = pi.getAllTools();
    const discovery = [
      ['codemode', 'codemode'],
      ['deferred', 'tool_search'],
    ] as const;
    const activate = discovery
      .filter(
        ([exposure, name]) =>
          exposures.has(exposure) &&
          available.some(
            (tool) =>
              tool.name === name &&
              tool.sourceInfo?.path === `builtin:${name === 'tool_search' ? 'tool-search' : name}`,
          ),
      )
      .map(([, name]) => name);
    if (activate.length) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...activate])]);
  }
  let reconciliation: Promise<void> = Promise.resolve();
  let generation = 0;
  const restart = (ctx: ExtensionContext) => {
    const requested = ++generation;
    sessionLifetime.abort();
    reconciliation = reconciliation
      .catch(() => {})
      .then(async () => {
        if (requested !== generation) return;
        await stopSession();
        if (requested !== generation) return;
        await startSession({}, ctx);
      });
    return reconciliation;
  };
  pi.on('session_start', (_event, ctx) => restart(ctx));
  pi.on('mcp_servers_change' as any, (_event: unknown, ctx: ExtensionContext) => restart(ctx));
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
    // Revoke every old-branch grant before any asynchronous restoration can yield.
    for (const state of servers.values()) state.resetApprovals?.();
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
  async function stopSession() {
    shuttingDown = true;
    sessionLifetime.abort();
    activity.clear();
    updateStatus();
    await Promise.all(
      [...servers.values()].map(async (state) => {
        for (const abort of state.subscriptions.values()) abort.abort();
        await state.peer?.close().catch(() => {});
      }),
    );
    for (const state of servers.values())
      if (state.config.native)
        for (const tool of state.tools.keys()) {
          const id = state.ids?.get(tool);
          if (id) unavailableDefinition(id);
        }
    for (const name of nativeResourceNames) if (owned.has(name)) unavailableDefinition(name);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !owned.has(name)));
    servers.clear();
  }
  pi.on('session_shutdown', async () => {
    shuttingDown = true;
    generation++;
    sessionLifetime.abort();
    await reconciliation.catch(() => {});
    await stopSession();
  });

  registerTool({
    name: 'mcp_tasks',
    label: 'MCP Tasks',
    renderCall: renderTasks(),
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
      if (
        !task ||
        task.identity !== identity(state) ||
        toolExposure(state.config, task.tool) === 'hidden'
      )
        throw new Error('Task is not recorded or permitted for this server identity');
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
    renderCall: renderSearchTools(),
    description:
      'Search configured MCP tool catalogs and activate returned tools using Pi native deferred loading. Returns names, descriptions, activation changes and catalog health, not full schemas. Use an empty query with a server to browse its catalog; offset pages through matches.',
    parameters: Type.Object({
      query: Type.String(),
      server: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      if (invalidConfig)
        throw new DiagnosticError(configError ?? 'MCP configuration invalid; inspect mcp_status');
      await refreshStale(ctx);
      if (args.server && !servers.has(args.server))
        throw new DiagnosticError(
          `Unknown MCP server ${displayText(args.server)}. Use mcp_status for enabled server names.`,
        );
      const active = new Set(pi.getActiveTools());
      const matches = [...servers]
        .filter(([name, state]) => state.peer && (!args.server || args.server === name))
        .flatMap(([server, state]) =>
          [...state.tools.values()].map((tool) => ({
            name: idFor(server, tool.name),
            server,
            originalName: tool.name,
            description: tool.description ?? tool.name,
            title: tool.title,
            annotations: tool.annotations,
            icons: tool.icons,
            score: searchScore(
              args.query,
              server,
              tool.name,
              tool.title ?? '',
              tool.description ?? '',
            ),
          })),
        )
        .filter((m) => !args.query.trim() || m.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const offset = args.offset ?? 0;
      const selected = matches.slice(offset, offset + (args.limit ?? 5));
      const activated = selected.filter((m) => !active.has(m.name)).map((m) => m.name);
      pi.setActiveTools([...new Set([...active, ...selected.map((m) => m.name)])]);
      const catalogs = snapshots()
        .filter((s) => !args.server || s.name === args.server)
        .map((s) => ({
          server: s.name,
          connection: s.connection,
          catalog: s.catalog,
          tools: s.tools,
          rejectedTools: s.rejectedTools.length,
          error: s.error ?? s.discoveryError,
        }));
      return present({
        tools: selected,
        activated,
        totalMatches: matches.length,
        nextOffset:
          offset + selected.length < matches.length ? offset + selected.length : undefined,
        catalogs,
        note: !selected.length
          ? !catalogs.length
            ? 'No enabled servers configured. Configure mcp.json and /reload.'
            : catalogs.every((s) => s.connection === 'unavailable')
              ? 'Selected servers are unavailable. Inspect mcp_status; /reload reconnects them.'
              : catalogs.some((s) => s.catalog === 'failed')
                ? 'Discovery failed for some catalogs; matches may be incomplete. Use /mcp refresh.'
                : catalogs.some((s) => s.rejectedTools > 0)
                  ? 'Some tool definitions were rejected. Inspect mcp_status for reasons; matches may be incomplete.'
                  : matches.length
                    ? 'Offset is beyond the matching catalog; start at offset 0.'
                    : 'No matching tools. Try fewer terms, or an empty query with a server to browse.'
          : undefined,
      });
    },
  });
  registerTool({
    name: 'mcp_status',
    label: 'MCP Servers',
    renderCall: renderServerStatus(),
    description:
      'List configured MCP server names, connection status and advertised capabilities. Use before accessing MCP resources or completions.',
    parameters: Type.Object({}),
    async execute() {
      return present({
        ...(invalidConfig
          ? { error: 'MCP configuration invalid; check mcp.json and /reload' }
          : {}),
        diagnostic: configError,
        servers: snapshots(),
      });
    },
  });
  registerTool({
    name: 'mcp_resources',
    label: 'MCP Resources',
    renderCall: renderResources(),
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
    renderCall: renderComplete(),
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
  async function guideCommand(
    action: 'prompt' | 'subscribe' | 'unsubscribe',
    hint: string,
    ctx: ExtensionContext,
  ): Promise<ObjectValue | undefined> {
    if (!ctx.hasUI)
      throw new DiagnosticError(
        `Guided ${action} requires a UI; use /mcp ${action} with JSON arguments instead`,
      );
    const names = [...servers]
      .filter(
        ([, state]) =>
          state.peer &&
          (action === 'prompt'
            ? state.peer.capabilities.prompts
            : state.peer.capabilities.resources?.subscribe),
      )
      .map(([name]) => name);
    if (!names.length)
      throw new DiagnosticError(`No connected server supports ${action}; use /mcp status`);
    if (hint && !names.includes(hint))
      throw new DiagnosticError(
        `Server ${displayText(hint)} is unavailable or does not support ${action}; use /mcp status`,
      );
    const labels = names.map((name, i) => `${i + 1}. ${displayText(name, 100)}`);
    const selected =
      hint ||
      (await withMcpDialog(async () => {
        const choice = await ctx.ui.select(`MCP ${action}: choose server`, labels);
        return choice === undefined ? undefined : names[labels.indexOf(choice)];
      }));
    if (selected === undefined) return undefined;
    const state = get(selected);
    const options = { timeout: state.config.timeout };
    if (action === 'prompt') {
      const prompts = await activity.run(`${selected} · loading prompts`, () =>
        state.peer.list('prompts/list', 'prompts'),
      );
      if (!prompts.length) throw new DiagnosticError('This server has no prompts');
      return withMcpDialog(async () => {
        const labels = prompts.map(
          (prompt, i) =>
            `${i + 1}. ${displayText(String(prompt.name), 100)}${typeof prompt.description === 'string' ? ` — ${displayText(prompt.description, 120)}` : ''}`,
        );
        const choice = await ctx.ui.select(
          `MCP ${displayText(selected)}: choose prompt (server-provided)`,
          labels,
          options,
        );
        const prompt = choice === undefined ? undefined : prompts[labels.indexOf(choice)];
        if (!prompt) return undefined;
        if (
          typeof prompt.name !== 'string' ||
          (prompt.arguments !== undefined && !Array.isArray(prompt.arguments))
        )
          throw new DiagnosticError('Invalid prompt definition from server');
        const args = prompt.arguments ?? [];
        if (args.some((arg: ObjectValue) => !arg || typeof arg.name !== 'string'))
          throw new DiagnosticError('Invalid prompt argument definition from server');
        const schema = {
          type: 'object',
          properties: Object.fromEntries(
            args.map((arg: ObjectValue) => [
              arg.name,
              {
                type: 'string',
                minLength: arg.required ? 1 : 0,
                ...(typeof arg.description === 'string' ? { description: arg.description } : {}),
              },
            ]),
          ),
          required: args
            .filter((arg: ObjectValue) => arg.required)
            .map((arg: ObjectValue) => arg.name),
        };
        if (!canGuide(schema))
          throw new DiagnosticError(
            'Prompt arguments require advanced JSON input. Use /mcp prompt JSON; never include credentials in prompt arguments.',
          );
        const arguments_ = await fillFields(
          ctx,
          `MCP ${selected}: ${prompt.name}`,
          schema,
          options,
        );
        if (arguments_ === undefined) return undefined;
        const release = await ctx.ui.select(
          `MCP ${displayText(selected)}: add ${displayText(prompt.name)} as reference for your next message?\n${formSummary(arguments_)}`,
          ['Add reference', 'Cancel'],
          options,
        );
        return release === 'Add reference'
          ? { server: selected, name: prompt.name, arguments: arguments_ }
          : undefined;
      });
    }
    return withMcpDialog(async () => {
      let uri: string | undefined;
      if (action === 'unsubscribe') {
        const uris = [...state.desired];
        if (!uris.length)
          throw new DiagnosticError('No recorded resource subscriptions for this server');
        const labels = uris.map((uri, i) => `${i + 1}. ${displayText(uri, 160)}`);
        const choice = await ctx.ui.select(
          `MCP ${displayText(selected)}: choose subscription`,
          labels,
          options,
        );
        uri = choice === undefined ? undefined : uris[labels.indexOf(choice)];
      } else
        uri = await ctx.ui.input(
          `MCP ${displayText(selected)}: resource URI to subscribe to`,
          'Exact resource URI (not fetched automatically)',
          options,
        );
      if (!uri) return undefined;
      const choice = await ctx.ui.select(
        `MCP ${displayText(selected)}: ${action} ${displayText(uri, 240)}?`,
        [action, 'Cancel'],
        options,
      );
      return choice === action ? { server: selected, uri } : undefined;
    });
  }
  pi.registerCommand('mcp', {
    description:
      'MCP: status [details] | refresh | sampling | revoke SERVER | login SERVER | logout SERVER | prompts SERVER | prompt [SERVER|JSON] | subscribe [SERVER|JSON] | unsubscribe [SERVER|JSON]',
    handler: async (args, ctx) => {
      currentContext = ctx;
      const [, action = 'status', text = ''] = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
      try {
        if (!action || action === 'status') {
          const status = snapshots();
          if (text === 'details') {
            display(await present({ diagnostic: configError, servers: status }));
          } else {
            const lines = status.flatMap((s) => [
              `${displayText(s.name)} · ${s.connection} · ${s.tools} tools (${s.activeTools} active) · catalog ${s.catalog}`,
              ...[s.error, s.discoveryError, ...s.subscriptionErrors]
                .filter(Boolean)
                .map((error) => `  ${displayText(error!, 800)}`),
              ...s.rejectedTools.map((tool) => `  Excluded ${tool.name}: ${tool.reason}`),
            ]);
            display(
              await present({
                content: [
                  {
                    type: 'text',
                    text: [
                      configError,
                      ...lines,
                      !status.length && !configError
                        ? 'No enabled MCP servers configured.'
                        : undefined,
                      'Use /mcp status details for capabilities and metadata. /mcp refresh refreshes connected servers; /reload reconnects unavailable servers.',
                    ]
                      .filter(Boolean)
                      .join('\n'),
                  },
                ],
              }),
            );
          }
        } else if (action === 'revoke') {
          const state = servers.get(text);
          if (!state?.peer || !state.resetApprovals)
            throw new DiagnosticError('Expected a connected MCP server name');
          state.resetApprovals();
          state.approvalEvents = [
            ...(state.approvalEvents ?? []).slice(-19),
            {
              at: new Date().toISOString(),
              event: { decision: 'revoke', source: 'user-command' },
            },
          ];
          notify(
            ctx,
            `Cleared remembered client approvals for ${displayText(text)}. Future requests need fresh consent; actions already executed are not undone.`,
          );
        } else if (action === 'login' || action === 'logout') {
          const state = servers.get(text);
          if (!state?.oauth)
            throw new DiagnosticError('Configure oauth for this HTTP server first');
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
          if (invalidConfig)
            throw new DiagnosticError(configError ?? 'MCP configuration invalid; use /mcp status');
          await activity.run('refresh · waiting for agent to finish', () => ctx.waitForIdle());
          const summary: string[] = [];
          for (const [name, state] of servers) {
            if (!state.peer) {
              summary.push(`${displayText(name)}: unavailable; /reload to reconnect`);
              continue;
            }
            const before = JSON.stringify([...state.tools.values()]);
            try {
              await refresh(name, state, ctx);
              summary.push(
                `${displayText(name)}: refreshed ${state.tools.size} tools; ${before === JSON.stringify([...state.tools.values()]) ? 'no definition changes' : 'catalog changed'}${state.rejected.length ? `; ${state.rejected.length} excluded (/mcp status)` : ''}`,
              );
            } catch (error) {
              summary.push(
                `${displayText(name)}: refresh failed — ${failureReason(error)}; /mcp refresh to retry`,
              );
              continue;
            }
            if (!state.peer || state.peer.version !== MODERN) continue;
            for (const key of state.subscriptionErrors.keys()) {
              if (key === 'lists')
                listen(name, { ...state, peer: state.peer }, key, {
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
          display(
            await present({
              content: [
                {
                  type: 'text',
                  text: summary.length ? summary.join('\n') : 'No enabled MCP servers to refresh.',
                },
              ],
            }),
          );
        } else if (action === 'prompts') {
          const state = get(text);
          requireCapability(state, 'prompts');
          const result = await present({
            prompts: await state.peer.list('prompts/list', 'prompts'),
          });
          display(result);
        } else if (action === 'prompt') {
          const params =
            text.startsWith('{') || text.startsWith('[') || text === 'null'
              ? JSON.parse(text)
              : await guideCommand('prompt', text, ctx);
          if (params === undefined) {
            notify(ctx, 'MCP prompt cancelled; no reference queued');
            return;
          }
          if (
            !params ||
            typeof params.server !== 'string' ||
            typeof params.name !== 'string' ||
            (params.arguments !== undefined &&
              (!params.arguments ||
                typeof params.arguments !== 'object' ||
                Array.isArray(params.arguments) ||
                Object.values(params.arguments).some((v) => typeof v !== 'string')))
          )
            throw new DiagnosticError(
              'Expected server, name and optional string-valued arguments; use /mcp prompt {"server":"NAME","name":"PROMPT","arguments":{}}',
            );
          const state = get(params.server);
          requireCapability(state, 'prompts');
          const response = await activity.run(`${params.server} · fetching prompt`, () =>
            state.peer.request('prompts/get', {
              name: params.name,
              arguments: params.arguments ?? {},
            }),
          );
          // Preserve server roles as data, never impersonate a user or system message.
          const result = await present(response);
          pi.sendMessage(
            { customType: 'mcp-prompt', content: result.content, display: true },
            { deliverAs: 'nextTurn' },
          );
          notify(ctx, 'MCP prompt added as reference context for your next message');
        } else if (action === 'subscribe' || action === 'unsubscribe') {
          const params =
            text.startsWith('{') || text.startsWith('[') || text === 'null'
              ? JSON.parse(text)
              : await guideCommand(action, text, ctx);
          if (params === undefined) {
            notify(ctx, `MCP ${action} cancelled; subscriptions unchanged`);
            return;
          }
          if (!params || typeof params.server !== 'string' || typeof params.uri !== 'string')
            throw new DiagnosticError(
              'Expected server and uri; use /mcp subscribe {"server":"NAME","uri":"URI"} (or unsubscribe)',
            );
          const state = get(params.server);
          requireCapability(state, 'resources');
          if (!state.peer.capabilities.resources.subscribe)
            throw new DiagnosticError('Resource subscriptions unsupported by this server');
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
        } else
          throw new DiagnosticError(
            'Unknown /mcp action. Use status, refresh, sampling, login, logout, prompts, prompt, subscribe or unsubscribe.',
          );
      } catch (error) {
        notify(ctx, `MCP ${displayText(action, 40)}: ${failureReason(error)}`, 'error');
      }
    },
  });
}
