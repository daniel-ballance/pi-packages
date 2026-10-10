import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
let waiting;
const image = {
  type: 'image',
  mimeType: 'image/png',
  data: readFileSync(new URL('./native-fixture.png', import.meta.url)).toString('base64'),
};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === 'approval' && request.error) {
    send({
      jsonrpc: '2.0',
      id: waiting,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Fixture elicitation rejected: ' + request.error.message }],
      },
    });
    continue;
  }
  if (request.id === 'approval' && request.result) {
    send({
      jsonrpc: '2.0',
      id: waiting,
      result: {
        content: [{ type: 'text', text: 'fixture approved result' }, image],
        structuredContent: {
          action: request.result.action,
          persistence: request.result._meta?.persist,
          source: request.result.content?.source,
        },
        _meta: { privateFixture: true },
      },
    });
    continue;
  }
  if (request.id === undefined) continue;
  if (request.method === 'resources/unsubscribe' && process.argv[2]) {
    writeFileSync(process.argv[2], 'waiting');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (request.method === 'initialize')
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'native-fixture', version: '1' },
        capabilities: { tools: {}, resources: { subscribe: true } },
      },
    });
  else if (request.method === 'tools/list')
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'approve',
            description: 'Fixture approval',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'hidden',
            description: 'Must never be callable',
            inputSchema: { type: 'object' },
          },
          { name: 'error', inputSchema: { type: 'object' } },
        ],
      },
    });
  else if (request.method === 'tools/call') {
    if (request.params.name === 'approve') {
      waiting = request.id;
      send({
        jsonrpc: '2.0',
        id: 'approval',
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Fixture Calculator permission (no Mac connection)',
          requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            connector_id: 'computer-use',
            connector_name: 'Computer Use',
            progressToken: 0,
            persist: ['session', 'always'],
            riskLevel: 'low',
            tool_name: 'get_app_state',
            tool_params: { app: 'com.apple.calculator' },
            tool_params_display: [{ display_name: 'App', name: 'app', value: 'Calculator' }],
          },
        },
      });
    } else
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { isError: true, content: [{ type: 'text', text: 'fixture-error' }] },
      });
  } else if (request.method === 'resources/list')
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resources: [
          { uri: 'fixture://image', name: 'image' },
          { uri: 'ui://hidden-app', name: 'not supported' },
        ],
      },
    });
  else if (request.method === 'resources/read')
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        contents: [{ uri: request.params.uri, mimeType: image.mimeType, blob: image.data }],
      },
    });
  else if (request.method === 'resources/templates/list')
    send({ jsonrpc: '2.0', id: request.id, result: { resourceTemplates: [] } });
  else send({ jsonrpc: '2.0', id: request.id, result: {} });
}
