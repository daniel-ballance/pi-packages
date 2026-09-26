import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let request,
  replied = false;
const finish = () => {
  if (request && replied) send({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (Array.isArray(message)) {
    if (message.length !== 2 || message.some((m) => ![101, 102].includes(m.id) || !m.result))
      process.exit(3);
    replied = true;
    finish();
  } else if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'batch', version: '1' },
      },
    });
  } else if (message.method === 'notifications/initialized') {
    send([
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
      { jsonrpc: '2.0', method: 'ping', id: 101 },
      { jsonrpc: '2.0', method: 'ping', id: 102 },
    ]);
  } else if (message.method === 'tools/list') {
    request = message;
    finish();
  }
}
