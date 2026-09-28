import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const modePath = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const mode = readFileSync(modePath, 'utf8');
  const send = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  if (m.method === 'server/discover') {
    send({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
    });
  } else if (m.method === 'tools/list') {
    if (mode === 'discovery-error') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32603, message: 'fixture discovery failure' },
        }) + '\n',
      );
    } else {
      send({
        resultType: 'complete',
        tools: [
          ...(mode === 'rejected'
            ? [{ name: 'invalid', inputSchema: { $ref: 'https://example.invalid/schema' } }]
            : []),
          {
            name: 'echo',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      });
    }
  } else if (m.method === 'tools/call') {
    if (mode === 'disconnect') process.exit(0);
    send({
      resultType: 'complete',
      isError: mode === 'tool-error',
      content: [{ type: 'text', text: 'fixture response' }],
    });
  }
}
