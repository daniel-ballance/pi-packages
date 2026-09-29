import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfig, MODERN } from '../extensions/mcp-client/src/config.js';
import { connect } from '../extensions/mcp-client/src/connection.js';

// The network is mocked, but configuration, environment expansion, negotiation,
// HTTP headers, response parsing and tool calls use the production client.
test('Context7 remote HTTPS config sends the API-key header on every MCP request', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'context7-config-'));
  const previous = process.env.PI_CONTEXT7_TEST_API_KEY;
  process.env.PI_CONTEXT7_TEST_API_KEY = 'fixture-only-key';
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    assert.equal(String(url), 'https://mcp.context7.com/mcp');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-only-key');
    const message = JSON.parse(String(init.body));
    methods.push(message.method);
    let result;
    switch (message.method) {
      case 'server/discover':
        result = { supportedVersions: [MODERN], capabilities: { tools: {} } };
        break;
      case 'tools/list':
        result = {
          tools: [
            { name: 'resolve-library-id', inputSchema: { type: 'object' } },
            { name: 'query-docs', inputSchema: { type: 'object' } },
          ],
        };
        break;
      case 'tools/call':
        assert.equal(message.params.name, 'resolve-library-id');
        assert.deepEqual(message.params.arguments, {
          libraryName: 'Node.js',
          query: 'fs.readFile',
        });
        result = { content: [{ type: 'text', text: 'Fixture library documentation' }] };
        break;
      default:
        assert.fail(`Unexpected method: ${message.method}`);
    }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { resultType: 'complete', ...result },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  let peer;
  try {
    const path = join(dir, 'mcp.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          context7: {
            type: 'http',
            url: 'https://mcp.context7.com/mcp',
            headers: { Authorization: 'Bearer ${PI_CONTEXT7_TEST_API_KEY}' },
          },
        },
      }),
    );
    const config = resolveConfig((await loadConfig([path])).context7, dir);
    assert.equal(config.protocol, 'auto');
    peer = await connect(
      config,
      {},
      () => {},
      () => ({}),
    );
    assert.equal(peer.version, MODERN);
    assert.deepEqual(
      (await peer.list('tools/list', 'tools')).map((tool) => tool.name),
      ['resolve-library-id', 'query-docs'],
    );
    const result = await peer.request('tools/call', {
      name: 'resolve-library-id',
      arguments: { libraryName: 'Node.js', query: 'fs.readFile' },
    });
    assert.equal(result.content[0].text, 'Fixture library documentation');
    assert.deepEqual(methods, ['server/discover', 'tools/list', 'tools/call']);
  } finally {
    await peer?.close();
    if (previous === undefined) delete process.env.PI_CONTEXT7_TEST_API_KEY;
    else process.env.PI_CONTEXT7_TEST_API_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
