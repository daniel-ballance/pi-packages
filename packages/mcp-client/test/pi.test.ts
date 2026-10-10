import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../extensions/mcp-client/index.js';
import { toolName } from '../extensions/mcp-client/src/index.js';
import { present } from '../extensions/mcp-client/src/content.js';
import { ServerSchema } from '../extensions/mcp-client/src/config.js';
import { inputHandler } from '../extensions/mcp-client/src/input.js';

function harness(cwd: string, trusted = true) {
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>(),
    commands = new Map<string, any>();
  let active = ['read', 'bash'];
  const entries: { type: string; data: any }[] = [];
  const notifications: string[] = [];
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
    sendMessage() {},
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    registerEntryRenderer() {},
  };
  const statuses = new Map<string, string>();
  const ctx: any = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: {
      notify: (text: string) => notifications.push(text),
      theme: { fg: (level: string, text: string) => `${level}:${text}` },
      setStatus: (key: string, text?: string) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => [] },
  };
  extension(pi);
  return { pi, ctx, handlers, tools, commands, statuses, entries, notifications };
}

test('native registered servers reconcile restrictions and shutdown invalidates queued restarts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-native-lifecycle-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'global');
  const h = harness(cwd);
  let reads = 0;
  let exposure = 'direct';
  let toolExposure: Record<string, string> | undefined;
  h.pi.registerTool({ name: 'codemode', sourceInfo: { path: '/some-other-extension.ts' } });
  h.pi.registerTool({ name: 'tool_search', sourceInfo: { path: 'builtin:tool-search' } });
  h.pi.setActiveTools(['read', 'bash']);
  h.pi.getMcpServers = () => {
    reads++;
    return [
      {
        name: 'fixture',
        config: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), '2026-07-28'],
          protocol: '2026-07-28',
          exposure,
          toolExposure,
        },
      },
    ];
  };
  try {
    await mkdir(join(cwd, '.pi'));
    await writeFile(
      join(cwd, '.pi', 'mcp-client.json'),
      JSON.stringify({ configurationFormat: 'native' }),
    );
    const initial = h.handlers.get('session_start')!({}, h.ctx);
    const queued = h.handlers.get('mcp_servers_change')!({}, h.ctx);
    const shutdown = h.handlers.get('session_shutdown')!();
    await Promise.all([initial, queued, shutdown]);
    assert.equal(reads, 0, 'Superseded startup must not read or connect registered servers');
    await h.handlers.get('session_start')!({}, h.ctx);
    const old = h.tools.get('mcp__fixture__echo');
    assert.ok(old);
    assert.equal(
      (await old.execute('before', { text: 'allowed' }, undefined, undefined, h.ctx))
        .structuredContent.content[0].text,
      'allowed',
    );
    exposure = 'deferred';
    await h.handlers.get('mcp_servers_change')!({}, h.ctx);
    assert.equal(h.pi.getActiveTools().includes('tool_search'), true);
    assert.equal(h.pi.getActiveTools().includes('codemode'), false);
    exposure = 'codemode';
    await h.handlers.get('mcp_servers_change')!({}, h.ctx);
    assert.equal(
      h.pi.getActiveTools().includes('codemode'),
      false,
      'Must not activate another extension by builtin name',
    );
    exposure = 'hidden';
    await h.handlers.get('mcp_servers_change')!({}, h.ctx);
    assert.equal(h.tools.get('mcp__fixture__echo').exposure, 'hidden');
    await assert.rejects(
      old.execute('after', { text: 'blocked' }, undefined, undefined, h.ctx),
      /unavailable/,
    );
    assert.equal(h.pi.getActiveTools().includes('mcp__fixture__echo'), false);
    const resources = h.tools.get('list_mcp_resources');
    await assert.rejects(
      resources.execute('hidden-resource', { server: 'fixture' }, undefined),
      /unavailable/,
    );
    toolExposure = { echo: 'direct' };
    await h.handlers.get('mcp_servers_change')!({}, h.ctx);
    const exception = h.tools.get('mcp__fixture__echo');
    assert.equal(exception.exposure, 'direct');
    assert.equal(
      (await exception.execute('exception', { text: 'explicit' }, undefined, undefined, h.ctx))
        .structuredContent.content[0].text,
      'explicit',
    );
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Computer Use consent is reused only on the same live connection and branch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-session-consent-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'global');
  const h = harness(cwd);
  let prompts = 0;
  h.ctx.hasUI = true;
  h.ctx.ui.select = async () => {
    prompts++;
    return 'Allow for this session';
  };
  h.pi.getMcpServers = () => [
    {
      name: 'fixture',
      config: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/native-approval-server.mjs', import.meta.url))],
        protocol: '2025-11-25',
        exposure: 'codemode',
      },
    },
  ];
  const invoke = () =>
    h.tools.get('mcp__fixture__approve').execute('consent', {}, undefined, undefined, h.ctx);
  try {
    await mkdir(join(cwd, '.pi'));
    await writeFile(
      join(cwd, '.pi', 'mcp-client.json'),
      JSON.stringify({
        configurationFormat: 'native',
        serverOptions: { fixture: { elicitation: true } },
        computerUse: {
          fixture: {
            apps: ['com.apple.calculator'],
            operations: ['get_app_state'],
            persistence: 'session',
          },
        },
      }),
    );
    await h.handlers.get('session_start')!({}, h.ctx);
    await invoke();
    const reused = await invoke();
    assert.equal(prompts, 1);
    assert.equal(reused.structuredContent.structuredContent.source, 'computer-use-persisted-state');
    const status = await h.tools.get('mcp_status').execute();
    assert.match(JSON.stringify(status), /approvalEvents/);
    await h.commands.get('mcp').handler('revoke fixture', h.ctx);
    await invoke();
    assert.equal(prompts, 2, 'Explicit revocation must require fresh consent');
    await h.handlers.get('session_tree')!({}, h.ctx);
    await invoke();
    assert.equal(prompts, 3, 'Branch navigation must invalidate consent');
    await h.handlers.get('mcp_servers_change')!({}, h.ctx);
    await invoke();
    assert.equal(prompts, 4, 'New connection must require fresh consent');
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('branch changes revoke all grants before waiting for another server restoration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-multi-consent-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'global');
  const h = harness(cwd);
  const marker = join(cwd, 'unsubscribe-waiting');
  let prompts = 0;
  h.ctx.hasUI = true;
  h.ctx.ui.select = async () => {
    prompts++;
    return 'Allow for this session';
  };
  h.pi.getMcpServers = () =>
    ['first', 'second'].map((name) => ({
      name,
      config: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/native-approval-server.mjs', import.meta.url)),
          ...(name === 'first' ? [marker] : []),
        ],
        protocol: '2025-11-25',
        exposure: 'codemode',
      },
    }));
  const invoke = () =>
    h.tools.get('mcp__second__approve').execute('consent', {}, undefined, undefined, h.ctx);
  try {
    await mkdir(join(cwd, '.pi'));
    await writeFile(
      join(cwd, '.pi', 'mcp-client.json'),
      JSON.stringify({
        configurationFormat: 'native',
        serverOptions: { second: { elicitation: true } },
        computerUse: {
          second: {
            apps: ['com.apple.calculator'],
            operations: ['get_app_state'],
            persistence: 'session',
          },
        },
      }),
    );
    await h.handlers.get('session_start')!({}, h.ctx);
    await invoke();
    await invoke();
    assert.equal(prompts, 1);
    await h.commands
      .get('mcp')
      .handler('subscribe {"server":"first","uri":"fixture://image"}', h.ctx);
    const branch = h.handlers.get('session_tree')!({}, h.ctx);
    const deadline = Date.now() + 3000;
    while (
      !(await stat(marker).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, 'First server must enter delayed restoration');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await invoke();
    assert.equal(prompts, 2, 'Second-server consent must be revoked while first is stalled');
    await branch;
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Pi factory opens no connections; session discovers tools and shutdown closes them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-pi-test-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'global');
  const h = harness(cwd);
  try {
    await mkdir(join(cwd, '.pi'));
    await writeFile(
      join(cwd, '.pi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), '2026-07-28'],
          },
        },
      }),
    );
    assert.equal(h.tools.has(toolName('fixture', 'echo')), false);
    await h.handlers.get('session_start')!({}, h.ctx);
    const echo = h.tools.get(toolName('fixture', 'echo'));
    assert.ok(echo);
    assert.equal(typeof echo.renderCall, 'function');
    assert.equal(echo.renderResult, undefined); // Preserve Pi's default result preview/expansion.
    assert.equal(echo.name, toolName('fixture', 'echo'));
    assert.ok(h.pi.getActiveTools().includes('read'));
    const result = await echo.execute('1', { text: 'hello' }, undefined, undefined, h.ctx);
    assert.equal(result.content[0].text, 'hello');
    const errorPatch = h.handlers.get('tool_result')!({
      toolName: echo.name,
      details: { mcpError: true },
    });
    assert.deepEqual(errorPatch, { isError: true });
    await h.handlers.get('session_shutdown')!();
    await assert.rejects(
      echo.execute('2', { text: 'after close' }, undefined, undefined, h.ctx),
      /unavailable/,
    );
    await h.handlers.get('session_shutdown')!();
    const untrusted = harness(cwd, false);
    await untrusted.handlers.get('session_start')!({}, untrusted.ctx);
    assert.equal(untrusted.tools.has(toolName('fixture', 'echo')), false);
    await untrusted.handlers.get('session_shutdown')!();
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('content mapping preserves text, images, resources, structured data and MCP errors', async () => {
  const result = await present({
    isError: true,
    content: [
      { type: 'text', text: 'failure' },
      { type: 'image', data: 'abcd', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'test:one', text: 'embedded' } },
      { type: 'resource_link', uri: 'https://example.invalid/no-fetch' },
    ],
    structuredContent: { value: 3 },
  });
  assert.equal(result.details.mcpError, true);
  assert.equal(result.content[1].type, 'image');
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  assert.match(text, /embedded/);
  assert.match(text, /"value": 3/);
  assert.deepEqual(
    result.content.map((b) => b.type),
    ['text', 'image', 'text', 'text', 'text'],
  );
});

test('oversized tool results are bounded and saved privately', async () => {
  const result = await present({ content: [{ type: 'text', text: 'x'.repeat(100000) }] });
  const path = result.details.fullOutput!;
  try {
    assert.ok(path);
    assert.ok((result.content[0] as any).text.length < 52000);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).content[0].text.length, 100000);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('form elicitation validates JSON and refuses headless, URL and disabled capabilities', async () => {
  const config = ServerSchema.parse({
    transport: 'stdio',
    command: 'unused',
    elicitation: true,
    roots: ['.'],
  });
  const inputs = ['{"count":"wrong"}', '{"count":2}'];
  const choices = ['Provide JSON', 'Send answers'];
  const ctx: any = {
    cwd: '/tmp',
    hasUI: true,
    ui: { select: async () => choices.shift(), input: async () => inputs.shift(), notify() {} },
  };
  const handle = inputHandler('test', config, ctx);
  const params = {
    message: 'Choose count',
    requestedSchema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    },
  };
  assert.deepEqual(await handle('elicitation/create', params), {
    action: 'accept',
    content: { count: 2 },
  });
  assert.deepEqual(await handle('roots/list', {}), { roots: [{ uri: 'file:///tmp' }] });
  await assert.rejects(handle('sampling/createMessage', {}));
  await assert.rejects(handle('elicitation/create', { ...params, mode: 'url' }));
  ctx.hasUI = false;
  await assert.rejects(handle('elicitation/create', params));
});

test('native status tracks discovery recovery and disconnects, but not ordinary tool errors', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-health-test-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const h = harness(cwd, false);
  h.ctx.hasUI = true;
  h.statuses.set('other-extension', 'untouched');
  const modePath = join(cwd, 'mode');
  try {
    await writeFile(modePath, 'healthy');
    await writeFile(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            type: 'stdio',
            command: process.execPath,
            protocol: '2026-07-28',
            args: [
              fileURLToPath(new URL('./fixtures/health-server.mjs', import.meta.url)),
              modePath,
            ],
          },
          disabled: { command: '/nonexistent', disabled: true },
        },
      }),
    );
    await h.handlers.get('session_start')!({}, h.ctx);
    assert.equal(h.statuses.has('mcp-client'), false);
    const echo = h.tools.get(toolName('fixture', 'echo'));
    await writeFile(modePath, 'tool-error');
    const result = await echo.execute('1', {}, undefined, undefined, h.ctx);
    assert.equal(result.details.mcpError, true);
    assert.equal(h.statuses.has('mcp-client'), false);
    await writeFile(modePath, 'discovery-error');
    await h.commands.get('mcp').handler('refresh', h.ctx);
    assert.match(h.statuses.get('mcp-client')!, /^warning:.*needs attention/);
    const status = await h.tools.get('mcp_status').execute();
    assert.match(status.content[0].text, /Tool discovery failed/);
    await writeFile(modePath, 'healthy');
    await h.commands.get('mcp').handler('refresh', h.ctx);
    assert.equal(h.statuses.has('mcp-client'), false);
    await writeFile(modePath, 'rejected');
    await h.commands.get('mcp').handler('refresh', h.ctx);
    const rejected = JSON.parse((await h.tools.get('mcp_status').execute()).content[0].text)
      .servers[0];
    assert.equal(rejected.catalog, 'partial');
    assert.equal(rejected.rejectedTools[0].name, 'invalid');
    assert.match(rejected.rejectedTools[0].reason, /input schema cannot be compiled/);
    assert.match(h.statuses.get('mcp-client')!, /needs attention/);
    await h.commands.get('mcp').handler('status', h.ctx);
    assert.match(h.entries.at(-1)!.data.text, /Excluded invalid: input schema/);
    await writeFile(modePath, 'disconnect');
    await assert.rejects(
      echo.execute('2', {}, undefined, undefined, h.ctx),
      /outcome is unknown.*No automatic retry/,
    );
    assert.equal(h.statuses.get('mcp-client'), 'error:× MCP · unavailable');
    await h.handlers.get('session_shutdown')!();
    assert.equal(h.statuses.has('mcp-client'), false);
    assert.equal(h.statuses.get('other-extension'), 'untouched');
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('configuration and startup failures persist in native status and expose details', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-health-config-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const h = harness(cwd, false);
  h.ctx.hasUI = true;
  try {
    await writeFile(join(cwd, 'mcp.json'), '{invalid');
    await h.handlers.get('session_start')!({}, h.ctx);
    assert.equal(h.statuses.get('mcp-client'), 'error:× MCP · invalid configuration');
    assert.match(
      (await h.tools.get('mcp_status').execute()).content[0].text,
      /configuration invalid/,
    );
    await assert.rejects(
      h.tools
        .get('mcp_search_tools')
        .execute('invalid', { query: '' }, undefined, undefined, h.ctx),
      /Invalid JSON.*mcp.json/,
    );
    await h.commands.get('mcp').handler('refresh', h.ctx);
    assert.match(h.notifications.at(-1)!, /Invalid JSON.*mcp.json/);
    await h.handlers.get('session_shutdown')!();
    await writeFile(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          missing: { command: join(cwd, 'nonexistent') },
          working: {
            type: 'stdio',
            command: process.execPath,
            protocol: '2026-07-28',
            args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), '2026-07-28'],
          },
        },
      }),
    );
    await h.handlers.get('session_start')!({}, h.ctx);
    assert.equal(h.statuses.get('mcp-client'), 'warning:⚠ MCP · missing unavailable');
    await h.handlers.get('session_shutdown')!();
    await writeFile(join(cwd, 'mcp.json'), '{"mcpServers":{}}');
    await h.handlers.get('session_start')!({}, h.ctx);
    assert.equal(h.statuses.has('mcp-client'), false);
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('AX/UX: discovery activation, empty-result guidance, status and command feedback', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-experience-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const h = harness(cwd, false);
  h.ctx.hasUI = true;
  try {
    await writeFile(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            protocol: '2026-07-28',
            toolLoading: 'deferred',
            args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), '2026-07-28'],
          },
          missing: { command: join(cwd, 'missing') },
        },
      }),
    );
    await h.handlers.get('session_start')!({}, h.ctx);
    const call = async (tool: string, args = {}) =>
      h.tools.get(tool).execute('test', args, undefined, undefined, h.ctx);
    const data = (result: any) => JSON.parse(result.content[0].text);
    let status = data(await call('mcp_status'));
    assert.equal(status.servers[0].connection, 'connected');
    assert.equal(status.servers[0].activeTools, 0);
    const search = data(await call('mcp_search_tools', { query: '', server: 'fixture' }));
    assert.equal(search.totalMatches, 1);
    assert.deepEqual(search.activated, [toolName('fixture', 'echo')]);
    assert.deepEqual(data(await call('mcp_search_tools', { query: 'echo' })).activated, []);
    assert.match(
      data(await call('mcp_search_tools', { query: 'no-such-tool' })).note,
      /No matching/,
    );
    assert.match(data(await call('mcp_search_tools', { query: '', offset: 20 })).note, /Offset/);
    assert.match(
      data(await call('mcp_search_tools', { query: '', server: 'missing' })).note,
      /unavailable/,
    );
    await assert.rejects(
      call('mcp_search_tools', { query: '', server: 'typo' }),
      /Unknown MCP server.*mcp_status/,
    );
    status = data(await call('mcp_status'));
    assert.equal(status.servers[0].activeTools, 1);
    await assert.rejects(
      call(toolName('fixture', 'echo'), {}),
      /Rejected before execution.*\/text: required/,
    );
    await h.commands.get('mcp').handler('status', h.ctx);
    assert.match(h.entries.at(-1)!.data.text, /fixture · connected · 1 tools \(1 active\)/);
    await h.commands.get('mcp').handler('status details', h.ctx);
    assert.equal(JSON.parse(h.entries.at(-1)!.data.text).servers[0].connection, 'connected');
    await h.commands.get('mcp').handler('refresh', h.ctx);
    assert.match(h.entries.at(-1)!.data.text, /fixture: refreshed.*no definition changes/);
    assert.match(h.entries.at(-1)!.data.text, /missing: unavailable; \/reload/);
    await h.commands.get('mcp').handler('prompt {broken-secret-value', h.ctx);
    assert.match(h.notifications.at(-1)!, /MCP prompt: Invalid JSON/);
    assert.doesNotMatch(h.notifications.at(-1)!, /broken-secret-value/);
    await h.commands.get('mcp').handler('unknown', h.ctx);
    assert.match(h.notifications.at(-1)!, /Unknown \/mcp action/);
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('guided commands select prompts and subscriptions without starting model turns', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-guided-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const h = harness(cwd, false);
  h.ctx.hasUI = true;
  const messages: any[] = [];
  h.pi.sendMessage = (...args: any[]) => messages.push(args);
  let cancelReview = true;
  h.ctx.ui.select = async (_title: string, options: string[]) => {
    if (options.includes('Skip')) return 'Skip';
    if (options.includes('Add reference') && cancelReview) return undefined;
    return options[0];
  };
  h.ctx.ui.input = async () => 'typescript';
  try {
    await writeFile(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          demo: {
            type: 'stdio',
            command: process.execPath,
            protocol: '2025-11-25',
            args: [fileURLToPath(new URL('./fixtures/tui-server.mjs', import.meta.url))],
          },
        },
      }),
    );
    await h.handlers.get('session_start')!({}, h.ctx);
    await h.commands.get('mcp').handler('prompt', h.ctx);
    assert.equal(messages.length, 0);
    assert.match(h.notifications.at(-1)!, /cancelled; no reference queued/);
    cancelReview = false;
    await h.commands.get('mcp').handler('prompt demo', h.ctx);
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0].customType, 'mcp-prompt');
    assert.equal(messages[0][1].deliverAs, 'nextTurn');
    assert.match(JSON.stringify(messages[0][0].content), /typescript/);
    assert.doesNotMatch(JSON.stringify(messages[0][0].content), /focus/);
    h.ctx.ui.input = async () => 'fixture:notes';
    await h.commands.get('mcp').handler('subscribe demo', h.ctx);
    const status = async () =>
      JSON.parse((await h.tools.get('mcp_status').execute()).content[0].text);
    assert.deepEqual((await status()).servers[0].subscriptions, ['fixture:notes']);
    await h.commands.get('mcp').handler('unsubscribe demo', h.ctx);
    assert.deepEqual((await status()).servers[0].subscriptions, []);
    h.ctx.ui.select = async () => undefined;
    await h.commands.get('mcp').handler('subscribe', h.ctx);
    assert.deepEqual((await status()).servers[0].subscriptions, []);
    assert.match(h.notifications.at(-1)!, /subscriptions unchanged/);
    h.ctx.hasUI = false;
    await h.commands.get('mcp').handler('prompt demo', h.ctx);
    assert.equal(messages.length, 1);
  } finally {
    await h.handlers.get('session_shutdown')!();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('namespaces are stable, bounded, and collision resistant after sanitization', () => {
  assert.notEqual(toolName('a-b', 'c'), toolName('a_b', 'c'));
  assert.notEqual(toolName('a', 'b_c'), toolName('a_b', 'c'));
  assert.equal(toolName('a', 'b'), toolName('a', 'b'));
  assert.ok(toolName('a'.repeat(300), 'b').length <= 64);
});
