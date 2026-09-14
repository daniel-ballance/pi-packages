import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect } from '../src/connection.js';
import { ServerSchema, MODERN, LEGACY } from '../src/config.js';
import { Peer, RpcError } from '../src/peer.js';
import { ModernHttp } from '../src/http.js';

for (const version of [MODERN, ...LEGACY])
  test(`real stdio negotiates ${version}`, async () => {
    const config = ServerSchema.parse({
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), version],
      timeout: 3000,
    });
    const peer = await connect(
      config,
      {},
      () => {},
      () => ({}),
    );
    try {
      assert.equal(peer.version, version);
      assert.equal((await peer.list('tools/list', 'tools'))[0].name, 'echo');
      assert.equal(
        (await peer.request('tools/call', { name: 'echo', arguments: { text: 'hello' } }))
          .content[0].text,
        'hello',
      );
    } finally {
      await peer.close();
    }
  });

test('2026 HTTP supports JSON, fragmented SSE, mirrored headers, and cancellation', async () => {
  let cancelled: () => void;
  const disconnected = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const message = JSON.parse(text);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['mcp-protocol-version'], MODERN);
    assert.equal(req.headers['mcp-method'], message.method);
    assert.equal(req.headers['mcp-session-id'], undefined);
    const result = {
      jsonrpc: '2.0',
      id: message.id,
      result: { resultType: 'complete', content: [] },
    };
    if (message.method === 'tools/call') {
      assert.equal(req.headers['mcp-name'], '=?base64?5LiW55WM?=');
      assert.equal(req.headers['mcp-param-region'], 'eu');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = `: keepalive\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress: 1 } })}\r\n\r\ndata: ${JSON.stringify(result)}\r\n\r\n`;
      for (let i = 0; i < event.length; i += 7) res.write(event.slice(i, i + 7));
      res.end();
    } else if (message.method === 'subscriptions/listen') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ready\n\n');
      res.on('close', () => cancelled());
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  const peer = new Peer(
    new ModernHttp(url, { 'Mcp-Session-Id': 'forbidden' }, () => ({ 'Mcp-Param-Region': 'eu' })),
    {},
  );
  await peer.start();
  try {
    await peer.request('resources/list');
    let progress = 0;
    await peer.request(
      'tools/call',
      { name: '世界' },
      {
        progress: (p) => {
          progress = p.progress;
        },
      },
    );
    assert.equal(progress, 1);
    const abort = new AbortController();
    const result = peer.raw('subscriptions/listen', {}, { signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await assert.rejects(result);
    await disconnected;
  } finally {
    await peer.close();
    server.closeAllConnections();
    server.close();
  }
});

test('recognized modern errors do not downgrade to legacy initialization', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const m = JSON.parse(text);
    requests++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        error: {
          code: -32022,
          message: 'Unsupported version',
          data: { supported: ['2099-01-01'], requested: MODERN },
        },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const config = ServerSchema.parse({
      transport: 'http',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
    });
    await assert.rejects(
      connect(
        config,
        {},
        () => {},
        () => ({}),
      ),
      (e: unknown) => e instanceof RpcError && e.code === -32022,
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
