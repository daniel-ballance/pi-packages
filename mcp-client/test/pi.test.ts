import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../index.js';
import { toolName } from '../src/index.js';
import { present } from '../src/content.js';
import { ServerSchema } from '../src/config.js';
import { inputHandler } from '../src/input.js';

function harness(cwd: string, trusted = true) {
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>(),
    commands = new Map<string, any>();
  let active = ['read', 'bash'];
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
    appendEntry() {},
    registerEntryRenderer() {},
  };
  const statuses = new Map<string, string>();
  const ctx: any = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: {
      notify() {},
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
  return { pi, ctx, handlers, tools, commands, statuses };
}

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
        servers: {
          fixture: {
            transport: 'stdio',
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
  let inputs = ['{"count":"wrong"}', '{"count":2}'];
  const ctx: any = {
    cwd: '/tmp',
    hasUI: true,
    ui: { select: async () => 'Provide JSON', input: async () => inputs.shift(), notify() {} },
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
        servers: {
          fixture: {
            transport: 'stdio',
            command: process.execPath,
            protocol: '2026-07-28',
            args: [
              fileURLToPath(new URL('./fixtures/health-server.mjs', import.meta.url)),
              modePath,
            ],
          },
          disabled: { transport: 'stdio', command: '/nonexistent', disabled: true },
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
    await writeFile(modePath, 'disconnect');
    await assert.rejects(echo.execute('2', {}, undefined, undefined, h.ctx));
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
    await h.handlers.get('session_shutdown')!();
    await writeFile(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        servers: {
          missing: { transport: 'stdio', command: join(cwd, 'nonexistent') },
          working: {
            transport: 'stdio',
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
    await writeFile(join(cwd, 'mcp.json'), '{"servers":{}}');
    await h.handlers.get('session_start')!({}, h.ctx);
    assert.equal(h.statuses.has('mcp-client'), false);
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
