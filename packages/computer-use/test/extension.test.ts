import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerComputerUse } from '../extensions/computer-use/src/index.js';
import type { Installation } from '../extensions/computer-use/src/installation.js';
import { ComputerSession } from '../extensions/computer-use/src/session.js';

type Tool = Parameters<ExtensionAPI['registerTool']>[0];
type Command = Parameters<ExtensionAPI['registerCommand']>[1];

function fixture() {
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const hooks = new Map<string, (...args: any[]) => unknown>();
  const notices: string[] = [];
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: (...args: any[]) => unknown) => hooks.set(name, handler),
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false, ui: {
    notify: (message: string) => notices.push(message),
    select: () => { assert.fail('Computer Use must not show Pi approval dialogs'); },
  } } as unknown as ExtensionCommandContext;
  return { tools, commands, hooks, notices, pi, ctx };
}

test('unsupported and missing installations quietly register only the status command', async () => {
  for (const reason of ['Requires macOS', 'Companion not installed', 'Runtime incomplete']) {
    const f = fixture();
    registerComputerUse(f.pi, () => ({ available: false, reason }));
    assert.equal(f.tools.size, 0);
    assert.equal(f.notices.length, 0);
    await f.commands.get('computer-use')!.handler('', f.ctx);
    assert.deepEqual(f.notices, [reason]);
  }
});

test('tools are normal direct registrations and clean up on session lifecycle changes', async () => {
  const f = fixture();
  const installation: Installation = { available: true, chatgptApp: '/ChatGPT.app', companionApp: '/Companion.app', launch: { command: '/unused', args: [], env: {}, cwd: '/' } };
  const session = new ComputerSession(() => installation);
  let closes = 0;
  session.close = async () => { closes++; };
  registerComputerUse(f.pi, () => installation, session);
  assert.deepEqual([...f.tools.keys()], ['computer_use', 'computer_use_reset']);
  for (const tool of f.tools.values()) {
    assert.equal((tool as unknown as { exposure?: string }).exposure, undefined);
    assert.equal((tool as unknown as { namespace?: unknown }).namespace, undefined);
  }
  assert.equal(session.connected, false);
  await f.commands.get('computer-use')!.handler('', f.ctx);
  assert.match(f.notices[0], /ready/);
  for (const hook of ['session_start', 'session_tree', 'session_shutdown']) await f.hooks.get(hook)!({}, f.ctx);
  assert.equal(closes, 3);
  await f.tools.get('computer_use_reset')!.execute('reset', {}, undefined, undefined, f.ctx as unknown as Parameters<Tool['execute']>[4]);
  assert.equal(closes, 4);
});

test('installing the apps during a disabled session directs the user to reload', async () => {
  const f = fixture();
  let installation: Installation = { available: false, reason: 'Missing' };
  registerComputerUse(f.pi, () => installation);
  installation = { available: true, chatgptApp: '/ChatGPT.app', companionApp: '/Companion.app', launch: { command: '/unused', args: [], env: {}, cwd: '/' } };
  await f.commands.get('computer-use')!.handler('', f.ctx);
  assert.match(f.notices[0], /reload/);
  assert.equal(f.tools.size, 0);
});
