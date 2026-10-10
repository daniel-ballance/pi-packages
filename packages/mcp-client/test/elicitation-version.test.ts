import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODERN, ServerSchema } from '../extensions/mcp-client/src/config.js';
import { inputHandler } from '../extensions/mcp-client/src/input.js';
import { Peer } from '../extensions/mcp-client/src/peer.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const config = ServerSchema.parse({
  transport: 'stdio',
  command: 'unused',
  protocol: 'auto',
  elicitationUrl: true,
});
const params = { mode: 'url', message: 'Fixture consent', url: 'https://example.invalid/approve' };

for (const version of ['2025-11-25', MODERN]) {
  test(`${version} URL elicitation uses negotiated revision, not auto config`, async () => {
    const opened: string[] = [];
    let prompts = 0;
    const ctx: any = {
      hasUI: true,
      ui: {
        select: async () => {
          prompts++;
          return 'Open URL';
        },
      },
    };
    const handle = inputHandler(
      'fixture',
      config,
      ctx,
      undefined,
      async (url) => {
        opened.push(url);
      },
      () => version,
    );
    if (version === MODERN) {
      assert.deepEqual(await handle('elicitation/create', params), { action: 'accept' });
    } else {
      await assert.rejects(handle('elicitation/create', params), /Invalid URL elicitation/);
      assert.equal(prompts, 0);
      assert.deepEqual(
        await handle('elicitation/create', { ...params, elicitationId: 'legacy-id' }),
        { action: 'accept' },
      );
    }
    assert.equal(prompts, 1);
    assert.deepEqual(opened, [params.url]);
  });
}

test('Current URL MRTR sends consent on a new request with opaque state and no legacy id', async () => {
  const sent: JSONRPCMessage[] = [];
  let opened = 0;
  const transport: Transport = {
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send(message) {
      sent.push(message);
      if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)) return;
      const inputResponses = message.params?.inputResponses as any;
      if (!inputResponses) {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'input_required',
            requestState: 'opaque-url-state',
            inputRequests: { u: { method: 'elicitation/create', params } },
          },
        });
      } else {
        assert.deepEqual(inputResponses.u, { action: 'accept' });
        assert.equal(message.params?.requestState, 'opaque-url-state');
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            content: [{ type: 'text', text: 'fixture complete' }],
          },
        });
      }
    },
  };
  const peer = new Peer(transport, { elicitation: { url: {} } });
  peer.oninput = inputHandler(
    'fixture',
    config,
    {
      hasUI: true,
      ui: { select: async () => 'Open URL' },
    } as any,
    undefined,
    async () => {
      opened++;
    },
    () => peer.version,
  );
  await peer.start();
  try {
    const result = await peer.request('tools/call', { name: 'fixture' });
    assert.equal(result.content[0].text, 'fixture complete');
    assert.equal(opened, 1);
    assert.equal(sent.length, 2);
    assert.notEqual((sent[0] as any).id, (sent[1] as any).id);
  } finally {
    await peer.close();
  }
});
