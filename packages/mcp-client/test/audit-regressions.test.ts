import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, rm } from 'node:fs/promises';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Peer } from '../extensions/mcp-client/src/peer.js';
import { serializeConversation } from '@earendil-works/pi-coding-agent';
import { connect } from '../extensions/mcp-client/src/connection.js';
import { ServerSchema, MODERN } from '../extensions/mcp-client/src/config.js';
import { present, boundedError } from '../extensions/mcp-client/src/content.js';
import { inputHandler } from '../extensions/mcp-client/src/input.js';
import { validator } from '../extensions/mcp-client/src/validation.js';
import { boundedFetch } from '../extensions/mcp-client/src/limits.js';
import { TASKS, waitForTask, type SavedTask } from '../extensions/mcp-client/src/tasks.js';
import { ModernHttp } from '../extensions/mcp-client/src/http.js';
import { encodeHeader } from '../extensions/mcp-client/src/headers.js';

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (url: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as any).port}/mcp`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function message(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}
function reply(res: ServerResponse, id: number, result: unknown, session?: string) {
  res.writeHead(200, {
    'content-type': 'application/json',
    ...(session ? { 'mcp-session-id': session } : {}),
  });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
const init = (res: ServerResponse, id: number, session = 'session') =>
  reply(
    res,
    id,
    {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'test', version: '1' },
    },
    session,
  );
const connectTo = (url: string, timeout = 2000) =>
  connect(
    ServerSchema.parse({ transport: 'http', url, protocol: '2025-11-25', timeout }),
    {},
    () => {},
    () => ({}),
  );

class Wire implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  sent: any[] = [];
  handle: (message: any) => void = () => {};
  async start() {}
  async close() {
    this.onclose?.();
  }
  async send(message: any) {
    this.sent.push(message);
    this.handle(message);
  }
  reply(id: number, result: any) {
    this.onmessage?.({ jsonrpc: '2.0', id, result });
  }
}

test('legacy session 404 initializes anew, never replays the failed call, and DELETEs on shutdown', async () => {
  let initialized = 0,
    calls = 0,
    deleted = false;
  await serve(
    async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'DELETE') {
        deleted = true;
        res.writeHead(200).end();
        return;
      }
      const m = await message(req);
      if (m.method === 'initialize') init(res, m.id, `session-${++initialized}`);
      else if (m.method === 'notifications/initialized') res.writeHead(202).end();
      else if (m.method === 'tools/call') {
        calls++;
        if (calls === 1) res.writeHead(404).end('expired');
        else reply(res, m.id, { content: [{ type: 'text', text: 'ok' }] });
      }
    },
    async (url) => {
      const peer = await connectTo(url);
      try {
        await assert.rejects(peer.request('tools/call', { name: 'mutate' }), /not replayed/);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(initialized, 2);
        assert.equal(calls, 1);
        assert.equal((await peer.request('tools/call', { name: 'next' })).content[0].text, 'ok');
      } finally {
        await peer.close();
      }
      assert.equal(deleted, true);
    },
  );
});

test('one deadline covers initialized notification, not just initialize response', async () => {
  await serve(
    async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      const m = await message(req);
      if (m.method === 'initialize') init(res, m.id);
      // Deliberately hang notifications/initialized.
    },
    async (url) => {
      const started = Date.now();
      await assert.rejects(connectTo(url, 100), /timed out/);
      assert.ok(Date.now() - started < 500);
    },
  );
});

test('initialize timeout never sends forbidden cancellation', async () => {
  const wire = new Wire(),
    peer = new Peer(wire, {}, 100);
  peer.version = '2025-11-25';
  await peer.start();
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(peer.raw('initialize'));
    assert.deepEqual(
      wire.sent.map((m) => m.method),
      ['initialize'],
    );
  } finally {
    clearTimeout(keepAlive);
    await peer.close();
  }
});

test('legacy JSON and fragmented Unicode SSE have real byte limits', async () => {
  for (const sse of [false, true])
    await serve(
      async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(405).end();
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        const m = await message(req);
        if (m.method === 'initialize') {
          init(res, m.id);
          return;
        }
        if (m.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
        if (sse) res.write('data: ');
        res.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            result: { content: [{ type: 'text', text: '世'.repeat(4 * 1024 * 1024) }] },
          }),
        );
        res.end(sse ? '\n\n' : '');
      },
      async (url) => {
        const peer = await connectTo(url);
        try {
          await assert.rejects(
            peer.request('tools/call', { name: 'large' }),
            /10 MiB|timed out|aborted/i,
          );
        } finally {
          await peer.close();
        }
      },
    );
});

test('SSE limits are per event, not a lifetime limit on healthy subscriptions', async () => {
  await serve(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 12; i++) res.write('data: ' + 'x'.repeat(1024 * 1024) + '\r\n\r\n');
      res.end();
    },
    async (url) => assert.ok((await (await boundedFetch(url)).text()).length > 10 * 1024 * 1024),
  );
});

test('opaque empty cursor, cache TTL and catalog budgets', async () => {
  const wire = new Wire(),
    peer = new Peer(wire, {});
  await peer.start();
  wire.handle = (m) =>
    wire.reply(m.id, {
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      tools: [],
      ...(m.params.cursor === undefined ? { nextCursor: '' } : {}),
    });
  try {
    assert.deepEqual(await peer.list('tools/list', 'tools'), []);
    assert.equal(wire.sent[1].params.cursor, '');
    assert.ok(peer.catalogExpiry.get('tools/list')! <= Date.now());
    wire.handle = (m) =>
      wire.reply(m.id, { resultType: 'complete', tools: Array.from({ length: 2001 }, () => ({})) });
    await assert.rejects(peer.list('tools/list', 'tools'), /budget/);
  } finally {
    await peer.close();
  }
});

test('legacy notification/request batches dispatch and produce a single response batch', async () => {
  const wire = new Wire(),
    peer = new Peer(wire, {});
  peer.version = '2025-03-26';
  await peer.start();
  let notifications = 0;
  peer.onnotification = () => notifications++;
  wire.onmessage?.([
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    { jsonrpc: '2.0', id: 20, method: 'ping' },
    { jsonrpc: '2.0', id: 21, method: 'ping' },
  ] as any);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications, 1);
  assert.deepEqual(wire.sent, [
    [
      { jsonrpc: '2.0', id: 20, result: {} },
      { jsonrpc: '2.0', id: 21, result: {} },
    ],
  ]);
  await peer.close();
});

test('real 2025-03-26 stdio batch framing interoperates end to end', async () => {
  let notifications = 0;
  const peer = await connect(
    ServerSchema.parse({
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/batch-server.mjs', import.meta.url))],
      protocol: '2025-03-26',
      timeout: 1000,
    }),
    {},
    (peer) => {
      peer.onnotification = () => notifications++;
    },
    () => ({}),
  );
  try {
    assert.deepEqual(await peer.list('tools/list', 'tools'), []);
    assert.equal(notifications, 1);
  } finally {
    await peer.close();
  }
});

for (const mode of ['json', 'sse', 'original-sse'])
  test(`2025-03-26 HTTP batches preserve request boundaries (${mode})`, async () => {
    let responseStream: ServerResponse | undefined,
      batchReplies = 0,
      notifications = 0;
    await serve(
      async (req, res) => {
        if (req.method === 'GET') {
          if (mode !== 'original-sse') {
            res.writeHead(405).end();
            return;
          }
          responseStream = res;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: endpoint\ndata: /messages\n\n');
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        const m = await message(req);
        if (Array.isArray(m)) {
          assert.deepEqual(m.map((r) => r.id).sort(), [101, 102]);
          batchReplies++;
          res.writeHead(202).end();
          return;
        }
        if (m.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const response =
          m.method === 'initialize'
            ? {
                jsonrpc: '2.0',
                id: m.id,
                result: {
                  protocolVersion: '2025-03-26',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'batch', version: '1' },
                },
              }
            : [
                { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
                { jsonrpc: '2.0', id: 101, method: 'ping' },
                { jsonrpc: '2.0', id: 102, method: 'ping' },
                { jsonrpc: '2.0', id: m.id, result: { tools: [] } },
              ];
        if (mode === 'original-sse') {
          responseStream!.write(`data: ${JSON.stringify(response)}\n\n`);
          res.writeHead(202).end();
        } else if (mode === 'sse' && m.method !== 'initialize') {
          res
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(`id: batch\ndata: ${JSON.stringify(response)}\n\n`);
        } else
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
      },
      async (url) => {
        const peer = await connect(
          ServerSchema.parse({
            transport: mode === 'original-sse' ? 'sse' : 'http',
            url,
            protocol: '2025-03-26',
            timeout: 1000,
          }),
          {},
          (peer) => {
            peer.onnotification = () => notifications++;
          },
          () => ({}),
        );
        try {
          assert.deepEqual(await peer.list('tools/list', 'tools'), []);
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(notifications, 1);
          assert.equal(batchReplies, 1);
        } finally {
          await peer.close();
        }
      },
    );
  });

test('content keeps order, prompt images, metadata, deduplicates structured text, and never dumps binary', async () => {
  const raw = {
    content: [
      { type: 'text', text: 'before', annotations: { audience: ['user'] } },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'after' },
    ],
    _meta: { important: true },
  };
  const result = await present(raw);
  assert.deepEqual(
    result.content.map((b) => b.type),
    ['text', 'image', 'text'],
  );
  assert.deepEqual(result.details.raw, raw);
  const prompt = await present({ messages: [{ role: 'user', content: raw.content[1] }] });
  assert.equal(prompt.content.at(-1)?.type, 'image');
  const duplicate = await present({
    content: [{ type: 'text', text: '{"a":1}' }],
    structuredContent: { a: 1 },
  });
  assert.equal(duplicate.content.length, 1);
  const binary = await present({
    content: [{ type: 'audio', data: 'SECRET_BASE64', mimeType: 'audio/wav' }],
  });
  try {
    assert.ok(binary.details.fullOutput);
    assert.ok(!JSON.stringify(binary.content).includes('SECRET_BASE64'));
    assert.match(await readFile(binary.details.fullOutput!, 'utf8'), /SECRET_BASE64/);
  } finally {
    await rm(dirname(binary.details.fullOutput!), { recursive: true, force: true });
  }
});

test('oversized RPC errors are bounded with artifact pointers inside the compaction prefix', async () => {
  const error = await boundedError(
    Object.assign(new Error('e'.repeat(100000)), { code: -32000, data: { full: true } }),
  );
  assert.ok(Buffer.byteLength(error.message) < 50 * 1024);
  const path = error.message.slice(0, 2000).match(/Full MCP result: (.+?\.json)/)![1];
  try {
    assert.equal(JSON.parse(await readFile(path, 'utf8')).data.full, true);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test('artifact references survive native Pi compaction serialization', async () => {
  const result = await present({ content: [{ type: 'text', text: 'first line\n'.repeat(5000) }] });
  try {
    const summary = serializeConversation([
      {
        role: 'toolResult',
        toolCallId: 'audit',
        toolName: 'mcp_audit',
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: 0,
      },
    ]);
    assert.ok(summary.includes(result.details.fullOutput!));
  } finally {
    await rm(dirname(result.details.fullOutput!), { recursive: true, force: true });
  }
});

test('schema acceptance covers root refs, compositions, omitted type and explicit resource budgets', () => {
  for (const schema of [
    { properties: { text: { type: 'string' } } },
    { allOf: [{ type: 'object', properties: { text: { type: 'string' } } }] },
    {
      $ref: '#/$defs/Args',
      $defs: { Args: { type: 'object', properties: { text: { type: 'string' } } } },
    },
  ]) {
    assert.equal(validator(schema)({ text: 'ok' }), true);
    assert.equal(validator(schema)({ text: 1 }), false);
  }
  assert.throws(() => validator({ description: 'x'.repeat(150000) }), /128 KiB/);
});

test('all servers share one dialog queue; URL elicitation validates and requires approval', async () => {
  let concurrent = 0,
    maximum = 0,
    opened = '';
  const config = ServerSchema.parse({
    transport: 'stdio',
    command: 'unused',
    elicitation: true,
    elicitationUrl: true,
  });
  const ctx: any = {
    cwd: '/tmp',
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        maximum = Math.max(maximum, ++concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return options[0] === 'Open URL' ? 'Open URL' : 'Decline';
      },
    },
  };
  await Promise.all(
    ['a', 'b'].map((name) =>
      inputHandler(
        name,
        config,
        ctx,
      )('elicitation/create', { message: 'Approve?', requestedSchema: { type: 'object' } }),
    ),
  );
  assert.equal(maximum, 1);
  const handle = inputHandler('url', config, ctx, undefined, async (url) => {
    opened = url;
  });
  assert.deepEqual(
    await handle('elicitation/create', {
      mode: 'url',
      elicitationId: '1',
      message: 'Login',
      url: 'https://example.com/',
    }),
    { action: 'accept' },
  );
  assert.equal(opened, 'https://example.com/');
  await assert.rejects(
    handle('elicitation/create', {
      mode: 'url',
      elicitationId: '1',
      message: 'Bad',
      url: 'file:///etc/passwd',
    }),
  );
});

test('task handles require negotiation and task HTTP methods carry routing headers', async () => {
  const wire = new Wire(),
    peer = new Peer(wire, {});
  await peer.start();
  wire.handle = (m) =>
    wire.reply(m.id, {
      resultType: 'task',
      taskId: 'one',
      status: 'working',
      createdAt: '',
      lastUpdatedAt: '',
      ttlMs: null,
    });
  try {
    await assert.rejects(peer.request('tools/call'), /unsupported/);
    peer.clientCapabilities.extensions = { [TASKS]: {} };
    peer.capabilities.extensions = { [TASKS]: {} };
    assert.equal((await peer.request('tools/call')).taskId, 'one');
    await assert.rejects(peer.request('resources/read'), /unsupported/);
  } finally {
    await peer.close();
  }
  await serve(
    async (req, res) => {
      const m = await message(req);
      assert.equal(req.headers['mcp-name'], encodeHeader('世界'));
      reply(res, m.id, { resultType: 'complete' });
    },
    async (url) => {
      const peer = new Peer(new ModernHttp(url, {}, () => ({})), {});
      await peer.start();
      try {
        for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel'])
          await peer.request(method, { taskId: '世界' });
      } finally {
        await peer.close();
      }
    },
  );
});

test('task polling deduplicates input, returns the final result, and never repeats tools/call', async () => {
  const wire = new Wire(),
    peer = new Peer(wire, { extensions: { [TASKS]: {} } });
  peer.capabilities = { extensions: { [TASKS]: {} } };
  await peer.start();
  let polls = 0,
    inputs = 0;
  peer.oninput = async () => {
    inputs++;
    return { roots: [] };
  };
  const task: SavedTask = {
    server: 's',
    identity: 'test',
    taskId: 'opaque',
    tool: 'work',
    status: 'working',
    answered: [],
  };
  const base = {
    taskId: 'opaque',
    createdAt: '',
    lastUpdatedAt: '',
    ttlMs: null,
    pollIntervalMs: 0,
  };
  wire.handle = (m) =>
    wire.reply(m.id, {
      resultType: 'complete',
      ...(m.method === 'tasks/get'
        ? {
            ...base,
            ...(++polls < 3
              ? { status: 'input_required', inputRequests: { one: { method: 'roots/list' } } }
              : { status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } }),
          }
        : {}),
    });
  try {
    const result = await waitForTask(peer, task, AbortSignal.timeout(2000), () => {});
    assert.equal(result.content[0].text, 'done');
    assert.equal(inputs, 1);
    assert.equal(wire.sent.filter((m) => m.method === 'tasks/update').length, 1);
    assert.equal(wire.sent.filter((m) => m.method === 'tools/call').length, 0);
  } finally {
    await peer.close();
  }
});
