import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { childRead } from '../src/pi/read-tool.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels, fauxProvider, fauxAssistantMessage } from '@durable-subagents/pi-ai';
import { registerDurableSubagents } from '../src/pi/extension.js';
import { bridgeModels } from '../src/pi/bridge.js';
import { until, model } from './helpers.js';

async function adapter(policy = true) {
  const root = await mkdtemp(join(tmpdir(), 'durable-adapter-')), agent = join(root, 'agent'); await mkdir(agent);
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  let configured = true;
  const registry = { find: (p: string, m: string) => models.getModel(p, m), getAll: () => models.getModels(), getAvailable: () => models.getModels(), hasConfiguredAuth: () => configured,
    streamSimple: models.streamSimple.bind(models), stream: models.stream.bind(models), getApiKeyAndHeaders() { throw new Error('Credential extraction forbidden'); } };
  const handlers = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>(), sent: any[] = [], entries: any[] = [];
  const pi: any = { on: (n: string, h: any) => handlers.set(n, h), registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c), sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
  const ctx: any = { cwd: root, mode: 'rpc', hasUI: false, ui: { setStatus() {}, notify() {} }, modelRegistry: registry, isIdle: () => true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'parent-one', getEntries: () => entries } };
  if (policy) await writeFile(join(agent, 'durable-subagents.json'), JSON.stringify({ allowedModels: [model], allowedTools: ['peer_send', 'read'], allowedRoots: [root], maxAgents: 3, maxActiveAssignments: 4, maxPeerMessages: 2 }));
  registerDurableSubagents(pi, () => agent);
  const start = () => handlers.get('session_start')({ reason: 'startup' }, ctx);
  const stop = () => handlers.get('session_shutdown')({ reason: 'reload' }, ctx);
  const run = async (suffix: string, args = {}) => tools.get(`durable_subagent_${suffix}`).execute('test-call', args, undefined, undefined, ctx);
  const spawn = (name = 'worker', tools: string[] = []) => run('spawn', { name, cwd: root, model, tools, operationId: `spawn:${name}` });
  return { root, agent, ctx, faux, models, registry, handlers, tools, commands, sent, entries, start, stop, run, spawn, revoke: () => { configured = false; }, cleanup: async () => { await stop(); await rm(root, { recursive: true, force: true }); } };
}

test('nonblocking send, observed-only notification receipt, reload reconciliation and human holds', async () => {
  const a = await adapter();
  try {
    await a.start(); await a.spawn();
    assert.ok(a.tools.has('durable_subagent_send')); assert.ok(!a.tools.has('subagent_send'));
    assert.ok(![...a.tools.keys()].some(t => /halt|release/.test(t)));
    a.faux.setResponses([fauxAssistantMessage('native result')]);
    const accepted = await a.run('send', { name: 'worker', operationId: 'send-one', message: 'Work' });
    assert.ok(accepted.details.taskId);
    await until(async () => a.sent.length === 1);
    assert.equal((await a.run('list')).details.unreadReports, 1, 'enqueue does not acknowledge');
    assert.deepEqual(a.sent[0].options, { deliverAs: 'followUp', triggerTurn: true });
    const notice = a.sent[0].message;
    a.entries.push({ type: 'custom_message', customType: notice.customType, details: notice.details });
    await a.stop(); await a.start();
    assert.equal((await a.run('list')).details.unreadReports, 0, 'history receipt repairs acknowledgment on reopen');
    await a.handlers.get('message_end')({ message: notice });
    await a.commands.get('durable-subagents').handler('halt worker test hold', a.ctx);
    const held = (await a.run('list')).details.agents[0]; assert.equal(held.hold.confirmed, true);
    await assert.rejects(a.run('send', { name: 'worker', operationId: 'blocked', message: 'Work' }), /held/);
    await a.stop(); await a.start(); assert.equal((await a.run('list')).details.agents[0].hold.confirmed, true);
    const calls = a.faux.state.callCount;
    await a.commands.get('durable-subagents').handler('release worker', a.ctx);
    assert.equal((await a.run('list')).details.agents[0].hold, undefined);
    assert.equal(a.faux.state.callCount, calls, 'human release starts no inference');
    await a.stop(); assert.ok(!(await readdir(join(a.agent, 'durable-subagents'))).some(f => f.endsWith('.lock')));
  } finally { await a.cleanup(); }
});

test('missing policy, untrusted project policy and unavailable stable stream fail closed', async () => {
  const a = await adapter(false);
  try {
    await a.start(); await assert.rejects(a.spawn(), /No durable-subagents policy/);
    await mkdir(join(a.root, '.pi')); await writeFile(join(a.root, '.pi/durable-subagents.json'), '{}');
    a.ctx.isProjectTrusted = () => false;
    await assert.rejects(a.spawn(), /requires Pi project trust/);
    assert.throws(() => bridgeModels({ find() {} } as any), /requires Pi >=0.99.2/);
  } finally { await a.cleanup(); }
});

test('bounded native read participates in streaming tool calls; no ambient parent grants', async () => {
  const a = await adapter();
  try {
    await writeFile(join(a.root, 'input.txt'), 'safe content');
    await a.start(); await a.spawn('worker', ['read']);
    a.faux.setResponses([
      fauxAssistantMessage([{ type: 'toolCall', id: 'read-one', name: 'read', arguments: { path: 'input.txt' } }], { stopReason: 'toolUse' }),
      (context) => { const result = context.messages.find(m => m.role === 'toolResult'); assert.match(JSON.stringify(result), /safe content/); return fauxAssistantMessage('read complete'); },
    ]);
    await a.run('send', { name: 'worker', message: 'Read', operationId: 'read-job' });
    await until(async () => a.sent.length === 1); assert.match(a.sent[0].message.content, /read complete/);
    await assert.rejects(a.spawn('shell', ['bash']), /not allowed/);
  } finally { await a.cleanup(); }
});

test('registry bridge does not extract auth and rejects deferred provider operations', async () => {
  const a = await adapter();
  try {
    const bridge = bridgeModels(a.registry as any);
    a.faux.setResponses([fauxAssistantMessage('bridged')]);
    assert.equal((await bridge.completeSimple(a.faux.getModel(), { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] })).content[0].type, 'text');
    await assert.rejects(bridge.fetchDeferred(a.faux.getModel(), {} as any), /unsupported/);
    a.revoke(); assert.throws(() => bridge.streamSimple(a.faux.getModel(), { messages: [] }), /no longer configured/);
  } finally { await a.cleanup(); }
});

test('session replacement fences late results and old receipts; reopening is idempotent', async () => {
  const a = await adapter();
  try {
    await a.start(); await a.spawn();
    a.faux.setResponses([fauxAssistantMessage('old session result')]);
    const before = await a.run('send', { name: 'worker', operationId: 'old-job', message: 'Work' });
    await until(async () => a.sent.length === 1);
    const oldNotice = a.sent[0].message;
    await a.stop();
    a.ctx.sessionManager.getSessionId = () => 'parent-two'; a.entries.length = 0;
    await a.start();
    await a.handlers.get('message_end')({ message: oldNotice });
    assert.deepEqual((await a.run('list')).details.agents, []);
    assert.equal((await a.run('list')).details.unreadReports, 0);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(a.sent.length, 1, 'old results are not delivered to new parent');
    await a.stop(); a.ctx.sessionManager.getSessionId = () => 'parent-one';
    a.entries.push({ type: 'custom_message', customType: oldNotice.customType, details: oldNotice.details });
    await a.start(); await a.spawn();
    const calls = a.faux.state.callCount;
    const repeated = await a.run('send', { name: 'worker', operationId: 'old-job', message: 'Work' });
    assert.equal(repeated.details.taskId, before.details.taskId);
    assert.equal((await a.run('list')).details.agents.length, 1);
    assert.equal(a.faux.state.callCount, calls, 'same logical request does not replay inference');
  } finally { await a.cleanup(); }
});

test('unobserved asynchronous notification enqueue is recoverable without erasing reports', async () => {
  const a = await adapter();
  try {
    await a.start(); await a.spawn();
    a.faux.setResponses([fauxAssistantMessage('first result'), fauxAssistantMessage('second result')]);
    await a.run('send', { name: 'worker', operationId: 'first', message: 'One' });
    await until(async () => a.sent.length === 1); // Pi accepted a void enqueue, then dropped it asynchronously.
    await a.run('send', { name: 'worker', operationId: 'second', message: 'Two' });
    await until(async () => (await a.run('list')).details.unreadReports === 2);
    assert.equal(a.sent.length, 1);
    await a.commands.get('durable-subagents').handler('retry-reports', a.ctx);
    assert.equal(a.sent.length, 2);
    assert.match(a.sent[1].message.content, /first result/); assert.match(a.sent[1].message.content, /second result/);
    await a.handlers.get('message_end')({ message: a.sent[1].message });
    assert.equal((await a.run('list')).details.unreadReports, 0);
  } finally { await a.cleanup(); }
});

test('out-of-range persisted receipt fails startup cleanly; fixing history permits reopen', async () => {
  const a = await adapter();
  try {
    const session = createHash('sha256').update('parent-one').digest('hex');
    a.entries.push({ type: 'custom_message', customType: 'durable-subagents-report', details: { session, through: 9000 } });
    await a.start();
    assert.ok(!(await readdir(join(a.agent, 'durable-subagents'))).some(f => f.endsWith('.lock')));
    await assert.rejects(a.spawn(), /exceeds committed reports/);
    assert.ok(!(await readdir(join(a.agent, 'durable-subagents'))).some(f => f.endsWith('.lock')));
    a.entries.length = 0; await a.start(); await a.spawn(); assert.equal((await a.run('list')).details.agents.length, 1);
  } finally { await a.cleanup(); }
});

test('readonly child rejects traversal/outside symlinks and never follows a swapped final leaf', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durable-read-race-'));
  const cwd = join(root, 'child'); await mkdir(cwd);
  const outside = join(root, 'outside.txt'); await writeFile(outside, 'OUTSIDE PRIVATE');
  const target = join(cwd, 'target.txt'); await writeFile(target, 'safe content');
  const tool = childRead(() => ({ assertToolAllowed: async () => ({ cwd }) }) as any);
  const read = (path: string) => tool.execute({ path }, { conversationId: 1 } as any, BACKGROUND_CONTEXT);
  try {
    await assert.rejects(read('../outside.txt'), /outside child cwd/);
    await symlink(outside, join(cwd, 'escape')); await assert.rejects(read('escape'), /outside child cwd/);
    const swap = async () => {
      for (let i = 0; i < 60; i++) {
        const link = join(cwd, 'new-link'); await symlink(outside, link); await rename(link, target);
        const safe = join(cwd, 'new-file'); await writeFile(safe, 'safe content'); await rename(safe, target);
      }
    };
    await Promise.all([swap(), (async () => {
      for (let i = 0; i < 60; i++) {
        try { const result = await read('target.txt'); assert.doesNotMatch(JSON.stringify(result), /OUTSIDE PRIVATE/); }
        catch (error) { if (error instanceof assert.AssertionError) throw error; }
      }
    })()]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
