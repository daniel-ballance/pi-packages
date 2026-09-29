import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect } from '../extensions/mcp-client/src/connection.js';
import { ServerSchema } from '../extensions/mcp-client/src/config.js';

for (const [kind, protocol] of [
  ['http', '2025-11-25'],
  ['http', 'auto'],
  ['sse', 'auto'],
] as const)
  test(`legacy ${kind} (${protocol}) interoperates with official SDK server`, async () => {
    const mcp = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => ({
      content: [{ type: 'text', text: String(r.params.arguments?.text) }],
    }));
    let transport: StreamableHTTPServerTransport | SSEServerTransport | undefined;
    const server = createServer(async (req, res) => {
      try {
        if (kind === 'http') {
          transport ??= new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
          if (!mcp.transport) await mcp.connect(transport);
          await (transport as StreamableHTTPServerTransport).handleRequest(req, res);
        } else if (req.method === 'GET') {
          transport = new SSEServerTransport('/messages', res);
          await mcp.connect(transport);
        } else await (transport as SSEServerTransport).handlePostMessage(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = ServerSchema.parse({
      transport: kind,
      protocol,
      url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
      timeout: 3000,
    });
    let peer;
    try {
      peer = await connect(
        config,
        {},
        () => {},
        () => ({}),
      );
      assert.equal((await peer.list('tools/list', 'tools'))[0].name, 'echo');
      assert.equal(
        (await peer.request('tools/call', { name: 'echo', arguments: { text: 'over HTTP' } }))
          .content[0].text,
        'over HTTP',
      );
    } finally {
      await peer?.close();
      await mcp.close();
      server.closeAllConnections();
      server.close();
    }
  });
