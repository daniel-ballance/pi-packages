import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../extensions/mcp-client/index.js';
import { toolName } from '../extensions/mcp-client/src/index.js';
import { normalizeToolResult } from '../extensions/mcp-client/src/content.js';

// Native Pi v1.1.0 tolerates omitted content (including structured-only results).
// Explicit malformed fields are not equivalent to omission.
test('native-shaped normalization preserves structured/error/image data without mutation', () => {
  const structured = { structuredContent: { value: 4 }, isError: true };
  assert.deepEqual(normalizeToolResult(structured), { ...structured, content: [] });
  assert.equal(Object.hasOwn(structured, 'content'), false);
  assert.deepEqual(normalizeToolResult({}), { content: [] });
  const withContent = { content: [{ type: 'image', mimeType: 'image/png', data: 'test' }] };
  assert.equal(normalizeToolResult(withContent), withContent);
  for (const invalid of [
    null,
    [],
    'result',
    { content: null },
    { content: {} },
    { structuredContent: [] },
    { structuredContent: null },
    { structuredContent: 'not-an-object' },
    { isError: 'true' },
  ])
    assert.throws(() => normalizeToolResult(invalid), /Invalid MCP/);
});

test('registered tools accept structured-only results and preserve errors/images', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-results-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const entries: string[] = [];
  let active: string[] = [];
  let connected = false;
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => (disconnected = resolve));
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    getAllTools: () => [...tools.values()],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
      if (connected && !names.includes(toolName('fixture', 'structured'))) disconnected();
    },
    sendMessage() {},
    appendEntry: (type: string) => entries.push(type),
  };
  const ctx: any = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify() {}, setStatus() {}, theme: { fg: (_: string, text: string) => text } },
    sessionManager: { getBranch: () => [] },
  };
  try {
    await mkdir(join(cwd, '.pi'));
    await writeFile(
      join(cwd, '.pi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/result-shapes.mjs', import.meta.url))],
            protocol: '2025-11-25',
          },
        },
      }),
    );
    extension(pi);
    await handlers.get('session_start')!({}, ctx);
    connected = true;
    const call = (name: string) =>
      tools.get(toolName('fixture', name)).execute('test', {}, undefined, undefined, ctx);
    const structured = await call('structured');
    assert.match(structured.content[0].text, /"value": 4/);
    assert.deepEqual(structured.details.raw.structuredContent, { value: 4 });
    const taskData = await call('legacyTask');
    assert.match(taskData.content[0].text, /"value": 4/);
    await assert.rejects(call('invalidLegacyTask'), /does not match outputSchema/);
    assert.equal(entries.includes('mcp-task'), false);
    const empty = await call('empty');
    assert.equal(empty.content[0].text, '(No content)');
    for (const name of ['invalid', 'malformed'])
      await assert.rejects(call(name), /invalid tools\/call result fields.*do not blindly retry/);
    const error = await call('error');
    assert.equal(error.details.mcpError, true);
    assert.match(error.content[0].text, /fixture decline/);
    const image = await call('image');
    assert.deepEqual(
      image.content.map((b: any) => b.type),
      ['text', 'image'],
    );
    assert.equal(image.content[1].mimeType, 'image/png');
    const pid = (await call('pid')).details.raw.structuredContent.pid;
    const abort = new AbortController();
    const pending = tools
      .get(toolName('fixture', 'pending'))
      .execute('cancel-test', {}, abort.signal, undefined, ctx);
    const failed = assert.rejects(pending, /outcome is unknown/);
    abort.abort();
    await failed;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Fixture did not disconnect')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(active.includes(toolName('fixture', 'structured')), false);
    assert.throws(
      () => process.kill(pid, 0),
      (error: any) => error.code === 'ESRCH',
    );
    await assert.rejects(call('structured'), /unavailable/);
  } finally {
    await handlers.get('session_shutdown')?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
