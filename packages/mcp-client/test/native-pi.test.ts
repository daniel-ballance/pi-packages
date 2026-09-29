import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Compile } from 'typebox/compile';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import extension, { toolName } from '../extensions/mcp-client/src/index.js';
import { MODERN } from '../extensions/mcp-client/src/config.js';

/** Real Pi lifecycle, session persistence and native deferred loading, without model requests. */
test('native Pi: schemas, deferred tools, commands, TTL freshness, and subscription reload', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-native-'));
  const previousDir = process.env.PI_CODING_AGENT_DIR,
    previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = cwd;
  process.env.PI_OFFLINE = '1';
  let lists = 0,
    wireText = '',
    listens = 0;
  const streams: { res: ServerResponse; id: number }[] = [];
  let rejectSubscription = false;
  const schemas = [
    { type: 'object', properties: { text: { type: 'string' } } },
    { allOf: [{ type: 'object', properties: { text: { type: 'string' } } }] },
    {
      $ref: '#/$defs/Args',
      $defs: { Args: { type: 'object', properties: { text: { type: 'string' } } } },
    },
    { properties: { text: { type: 'string' } } },
  ];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const m = JSON.parse(text);
    if (m.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result: any = { resultType: 'complete' };
    switch (m.method) {
      case 'initialize':
        Object.assign(result, {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'old', version: '1' },
        });
        break;
      case 'completion/complete':
        result.completion = { values: ['legacy'] };
        break;
      case 'server/discover':
        Object.assign(result, {
          supportedVersions: [MODERN],
          capabilities: { tools: {}, prompts: {}, resources: { subscribe: true } },
        });
        break;
      case 'tools/list':
        lists++;
        Object.assign(result, {
          ttlMs: 0,
          cacheScope: 'private',
          tools: schemas.map((inputSchema, index) => ({ name: `tool${index}`, inputSchema })),
        });
        break;
      case 'tools/call':
        result.content = [{ type: 'text', text: m.params.arguments.text }];
        break;
      case 'prompts/get':
        wireText = m.params.arguments.text;
        result.messages = [
          { role: 'user', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
        ];
        break;
      case 'prompts/list':
        result.prompts = [];
        break;
      case 'subscriptions/listen':
        listens++;
        streams.push({ res, id: m.id });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: {
              _meta: { 'io.modelcontextprotocol/subscriptionId': m.id },
              notifications: rejectSubscription ? {} : m.params.notifications,
            },
          })}\n\n`,
        );
        return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await writeFile(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          old: {
            type: 'http',
            protocol: '2024-11-05',
            url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
            timeout: 1000,
          },
          fixture: {
            type: 'http',
            protocol: MODERN,
            url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
            toolLoading: 'deferred',
            timeout: 1000,
          },
        },
      }),
    );
    const settings = SettingsManager.inMemory();
    let api!: ExtensionAPI;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          api = pi;
          extension(pi);
        },
      ],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(cwd),
    }));
    await session.bindExtensions({
      mode: 'print',
      onError: (error) => {
        throw new Error(JSON.stringify(error));
      },
    });
    assert.equal(api.getAllTools().filter((t) => t.name.startsWith('mcp_fixture_')).length, 4);
    assert.equal(api.getActiveTools().filter((name) => name.startsWith('mcp_fixture_')).length, 0);
    const search = session.agent.state.tools.find((tool) => tool.name === 'mcp_search_tools')!;
    await search.execute('load', { query: '', limit: 10 });
    assert.equal(api.getActiveTools().filter((name) => name.startsWith('mcp_fixture_')).length, 4);
    for (let index = 0; index < 4; index++) {
      const tool = api.getAllTools().find((t) => t.name === toolName('fixture', `tool${index}`))!;
      assert.equal(Compile(tool.parameters).Check({ text: 'hello' }), true);
      assert.equal(Compile(tool.parameters).Check({ text: 1 }), false);
      const callable: typeof search = session.agent.state.tools.find(
        (candidate) => candidate.name === tool.name,
      )!;
      assert.ok(callable);
      assert.equal(
        (await callable.execute(`call-${index}`, { text: 'hello' })).content[0].type,
        'text',
      );
    }
    const complete = session.agent.state.tools.find((tool) => tool.name === 'mcp_complete')!;
    const completion = await complete.execute('complete', {
      server: 'old',
      type: 'ref/prompt',
      name: 'demo',
      argument: 'value',
      value: '',
    });
    assert.match(JSON.stringify(completion.content), /legacy/);
    const before = session.messages.length;
    for (const command of ['status', 'sampling', 'prompts fixture'])
      await session.prompt(`/mcp ${command}`);
    assert.equal(session.messages.length, before);
    assert.equal((session as any)._pendingNextTurnMessages.length, 0);
    assert.equal(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === 'custom' && entry.customType === 'mcp-admin').length,
      3,
    );
    await session.prompt(
      '/mcp prompt {"server":"fixture","name":"demo","arguments":{"text":"a  b"}}',
    );
    assert.equal(wireText, 'a  b');
    const prompt = (session as any)._pendingNextTurnMessages.at(-1);
    assert.ok(prompt.content.some((block: any) => block.type === 'image'));
    assert.ok(
      !prompt.content.some((block: any) => block.type === 'text' && block.text.includes('AAAA')),
    );
    const beforeLists = lists;
    await (session as any)._extensionRunner.emitBeforeAgentStart(
      'probe',
      undefined,
      session.agent.state.systemPrompt,
    );
    assert.ok(lists > beforeLists);
    await session.prompt('/mcp subscribe {"server":"fixture","uri":"test:notes"}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(listens, 1);
    await session.reload();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(listens, 2);
    const stream = streams.at(-1)!;
    stream.res.end(
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: stream.id, result: { resultType: 'complete' } })}\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusTool = () => session!.agent.state.tools.find((tool) => tool.name === 'mcp_status')!;
    assert.match(
      JSON.stringify((await statusTool().execute('status', {})).content),
      /Subscription ended/,
    );
    rejectSubscription = true;
    await session.prompt('/mcp refresh');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(
      JSON.stringify((await statusTool().execute('status2', {})).content),
      /Subscription ended/,
    );
    rejectSubscription = false;
    await session.prompt('/mcp refresh');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotMatch(
      JSON.stringify((await statusTool().execute('status3', {})).content),
      /Subscription ended/,
    );
  } finally {
    if (session) {
      await (session as any)._extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(cwd, { recursive: true, force: true });
  }
});
