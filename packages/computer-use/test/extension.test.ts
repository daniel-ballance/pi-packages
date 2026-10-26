import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerComputerUse } from '../extensions/computer-use/src/index.js';
import { detectInstallation, type Installation } from '../extensions/computer-use/src/installation.js';
import { ComputerSession } from '../extensions/computer-use/src/session.js';

type Tool = Parameters<ExtensionAPI['registerTool']>[0];
type Command = Parameters<ExtensionAPI['registerCommand']>[1];

function fixture(hasUI = true) {
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const hooks = new Map<string, (...args: any[]) => unknown>();
  const notices: string[] = [];
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: (...args: any[]) => unknown) => hooks.set(name, handler),
    sendMessage: (message: { content: string }) => notices.push(message.content),
  } as unknown as ExtensionAPI;
  const ctx = { hasUI, ui: {
    notify: (message: string) => { assert.ok(hasUI, 'No UI calls in headless mode'); notices.push(message); },
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
  const installation: Installation = { available: true, mode: 'local', chatgptApp: '/ChatGPT.app', companionApp: '/Companion.app', launch: { command: '/unused', args: [], env: {}, cwd: '/' } };
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

test('remote status and tools work with and without a UI without connecting during registration', async () => {
  for (const hasUI of [false, true]) {
    const f = fixture(hasUI);
    const detect = (): Installation => detectInstallation({ platform: 'linux', env: { PI_COMPUTER_USE_SSH: 'dan@mac' } });
    const session = new ComputerSession(detect);
    registerComputerUse(f.pi, detect, session);
    assert.deepEqual([...f.tools.keys()], ['computer_use', 'computer_use_reset']);
    assert.equal(session.connected, false);
    const command = f.commands.get('computer-use')!;
    await command.handler('', f.ctx);
    assert.match(f.notices[0], /configured.*remote availability checked on first call/);
    assert.match(f.notices[0], /SSH: dan@mac/);
    await command.handler('reset', f.ctx);
    assert.match(f.notices[1], /reset/);
    await command.handler('unknown', f.ctx);
    assert.match(f.notices[2], /Usage/);
  }
});

test('installing the apps during a disabled session directs the user to reload', async () => {
  const f = fixture();
  let installation: Installation = { available: false, reason: 'Missing' };
  registerComputerUse(f.pi, () => installation);
  installation = { available: true, mode: 'local', chatgptApp: '/ChatGPT.app', companionApp: '/Companion.app', launch: { command: '/unused', args: [], env: {}, cwd: '/' } };
  await f.commands.get('computer-use')!.handler('', f.ctx);
  assert.match(f.notices[0], /reload/);
  assert.equal(f.tools.size, 0);
});
