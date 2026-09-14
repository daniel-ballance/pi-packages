import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfig, ServerSchema } from '../src/config.js';

test('config merging replaces named servers and validates strictly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-config-'));
  try {
    const global = join(dir, 'global.json'),
      project = join(dir, 'project.json');
    await writeFile(
      global,
      JSON.stringify({
        servers: {
          same: { transport: 'stdio', command: 'global', env: { SECRET: 'not inherited' } },
        },
      }),
    );
    await writeFile(
      project,
      JSON.stringify({
        servers: { same: { transport: 'stdio', command: 'project', disabled: true } },
      }),
    );
    const config = await loadConfig([join(dir, 'missing.json'), global, project]);
    assert.equal((config.same as any).command, 'project');
    assert.deepEqual((config.same as any).env, {});
    assert.equal(config.same.disabled, true);
    await writeFile(project, '{"servers":{},"typo":true}');
    await assert.rejects(loadConfig([global, project]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('environment expansion supports whole URLs and fails closed on missing variables', () => {
  process.env.MCP_TEST_URL = 'https://example.invalid/mcp';
  try {
    const config = ServerSchema.parse({ transport: 'http', url: '${MCP_TEST_URL}' });
    assert.equal((resolveConfig(config, '/tmp') as any).url, process.env.MCP_TEST_URL);
    delete process.env.MCP_TEST_URL;
    assert.throws(() => resolveConfig(config, '/tmp'), /Missing environment/);
    process.env.MCP_TEST_URL = 'file:///etc/passwd';
    assert.throws(() => resolveConfig(config, '/tmp'), /HTTP/);
    assert.throws(() =>
      ServerSchema.parse({ transport: 'http', url: 'https://user:secret@example.invalid' }),
    );
  } finally {
    delete process.env.MCP_TEST_URL;
  }
});
