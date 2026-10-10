import { createInterface } from 'node:readline';

const results = {
  structured: { structuredContent: { value: 4 } },
  legacyTask: { resultType: 'task', structuredContent: { value: 4 } },
  invalidLegacyTask: { resultType: 'task', structuredContent: { value: 'not-a-number' } },
  empty: {},
  pid: { structuredContent: { pid: process.pid } },
  pending: {},
  invalid: { content: null },
  malformed: { structuredContent: ['not-an-object'] },
  error: { isError: true, structuredContent: { reason: 'fixture decline' } },
  image: {
    content: [
      { type: 'text', text: 'fixture image' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      },
    ],
  },
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize')
    result = {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'result-shapes', version: '1' },
      capabilities: { tools: {} },
    };
  else if (request.method === 'tools/list')
    result = {
      tools: Object.keys(results).map((name) => ({
        name,
        inputSchema: { type: 'object' },
        ...(['structured', 'legacyTask', 'invalidLegacyTask'].includes(name)
          ? {
              outputSchema: {
                type: 'object',
                properties: { value: { type: 'number' } },
                required: ['value'],
              },
            }
          : {}),
      })),
    };
  else if (request.method === 'tools/call') {
    if (request.params.name === 'pending') continue;
    result = results[request.params.name];
  } else result = {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
