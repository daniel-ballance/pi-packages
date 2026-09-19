import { createInterface } from 'node:readline';
const version = process.argv[2];
let initialized = false;
const respond = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) {
    if (m.method === 'notifications/initialized') initialized = true;
    continue;
  }
  if (version === '2026-07-28') {
    if (m.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== version) process.exit(2);
    if (m.method === 'server/discover')
      respond(m.id, {
        resultType: 'complete',
        supportedVersions: [version],
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
    else if (m.method === 'tools/list')
      respond(m.id, {
        resultType: 'complete',
        tools: [
          {
            name: 'echo',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      });
    else
      respond(m.id, {
        resultType: 'complete',
        content: [{ type: 'text', text: m.params.arguments.text }],
      });
  } else if (m.method === 'initialize')
    respond(m.id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    });
  else if (!initialized)
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        error: { code: -32602, message: 'Not initialized' },
      }) + '\n',
    );
  else if (m.method === 'tools/list')
    respond(m.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
  else respond(m.id, { content: [{ type: 'text', text: m.params.arguments.text }] });
}
