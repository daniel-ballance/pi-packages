import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { createParentTools } from '../src/tools.js';
import { setup, answer, unanswered } from './helpers.js';

test('concurrent duplicate sends and conflicting IDs admit exactly one task/report', { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    await f.spawn('worker'); f.faux.setResponses([answer('one')]);
    const request = { name: 'worker', message: 'same', operationId: 'race' };
    const receipts = await Promise.all(Array.from({ length: 12 }, () => f.host.send(request)));
    assert.equal(new Set(receipts.map(r => r.taskId)).size, 1);
    await assert.rejects(() => f.host.send({ ...request, mode: 'steer' }), /different content/);
    await assert.rejects(() => f.host.send({ ...request, message: 'changed' }), /different content/);
    await f.host.wait(receipts[0]!.taskId); assert.equal((await f.host.readReports()).reports.length, 1);
    f.faux.setResponses([answer('winner')]);
    const outcomes = await Promise.allSettled(['A', 'B'].map(message => f.host.send({ name: 'worker', message, operationId: 'collision' })));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of outcomes) if (r.status === 'fulfilled') await f.host.wait(r.value.taskId); else assert.match(String(r.reason), /different content/);
    assert.equal((await f.host.readReports()).reports.length, 1);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('peer IDs scope by sender; concurrent duplicates consume independent directional budgets once', { timeout: 10000 }, async () => {
  const f = await setup({}, { allowedTools: ['peer_send'], maxPeerMessages: 1 });
  try {
    const alice = await f.spawn('alice', ['peer_send']), bob = await f.spawn('bob', ['peer_send']);
    await f.host.connect('alice', 'bob', 1); f.faux.setResponses([answer('to bob'), answer('to alice')]);
    const input = { recipient: 'bob', message: 'hello', operationId: 'shared' };
    const repeated = await Promise.all(Array.from({ length: 8 }, () => f.host.peerSend(alice.conversationId, input)));
    assert.equal(new Set(repeated.map(r => r.taskId)).size, 1); await f.host.wait(repeated[0]!.taskId);
    await assert.rejects(() => f.host.peerSend(alice.conversationId, { ...input, message: 'other' }), /different content/);
    const reverse = await f.host.peerSend(bob.conversationId, { ...input, recipient: 'alice' });
    assert.notEqual(reverse.taskId, repeated[0]!.taskId); await f.host.wait(reverse.taskId);
    const state = await f.host.state();
    assert.equal(state.peers['alice>bob']!.used, 1); assert.equal(state.peers['bob>alice']!.used, 1);
    assert.equal((await f.host.readReports()).reports.length, 2);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('peer scope rejection does not consume allowance', async () => {
  const f = await setup({}, { allowedTools: ['peer_send'] });
  try {
    const alice = await f.spawn('alice', ['peer_send']); await f.spawn('bob', ['peer_send']);
    await f.spawn('plain'); await f.spawn('unlinked', ['peer_send']); await f.host.connect('alice', 'bob', 2);
    await assert.rejects(() => f.host.peerSend(alice.conversationId, { recipient: 'alice', message: 'x', operationId: 'self' }), /Self/);
    await assert.rejects(() => f.host.peerSend(alice.conversationId, { recipient: 'plain', message: 'x', operationId: 'plain' }), /select peer_send/);
    await assert.rejects(() => f.host.peerSend(alice.conversationId, { recipient: 'unlinked', message: 'x', operationId: 'unlinked' }), /allowance/);
    await assert.rejects(() => f.host.peerSend(f.host.root.id, { recipient: 'bob', message: 'x', operationId: 'parent' }), /registered child/);
    assert.equal((await f.host.state()).peers['alice>bob']!.used, 0);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('every parent tool checks caller identity before touching state', async () => {
  const f = await setup();
  try {
    const child = await f.spawn('worker'); const before = await f.host.state();
    for (const tool of createParentTools(() => f.host)) {
      const execute = tool.execute as (...args: any[]) => Promise<unknown>;
      await assert.rejects(() => execute({}, { conversationId: child.conversationId }, C), /Only the parent/);
    }
    assert.deepEqual(await f.host.state(), before);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('report paging acknowledges exactly returned records; explicit replay keeps cursor across reopen', { timeout: 10000 }, async () => {
  const f = await setup(); let host = f.host;
  try {
    await f.spawn('worker'); f.faux.setResponses([answer('first'), answer('second'), answer('third')]);
    for (let i = 0; i < 3; i++) await host.wait((await host.send({ name: 'worker', message: `${i}`, operationId: `page:${i}` })).taskId);
    assert.equal((await host.readReports({ limit: 1, acknowledge: false })).reports[0]!.text, 'first');
    assert.equal((await host.list()).unreadReports, 3);
    assert.equal((await host.readReports({ limit: 1 })).reports[0]!.text, 'first');
    await host.readReports({ after: 0, limit: 3, acknowledge: true }); assert.equal((await host.list()).unreadReports, 2);
    await host.close(); host = await f.open();
    assert.equal((await host.readReports({ limit: 1 })).reports[0]!.text, 'second'); assert.equal((await host.list()).unreadReports, 1);
    assert.equal((await host.readReports()).reports[0]!.text, 'third'); assert.equal((await host.list()).unreadReports, 0);
  } finally { await host.close(); await f.cleanup(); }
});

test('agent and active-assignment ceilings are atomic under concurrent admission', { timeout: 10000 }, async () => {
  const f = await setup({}, { maxAgents: 1, maxActiveAssignments: 1 });
  try {
    const spawns = await Promise.allSettled(['one', 'two', 'three'].map(name => f.spawn(name)));
    const spawned = spawns.filter(r => r.status === 'fulfilled'); assert.equal(spawned.length, 1);
    for (const r of spawns) if (r.status === 'rejected') assert.match(String(r.reason), /agent limit/i);
    assert.ok(spawned[0]?.status === 'fulfilled'); const name = spawned[0].value.name;
    const busy = unanswered(); f.faux.setResponses([busy.step]);
    const races = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => f.host.send({ name, message: 'hold', operationId: `admit:${i}` })));
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of races) if (r.status === 'rejected') assert.match(String(r.reason), /Active assignment limit/);
    await busy.reached; await f.host.halt(name, 'cleanup');
    for (const r of races) if (r.status === 'fulfilled') assert.equal((await f.host.wait(r.value.taskId)).status, 'aborted');
  } finally { await f.host.close(); await f.cleanup(); }
});

test('raw peer operation ID boundaries validate before quota and maximum-length IDs deduplicate', { timeout: 10000 }, async () => {
  const f = await setup({}, { allowedTools: ['peer_send'] });
  try {
    const name = 'a'.repeat(64), sender = await f.spawn(name, ['peer_send']); await f.spawn('bob', ['peer_send']);
    await f.host.connect(name, 'bob', 1);
    for (const operationId of [':bad', '-bad']) await assert.rejects(() => f.host.peerSend(sender.conversationId, { recipient: 'bob', message: 'x', operationId }), /operationId/);
    assert.equal((await f.host.state()).peers[`${name}>bob`]!.used, 0);
    f.faux.setResponses([answer('ok')]); const input = { recipient: 'bob', message: 'x', operationId: 'x'.repeat(160) };
    const receipt = await f.host.peerSend(sender.conversationId, input);
    assert.equal((await f.host.peerSend(sender.conversationId, input)).taskId, receipt.taskId);
    await f.host.wait(receipt.taskId); assert.equal((await f.host.state()).peers[`${name}>bob`]!.used, 1);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('cancelled observer leaves background delivery owned and able to complete', { timeout: 10000 }, async () => {
  const { withCancel } = await import('@earendil-works/chord/context');
  const f = await setup();
  try {
    await f.spawn('worker');
    let resolve!: (value: ReturnType<typeof answer>) => void, entered!: () => void;
    const reached = new Promise<void>(r => { entered = r; });
    f.faux.setResponses([() => new Promise(r => { resolve = r; entered(); })]);
    const receipt = await f.host.send({ name: 'worker', message: 'background', operationId: 'background' }); await reached;
    const observer = withCancel(C); const waiting = f.host.wait(receipt.taskId, observer.context);
    observer.cancel(new Error('observer stopped')); await assert.rejects(waiting, /observer stopped/);
    assert.equal((await f.host.list()).agents[0]!.status, 'working');
    resolve(answer('completed independently'));
    assert.equal((await f.host.wait(receipt.taskId)).output, 'completed independently');
    assert.equal((await f.host.readReports()).reports.length, 1);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('native faux model peer tool routes identity and produces both assignment reports', { timeout: 10000 }, async () => {
  const { fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
  const f = await setup({}, { allowedTools: ['peer_send'] });
  try {
    await f.spawn('alice', ['peer_send']); await f.spawn('bob', ['peer_send']); await f.host.connect('alice', 'bob', 1);
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('peer_send', { recipient: 'bob', message: 'synthetic peer message', operationId: 'native-peer' })], { stopReason: 'toolUse' }),
      answer('done'), answer('done'),
    ]);
    const receipt = await f.host.send({ name: 'alice', message: 'send synthetic peer message', operationId: 'native-assignment' });
    assert.equal((await f.host.wait(receipt.taskId)).status, 'completed');
    const { until } = await import('./helpers.js');
    await until(async () => (await f.host.list()).unreadReports === 2);
    const reports = (await f.host.readReports()).reports;
    assert.deepEqual(reports.map(r => r.name).sort(), ['alice', 'bob']);
    assert.equal((await f.host.state()).peers['alice>bob']!.used, 1);
    assert.equal((await f.host.list()).unreadReports, 0);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('legacy peer receipts deduplicate before and after SQLite reopen without consuming quota twice', { timeout: 10000 }, async () => {
  const f = await setup({}, { allowedTools: ['peer_send'] }); let host = f.host;
  try {
    const alice = await f.spawn('alice', ['peer_send']); await f.spawn('bob', ['peer_send']); await host.connect('alice', 'bob', 1);
    f.faux.setResponses([answer('legacy done')]);
    const legacy = await host.send({ name: 'bob', message: 'x', operationId: 'peer:alice:old', mode: 'steer', peerFrom: 'alice' } as any);
    const input = { recipient: 'bob', message: 'x', operationId: 'old' };
    assert.equal((await host.peerSend(alice.conversationId, input)).taskId, legacy.taskId);
    await host.wait(legacy.taskId); await host.close(); host = await f.open();
    assert.equal((await host.peerSend(alice.conversationId, input)).taskId, legacy.taskId);
    await assert.rejects(() => host.peerSend(alice.conversationId, { ...input, message: 'changed' }), /different content/);
    assert.equal((await host.state()).peers['alice>bob']!.used, 1);
    assert.equal((await host.readReports()).reports.length, 1);
  } finally { await host.close(); await f.cleanup(); }
});

test('retained report overflow signals gap and bounded acknowledgement persists', async () => {
  const { TeamDoc, appendReport } = await import('../src/state.js');
  const f = await setup(); let host = f.host;
  try {
    await host.root.commit(async tx => {
      const state = await tx.doc(TeamDoc, host.root.id);
      for (let i = 1; i <= 205; i++) appendReport(state, { name: 'fixture', kind: 'intervention', text: `notice ${i}` });
    }, C);
    assert.equal((await host.list()).unreadReports, 200);
    const replay = await host.readReports({ after: 0, limit: 200 });
    assert.equal(replay.gap, true); assert.equal(replay.reports[0]!.sequence, 6); assert.equal(replay.next, 205);
    assert.equal((await host.list()).unreadReports, 200);
    const page = await host.readReports({ limit: 7 }); assert.equal(page.gap, true); assert.equal(page.next, 12);
    assert.equal((await host.list()).unreadReports, 193);
    await host.close(); host = await f.open();
    const next = await host.readReports({ limit: 200 }); assert.equal(next.gap, false);
    assert.equal(next.reports[0]!.sequence, 13); assert.equal(next.reports.length, 193);
    assert.equal((await host.list()).unreadReports, 0);
  } finally { await host.close(); await f.cleanup(); }
});

test('held sender, held recipient and disconnected peer reject new sends without quota consumption', async () => {
  const f = await setup({}, { allowedTools: ['peer_send'] });
  try {
    const alice = await f.spawn('alice', ['peer_send']); await f.spawn('bob', ['peer_send']); await f.host.connect('alice', 'bob', 2);
    const input = { recipient: 'bob', message: 'x', operationId: 'blocked' };
    await f.host.halt('alice', 'hold-sender');
    await assert.rejects(() => f.host.peerSend(alice.conversationId, input), /held/); await f.host.release('alice');
    await f.host.halt('bob', 'hold-recipient');
    await assert.rejects(() => f.host.peerSend(alice.conversationId, input), /held/); await f.host.release('bob');
    await f.host.disconnect('alice', 'bob'); await f.host.renew('alice', 'bob', 2, 'renew-disconnected');
    await assert.rejects(() => f.host.peerSend(alice.conversationId, input), /allowance/);
    assert.equal((await f.host.state()).peers['alice>bob']!.used, 0);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('a selected tool cannot dynamically expand child tools', { timeout: 10000 }, async () => {
  const { Type, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
  const { defineTool } = await import('@earendil-works/pi-durable');
  let effects = 0;
  const expand = defineTool({ name: 'expand', description: 'Synthetic expansion attempt', parameters: Type.Object({}), replay: 'safe',
    execute: async () => { effects++; return { content: [{ type: 'text', text: 'attempt' }], control: { addTools: ['unselected'] } }; },
  });
  const f = await setup({ tools: [expand] }, { allowedTools: ['expand'] });
  try {
    const child = await f.spawn('worker', ['expand']);
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('expand', {})], { stopReason: 'toolUse' }), answer('after denied expansion'),
    ]);
    await f.host.wait((await f.host.send({ name: 'worker', message: 'attempt expansion', operationId: 'expansion' })).taskId);
    const conversation = (await f.host.harness.conversation(child.conversationId, C))!;
    assert.equal(effects, 1); assert.deepEqual((await conversation.agent(C)).tools.map(t => t.name), ['expand']);
    const entries = await conversation.entries({}, 100, undefined, C);
    assert.match(JSON.stringify(entries.items), /Dynamic tool expansion is forbidden/);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('native workflow admission failure requires explicit retry and preserves completed dependencies', { timeout: 10000 }, async () => {
  const { until } = await import('./helpers.js');
  const f = await setup({}, { maxActiveAssignments: 1 });
  try {
    await f.spawn('alice'); await f.spawn('bob');
    let resolve!: (value: ReturnType<typeof answer>) => void;
    f.faux.setResponses([() => new Promise(r => { resolve = r; }), answer('retried'), answer('dependent')]);
    const id = await f.host.workflows.startWorkflow(f.host.root, { version: 1, name: 'admission', limits: { concurrency: 2, maxAttempts: 4 }, steps: [
      { id: 'a', kind: 'task', agent: 'alice', instructions: 'a' },
      { id: 'b', kind: 'task', agent: 'bob', instructions: 'b' },
      { id: 'c', kind: 'task', agent: 'alice', instructions: 'c', dependsOn: ['a', 'b'] },
    ] }, 'admission-workflow', C);
    f.host.harness.resume();
    const inspect = () => f.host.workflows.inspectWorkflow(f.host.harness, id, C);
    await until(async () => Object.values((await inspect()).nodeAttempts).some(attempts => attempts.some(a => a.outcome?.status === 'failed')) && Boolean(resolve));
    const failedState = await inspect();
    const failed = ['a', 'b'].find(node => failedState.nodeAttempts[node]?.[0]?.outcome?.status === 'failed')!;
    const successful = failed === 'a' ? 'b' : 'a';
    resolve(answer('admitted'));
    await until(async () => (await inspect()).nodeAttempts[successful]?.[0]?.outcome?.status === 'completed');
    const original = (await inspect()).nodeAttempts[successful]![0]!.taskId;
    assert.equal((await inspect()).nodeAttempts.c, undefined);
    await assert.rejects(() => f.host.workflows.retryWorkflow(f.host.root, id, successful, C), /completed nodes cannot/);
    await f.host.workflows.retryWorkflow(f.host.root, id, failed, C);
    assert.equal((await f.host.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    const final = await inspect();
    assert.equal(final.nodeAttempts[successful]!.length, 1); assert.equal(final.nodeAttempts[successful]![0]!.taskId, original);
    assert.equal(final.nodeAttempts[failed]!.length, 2); assert.equal(final.nodeAttempts.c!.length, 1);
    assert.equal((await f.host.readReports()).reports.length, 3);
  } finally { await f.host.close(); await f.cleanup(); }
});
