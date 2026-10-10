// Explicit local-host smoke test. Uses only synthetic servers, no personal config or Mac.
// Usage: node scripts/native-rpc-smoke.mjs /absolute/path/to/pi
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const binary = process.argv[2];
if (!binary?.startsWith('/')) throw new Error('Pass the absolute Pi executable to test');
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'mcp-native-rpc-'));
const agent = join(dir, 'agent');
await mkdir(agent);
const fixture = join(root, 'test/fixtures/native-approval-server.mjs');
await writeFile(
  join(agent, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixture],
        timeout: 30,
        exposure: 'codemode',
        toolExposure: { hidden: 'hidden' },
      },
    },
  }),
);
await writeFile(
  join(agent, 'mcp-client.json'),
  JSON.stringify({
    configurationFormat: 'native',
    serverOptions: { fixture: { protocol: '2025-11-25', elicitation: true } },
    computerUse: {
      fixture: {
        apps: ['com.apple.calculator'],
        operations: ['get_app_state'],
        persistence: 'session',
      },
    },
  }),
);
await writeFile(
  join(agent, 'settings.json'),
  JSON.stringify({ defaultTools: ['+codemode'], quietStartup: true }),
);
const code = `
const names = await describeNamespace('fixture');
if (!names || names.tools.some(n => n.includes('hidden'))) throw new Error('hidden tool leaked');
let rejected = false; try { await tools.mcp__fixture__hidden({}); } catch { rejected = true; }
if (!rejected) throw new Error('hidden tool callable');
const r = await tools.mcp__fixture__approve({});
if (r.structuredContent?.persistence !== 'session' || r.structuredContent?.action !== 'accept') throw new Error('approval response lost');
if (r._meta !== undefined) throw new Error('private metadata leaked');
const reused = await tools.mcp__fixture__approve({});
if (reused.structuredContent?.source !== 'computer-use-persisted-state' || reused.structuredContent?.persistence !== 'session') throw new Error('Session consent not reused');
for (const b of r.content) { if (b.type === 'image') image(b); }
const e = await tools.mcp__fixture__error({});
if (!e.isError || e.content[0].text !== 'fixture-error') throw new Error('MCP error contract lost');
const list = await tools.list_mcp_resources({server:'fixture'});
if (list.resources.length !== 1 || list.resources[0].uri !== 'fixture://image') throw new Error('resource filter failed');
const read = await tools.read_mcp_resource({server:'fixture',uri:'fixture://image'});
if (!read.contents[0].blob) throw new Error('resource result lost');
const registered = await describeNamespace('registered');
if (!registered?.tools.includes('mcp__registered__error')) throw new Error('extension registration missing');
text('NATIVE_RPC_OK');
`;
await writeFile(
  join(dir, 'provider.mjs'),
  `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
  pi.registerMcpServer('registered', {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(fixture)}],exposure:'deferred'});
  pi.registerProvider('native-smoke', {baseUrl:'http://unused.invalid', apiKey:'fixture', api:'openai-completions',
    models:[{id:'fake',name:'Fixture',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
    streamSimple(model,ctx) {
      const stream=createAssistantMessageEventStream();
      const done=ctx.messages.some(m=>m.role==='toolResult'&&m.toolName==='codemode');
      if (!pi.getActiveTools().includes('tool_search')) throw new Error('Native deferred discovery inactive');
      const msg={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        content:done?[{type:'text',text:'fixture finished'}]:[{type:'toolCall',id:'fixture-code',name:'codemode',arguments:{code:${JSON.stringify(code)}}}],
        stopReason:done?'stop':'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
    }
  });
}
`,
);
const child = spawn(
  binary,
  [
    '--mode',
    'rpc',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '-e',
    'builtin:mcp',
    '-e',
    'builtin:codemode',
    '-e',
    'builtin:tool-search',
    '-e',
    join(root, 'extensions/mcp-client/index.ts'),
    '-e',
    join(dir, 'provider.mjs'),
    '--provider',
    'native-smoke',
    '--model',
    'fake',
  ],
  {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
const events = [];
let buffer = '';
let stderr = '';
const send = (v) => child.stdin.write(JSON.stringify(v) + '\n');
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n);
    buffer = buffer.slice(n + 1);
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    events.push(e);
    // Test-driver consent for ONLY the synthetic fixture, never a live server.
    if (e.type === 'extension_ui_request' && e.method === 'select') {
      const session = e.options?.find((o) => o === 'Allow for this session');
      if (session && JSON.stringify(e).includes('com.apple.calculator'))
        send({ type: 'extension_ui_response', id: e.id, value: session });
      else send({ type: 'extension_ui_response', id: e.id, cancelled: true });
    }
  }
});
child.stderr.on('data', (c) => (stderr += c));
async function waitFor(predicate) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const e = events.find(predicate);
    if (e) return e;
    assert.equal(child.exitCode, null, stderr);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out: ' + stderr + '\n' + JSON.stringify(events));
}
try {
  send({ id: 'ready', type: 'get_commands' });
  const ready = await waitFor((e) => e.id === 'ready');
  assert.equal(ready.data.commands.filter((c) => c.name === 'mcp').length, 1);
  send({ id: 'test', type: 'prompt', message: 'Run the isolated native MCP fixture.' });
  await waitFor((e) => e.type === 'agent_settled');
  const result = events.find((e) => e.type === 'tool_execution_end' && e.toolName === 'codemode');
  assert.ok(result && !result.isError, JSON.stringify(events));
  assert.ok(JSON.stringify(result).includes('NATIVE_RPC_OK'), JSON.stringify(result));
  assert.ok(
    result.result.content.some((c) => c.type === 'image'),
    'Image not forwarded through codemode',
  );
  assert.equal(
    events.filter((e) => e.type === 'extension_error').length,
    0,
    JSON.stringify(events),
  );
  assert.equal(
    events.filter((e) => e.type === 'extension_ui_request' && e.method === 'select').length,
    1,
    'Repeated calls must reuse scoped session consent',
  );
  console.log(
    JSON.stringify({
      ok: true,
      executable: binary,
      approvalDialogs: events.filter(
        (e) => e.type === 'extension_ui_request' && e.method === 'select',
      ).length,
      imageDelivered: true,
      nativeTools: true,
      hiddenDenied: true,
      registeredServer: true,
    }),
  );
} finally {
  child.stdin.end();
  await Promise.race([
    new Promise((r) => child.once('close', r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
