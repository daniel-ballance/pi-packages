import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfig } from '../extensions/mcp-client/src/config.js';

async function load(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-format-'));
  try {
    const path = join(dir, 'mcp.json');
    await writeFile(path, JSON.stringify(value));
    return await loadConfig([path]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Claude-style mcpServers accepts implicit/explicit stdio, HTTP, its alias and SSE', async () => {
  const config = await load({
    mcpServers: {
      local: { command: 'npx', args: ['-y', 'example'], env: { TOKEN: '${TOKEN}' } },
      explicit: { type: 'stdio', command: 'node', cwd: './server' },
      remote: {
        type: 'http',
        url: 'https://example.invalid/mcp',
        headers: { X: 'y' },
        toolLoading: 'deferred',
      },
      alias: {
        type: 'streamable-http',
        url: 'https://example.invalid/mcp',
        oauth: { clientId: 'example', callbackPort: 12345 },
      },
      sse: { type: 'sse', url: 'https://example.invalid/sse' },
    },
  });
  assert.equal(config.local.transport, 'stdio');
  assert.deepEqual((config.local as any).args, ['-y', 'example']);
  assert.deepEqual((config.local as any).env, { TOKEN: '${TOKEN}' });
  assert.equal(config.explicit.transport, 'stdio');
  assert.equal(config.remote.transport, 'http');
  assert.equal(config.remote.toolLoading, 'deferred');
  assert.deepEqual((config.remote as any).headers, { X: 'y' });
  assert.equal(config.alias.transport, 'http');
  assert.equal((config.alias as any).oauth.redirectPort, 12345);
  assert.equal(config.sse.transport, 'sse');
});

test('old format, mixed formats, ambiguous HTTP and unknown fields fail closed', async () => {
  for (const value of [
    { servers: {} },
    { servers: {}, mcpServers: {} },
    { mcpServers: { bad: { transport: 'stdio', command: 'node' } } },
    { mcpServers: { bad: { type: 'http', command: 'node', url: 'https://example.invalid' } } },
    { mcpServers: { bad: { url: 'https://example.invalid' } } },
    { mcpServers: { bad: { type: 'typo', command: 'node' } } },
    { mcpServers: { bad: { command: 'node', typo: true } } },
    {
      mcpServers: {
        bad: { type: 'http', url: 'https://example.invalid', oauth: { redirectPort: 12345 } },
      },
    },
  ])
    await assert.rejects(load(value), /Invalid MCP configuration/);
});

test('canonical diagnostics identify fields without exposing values', async () => {
  await assert.rejects(
    load({ mcpServers: { bad: { type: 'http', url: 'secret-credential' } } }),
    (error: Error) =>
      /mcpServers.bad.url/.test(error.message) && !error.message.includes('secret-credential'),
  );
});

test('Claude-style environment defaults expand without shell evaluation', async () => {
  delete process.env.PI_MCP_FORMAT_TEST_UNSET;
  const config = await load({
    mcpServers: {
      local: { command: 'node', args: ['${PI_MCP_FORMAT_TEST_UNSET:-literal $(echo nope)}'] },
      remote: { type: 'http', url: '${PI_MCP_FORMAT_TEST_UNSET:-https://example.invalid/mcp}' },
    },
  });
  assert.deepEqual((resolveConfig(config.local, '/tmp') as any).args, ['literal $(echo nope)']);
  assert.equal((resolveConfig(config.remote, '/tmp') as any).url, 'https://example.invalid/mcp');
});
