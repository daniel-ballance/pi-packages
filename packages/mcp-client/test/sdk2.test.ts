import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { factory } from './fixtures/sdk2-server.js';
import { connect } from '../extensions/mcp-client/src/connection.js';
import { ServerSchema, MODERN } from '../extensions/mcp-client/src/config.js';
import {
  headerBindings,
  parameterHeaders,
  type ObjectValue,
} from '../extensions/mcp-client/src/headers.js';

for (const transport of ['stdio', 'http'] as const)
  test(`official SDK 2.0.0: 2026 ${transport}, Unicode headers, MRTR and subscriptions`, async () => {
    const handler = createMcpHandler(factory, { legacy: 'reject' });
    const nodeHandler = toNodeHandler(handler),
      host = localhostHostValidation(),
      origin = localhostOriginValidation();
    const server = createServer((req, res) => {
      if (host(req, res) && origin(req, res)) void nodeHandler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let tools: ObjectValue[] = [];
    const notifications: string[] = [];
    const config = ServerSchema.parse(
      transport === 'stdio'
        ? {
            transport,
            command: process.execPath,
            args: [
              '--import',
              'tsx',
              fileURLToPath(new URL('./fixtures/sdk2-server.ts', import.meta.url)),
              'stdio',
            ],
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            timeout: 3000,
          }
        : {
            transport,
            url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
            timeout: 3000,
          },
    );
    let peer;
    try {
      peer = await connect(
        config,
        { roots: {} },
        (peer) => {
          peer.oninput = async (method) => {
            assert.equal(method, 'roots/list');
            return { roots: [{ uri: 'file:///test' }] };
          };
          peer.onnotification = (method) => notifications.push(method);
        },
        (name, args) =>
          parameterHeaders(
            headerBindings(tools.find((tool) => tool.name === name)?.inputSchema ?? {}),
            args,
          ),
      );
      assert.equal(peer.version, MODERN);
      tools = await peer.list('tools/list', 'tools');
      const result = await peer.request('tools/call', {
        name: 'greet',
        arguments: { name: '世界' },
      });
      assert.equal(result.content[0].text, 'Hello, 世界!');
      const roots = await peer.request('tools/call', { name: 'roots', arguments: {} });
      assert.match(roots.content[0].text, /file:\/\/\/test/);
      const controller = new AbortController();
      const listening = peer
        .raw(
          'subscriptions/listen',
          { notifications: { toolsListChanged: true } },
          { signal: controller.signal },
        )
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(notifications.includes('notifications/subscriptions/acknowledged'));
      if (transport === 'http') {
        await handler.notify.toolsChanged();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(notifications.includes('notifications/tools/list_changed'));
      }
      controller.abort();
      await listening;
    } finally {
      await peer?.close();
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
