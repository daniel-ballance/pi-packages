// Offline, deterministic server for manual tmux QA. Optional mode file: slow / rejected.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const pending = new Map();
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = () => {
  try {
    return readFileSync(process.argv[2], 'utf8').trim();
  } catch {
    return '';
  }
};
async function handle(m) {
  if (m.method === undefined) {
    const call = pending.get(m.id);
    if (call !== undefined) {
      pending.delete(m.id);
      result(call, {
        content: [{ type: 'text', text: `Form response: ${JSON.stringify(m.result)}` }],
      });
    }
    return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    if (mode() === 'slow') await delay(5000);
    result(m.id, {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'Offline UX fixture', version: '1' },
      capabilities: { tools: {}, prompts: {}, resources: { subscribe: true } },
    });
  } else if (m.method === 'tools/list') {
    if (mode() === 'slow') await delay(5000);
    result(m.id, {
      tools: [
        {
          name: 'slow_preview',
          description: 'Offline preview with delayed progress.',
          inputSchema: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              enabled: { type: 'boolean' },
              options: {
                type: 'object',
                properties: {
                  token: { type: 'string', writeOnly: true },
                  count: { type: 'integer' },
                },
              },
            },
            required: ['target'],
          },
        },
        {
          name: 'ask_form',
          description: 'Request non-sensitive fixture preferences.',
          inputSchema: { type: 'object' },
        },
        {
          name: 'fail',
          description: 'Return a fixture RPC error.',
          inputSchema: { type: 'object' },
        },
        ...(mode() === 'rejected'
          ? [{ name: 'broken', inputSchema: { $ref: 'https://invalid.example/schema' } }]
          : []),
      ],
    });
  } else if (m.method === 'tools/call') {
    if (m.params.name === 'ask_form') {
      const id = `form-${m.id}`;
      pending.set(id, m.id);
      send({
        id,
        method: 'elicitation/create',
        params: {
          message: 'Choose demo preferences (local fixture only).',
          requestedSchema: {
            type: 'object',
            properties: {
              count: { title: 'Number of previews', type: 'integer', minimum: 1, maximum: 3 },
              style: { title: 'Preview style', type: 'string', enum: ['compact', 'detailed'] },
              enabled: { title: 'Enable preview', type: 'boolean' },
              note: { title: 'Optional note', type: 'string', maxLength: 60 },
            },
            required: ['count', 'style', 'enabled'],
          },
        },
      });
    } else if (m.params.name === 'fail') {
      send({
        id: m.id,
        error: { code: -32603, message: 'Fixture failure; no external operation was performed.' },
      });
    } else {
      await delay(3000);
      send({
        method: 'notifications/progress',
        params: {
          progressToken: m.params._meta.progressToken,
          progress: 1,
          total: 2,
          message: 'Reading local fixture data',
        },
      });
      await delay(5000);
      result(m.id, {
        content: [{ type: 'text', text: 'Preview complete. No files were changed.' }],
      });
    }
  } else if (m.method === 'prompts/list') {
    result(m.id, {
      prompts: [
        {
          name: 'review',
          description: 'Offline review reference',
          arguments: [
            { name: 'language', description: 'Language to review', required: true },
            { name: 'focus', description: 'Optional focus area' },
          ],
        },
      ],
    });
  } else if (m.method === 'prompts/get') {
    result(m.id, {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review reference: ${JSON.stringify(m.params.arguments)}`,
          },
        },
      ],
    });
  } else if (m.method === 'resources/list') {
    result(m.id, { resources: [{ uri: 'fixture:notes', name: 'Demo notes' }] });
  } else if (m.method === 'resources/subscribe' || m.method === 'resources/unsubscribe')
    result(m.id, {});
  else send({ id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } });
}
for await (const line of createInterface({ input: process.stdin })) void handle(JSON.parse(line));
