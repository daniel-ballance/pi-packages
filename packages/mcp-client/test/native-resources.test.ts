import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerNativeResources } from '../extensions/mcp-client/src/native-resources.js';
import type { Peer } from '../extensions/mcp-client/src/peer.js';

for (const [name, key] of [
  ['list_mcp_resources', 'resources'],
  ['list_mcp_resource_templates', 'resourceTemplates'],
] as const) {
  test(`${name} preserves string cursors and rejects malformed pagination`, async () => {
    const tools = new Map<string, any>();
    let nextCursor: unknown;
    const peer = {
      capabilities: { resources: {} },
      request: async () => ({ [key]: [], nextCursor }),
    } as unknown as Peer;
    registerNativeResources(
      (tool) => tools.set(tool.name, tool),
      () => ['fixture'],
      () => ({ peer }),
    );
    const execute = () => tools.get(name).execute('page', { server: 'fixture' });

    for (nextCursor of [undefined, '', 'next-page']) {
      assert.deepEqual((await execute()).structuredContent, {
        server: 'fixture',
        [key]: [],
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    }
    for (nextCursor of [null, 1, false, {}, []]) {
      await assert.rejects(execute(), /Invalid MCP resource pagination cursor/);
    }
  });
}
