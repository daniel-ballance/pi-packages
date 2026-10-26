import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { detectInstallation, type Installation } from './installation.js';
import { present } from './result.js';
import { ComputerSession } from './session.js';

/** No MCP configuration or companion extension is required. */
export function registerComputerUse(
  pi: ExtensionAPI,
  detect: () => Installation = detectInstallation,
  session = new ComputerSession(detect),
): void {
  const installation = detect();
  let turnId = randomUUID();

  pi.registerCommand('computer-use', {
    description: 'Show Computer Use availability, or reset its JavaScript session with /computer-use reset',
    handler: async (args, ctx) => {
      const notify = (message: string, type: 'info' | 'warning' = 'info'): void => {
        if (ctx.hasUI) ctx.ui.notify(message, type);
        else pi.sendMessage({ customType: 'computer-use-status', content: message, display: true });
      };
      if (args.trim() === 'reset') {
        await session.close();
        notify('Computer Use session reset. The next call starts a fresh runtime.');
        return;
      }
      if (args.trim()) {
        notify('Usage: /computer-use [reset]', 'warning');
        return;
      }
      const current = detect();
      notify(current.available
        ? `Computer Use ${session.connected ? 'connected' : current.mode === 'ssh' ? 'configured (remote availability checked on first call)' : 'ready'}\n${current.mode === 'ssh' ? `SSH: ${current.destination}` : `Local companion: ${current.companionApp}`}\nRuntime: ${current.chatgptApp}${installation.available ? '' : '\nRun /reload to expose the tools.'}`
        : current.reason);
    },
  });

  // Disabled collection installs stay quiet and expose no unusable agent tools.
  if (!installation.available) return;

  pi.registerTool({
    name: 'computer_use',
    label: 'Computer Use',
    description: 'Use macOS apps locally or over configured SSH through the installed OpenAI Computer Use Companion. Executes JavaScript in a persistent signed runtime with the initialized cua API. Start with await cua.getState() for inventory or var app = await cua.getApp("Calculator") for an app; these calls return the API documentation and UI state. Follow the returned API documentation. Use nodeRepl.write(value) for additional text and await nodeRepl.emitImage(image) for additional images; the cua APIs already emit their state. Variables persist across calls. After compaction call await cua.rewriteDocumentation(). Run calls sequentially and refresh app state after actions. These are ordinary Pi tools with automatic session-only app consent and no Pi approval prompts.',
    parameters: Type.Object({
      code: Type.String({ minLength: 1, description: 'JavaScript using the initialized cua API.' }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Short description of this action.' })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000, description: 'JavaScript execution timeout; defaults to 30000.' })),
    }),
    async execute(_id, args, signal) { return present(await session.execute(args, signal)); },
  });
  pi.registerTool({
    name: 'computer_use_reset',
    label: 'Reset Computer Use',
    description: 'Reset the persistent Computer Use runtime and its JavaScript variables. The next computer_use call starts fresh. Apps remain open and their state is preserved.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      signal?.throwIfAborted();
      await session.close();
      return { content: [{ type: 'text', text: 'Computer Use session reset. JavaScript variables were discarded; app state is preserved.' }], details: {} };
    },
  });

  pi.on('session_start', async () => { await session.close(); });
  pi.on('session_tree', async () => { await session.close(); });
  pi.on('agent_start', () => { turnId = randomUUID(); });
  pi.on('agent_end', async (_event, ctx) => { await session.endTurn(ctx.sessionManager.getSessionId(), turnId); });
  pi.on('session_shutdown', async () => { await session.close(); });
}

export default function computerUse(pi: ExtensionAPI): void { registerComputerUse(pi); }
