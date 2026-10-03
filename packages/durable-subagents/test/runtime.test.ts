import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { TeamDoc } from '../src/state.js';
import { setup, answer, model, unanswered } from './helpers.js';

test('native identities, logical operation dedup, receipt paging and persisted result', { timeout: 10000 }, async () => {
  const f = await setup();
  let host = f.host;
  try {
    f.faux.setResponses([answer('finished')]);
    const child = await f.spawn('worker');
    assert.equal((await f.spawn('worker')).conversationId, child.conversationId);
    await assert.rejects(() => host.spawn({ name: 'other', model, cwd: f.directory, operationId: 'spawn:worker' }), /different content/);
    const input = { name: 'worker', message: 'do work', operationId: 'assignment:1' };
    const sent = await host.send(input);
    assert.equal((await host.send(input)).taskId, sent.taskId);
    await assert.rejects(() => host.send({ ...input, message: 'changed' }), /different content/);
    assert.equal((await host.wait(sent.taskId)).output, 'finished');
    assert.equal((await host.list()).unreadReports, 1);
    assert.equal((await host.readReports({ acknowledge: false })).reports.length, 1);
    assert.equal((await host.list()).unreadReports, 1);
    await host.close(); host = await f.open();
    assert.equal((await host.send(input)).taskId, sent.taskId);
    assert.equal((await host.readReports()).reports[0]!.text, 'finished');
    assert.equal((await host.list()).unreadReports, 0);
    assert.equal((await host.readReports({ after: 0 })).reports.length, 1);
  } finally { await host.close(); await f.cleanup(); }
});

test('exclusive SQLite ownership and clean reopen', async () => {
  const f = await setup();
  try { await assert.rejects(() => f.open(), /already owned/); }
  finally { await f.host.close(); }
  const reopened = await f.open(); await reopened.close(); await f.cleanup();
});

test('real SQLite suspension and native queued continuation recover once', { timeout: 10000 }, async () => {
  const f = await setup(); let host = f.host;
  try {
    const busy = unanswered(); f.faux.setResponses([busy.step]);
    await f.spawn('worker');
    const first = await host.send({ name: 'worker', message: 'first', operationId: 'first' });
    await busy.reached;
    const second = await host.send({ name: 'worker', message: 'second', operationId: 'second' });
    await host.close();
    f.faux.setResponses([answer('one'), answer('two')]);
    host = await f.open();
    assert.equal((await host.wait(first.taskId)).output, 'one');
    assert.equal((await host.wait(second.taskId)).output, 'two');
    assert.equal((await host.readReports()).reports.length, 2);
    const child = await host.child('worker');
    const conversation = (await host.harness.conversation(child.conversationId, C))!;
    const entries = await conversation.entries({}, 100, undefined, C);
    const inputs = entries.items.filter(e => e.model?.[0]?.role === 'user');
    assert.equal(inputs.length, 2);
  } finally { await host.close(); await f.cleanup(); }
});

test('crash-window hold persists before cancellation and vetoes recovery', { timeout: 10000 }, async () => {
  const f = await setup(); let host = f.host;
  try {
    const busy = unanswered(); f.faux.setResponses([busy.step]); await f.spawn('worker');
    const job = await host.send({ name: 'worker', message: 'long', operationId: 'long' }); await busy.reached;
    // Simulate process loss after the application hold commit, before cancellation.
    await host.root.commit(async tx => { (await tx.doc(TeamDoc, host.root.id)).agents.worker!.hold = { operationId: 'human-crash', reason: 'stop', requestedAt: 1, confirmed: false }; }, C);
    await host.close();
    let called = 0; f.faux.setResponses([() => { called++; return answer('must not run'); }]);
    host = await f.open();
    assert.equal((await host.wait(job.taskId)).status, 'aborted');
    assert.equal(called, 0);
    assert.equal((await host.child('worker')).hold!.confirmed, true);
    await assert.rejects(() => host.send({ name: 'worker', message: 'no', operationId: 'no' }), /held/);
    await host.release('worker'); assert.equal(called, 0);
    assert.equal((await host.list()).agents[0]!.status, 'idle');
  } finally { await host.close(); await f.cleanup(); }
});

test('old halt retry cannot cancel work started after human release', { timeout: 10000 }, async () => {
  const f = await setup(); const host = f.host;
  try {
    await f.spawn('worker'); await host.halt('worker', 'halt:1'); await host.release('worker');
    const busy = unanswered(); f.faux.setResponses([busy.step]);
    const job = await host.send({ name: 'worker', message: 'new', operationId: 'new' }); await busy.reached;
    await host.halt('worker', 'halt:1');
    assert.equal((await host.list()).agents[0]!.status, 'working');
    await host.halt('worker', 'halt:2');
    assert.equal((await host.wait(job.taskId)).status, 'aborted');
  } finally { await host.close(); await f.cleanup(); }
});

test('peer identity, atomic budgets, dedup and reconnect without renewal', { timeout: 10000 }, async () => {
  const f = await setup({}, { allowedTools: ['peer_send'] }); const host = f.host;
  try {
    f.faux.setResponses(Array.from({ length: 10 }, () => answer('ok')));
    const a = await f.spawn('alice', ['peer_send']); await f.spawn('bob', ['peer_send']); await f.spawn('charlie', ['peer_send']);
    await assert.rejects(() => host.peerSend(a.conversationId, { recipient: 'bob', message: 'x', operationId: 'p0' }), /allowance/);
    await host.connect('alice', 'bob', 1);
    const input = { recipient: 'bob', message: 'message', operationId: 'p1' };
    const sent = await host.peerSend(a.conversationId, input);
    assert.equal((await host.peerSend(a.conversationId, input)).taskId, sent.taskId);
    await host.wait(sent.taskId);
    await assert.rejects(() => host.peerSend(a.conversationId, { ...input, operationId: 'p2' }), /allowance/);
    await host.disconnect('alice', 'bob'); await host.connect('alice', 'bob', 3);
    await assert.rejects(() => host.peerSend(a.conversationId, { ...input, operationId: 'p3' }), /allowance/);
    await assert.rejects(() => host.peerSend(a.conversationId, { ...input, recipient: 'charlie', operationId: 'p4' }), /allowance/);
    await host.renew('alice', 'bob', 1, 'renew:1');
    const races = await Promise.allSettled(['race1','race2'].map(operationId => host.peerSend(a.conversationId, { ...input, operationId })));
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of races) if (r.status === 'fulfilled') await host.wait(r.value.taskId);
    await host.renew('alice', 'bob', 1, 'renew:1');
    assert.equal((await host.state()).peers['alice>bob']!.used, 1);
  } finally { await host.close(); await f.cleanup(); }
});

test('lower current peer ceiling constrains persisted allowances on reopen', { timeout: 10000 }, async () => {
  const f = await setup({}, { allowedTools: ['peer_send'], maxPeerMessages: 3 }); let host = f.host;
  try {
    const a = await f.spawn('alice', ['peer_send']); await f.spawn('bob', ['peer_send']); await host.connect('alice','bob',3);
    f.faux.setResponses([answer('ok')]);
    await host.wait((await host.peerSend(a.conversationId, { recipient: 'bob', message: 'first', operationId: 'first' })).taskId);
    await host.close(); host = await f.open({ policy: { ...f.policy, maxPeerMessages: 1 } });
    await assert.rejects(() => host.peerSend(a.conversationId, { recipient: 'bob', message: 'second', operationId: 'second' }), /allowance/);
  } finally { await host.close(); await f.cleanup(); }
});

test('concurrent human halts share cancellation and cannot leave a delayed stop after release', { timeout: 10000 }, async () => {
  const f = await setup(); const host = f.host;
  try {
    const worker = await f.spawn('worker');
    const original = host.harness.conversation.bind(host.harness);
    let unblock!: () => void, entered!: () => void, aborts = 0;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    host.harness.conversation = async (id, context) => {
      const handle = await original(id, context);
      if (id !== worker.conversationId || !handle) return handle;
      const abort = handle.abort.bind(handle);
      handle.abort = async (...args) => { aborts++; entered(); await blocked; return abort(...args); };
      return handle;
    };
    const first = host.halt('worker', 'halt:first'); await reached;
    const second = host.halt('worker', 'halt:second');
    await assert.rejects(() => host.release('worker'), /not confirmed/);
    unblock(); await Promise.all([first, second]); assert.equal(aborts, 1);
    host.harness.conversation = original;
    await host.release('worker');
    const busy = unanswered(); f.faux.setResponses([busy.step]);
    await host.send({ name: 'worker', message: 'new', operationId: 'after-halts' }); await busy.reached;
    await Promise.all([host.halt('worker', 'halt:first'), host.halt('worker', 'halt:second')]);
    assert.equal((await host.list()).agents[0]!.status, 'working');
    await host.halt('worker', 'halt:final');
  } finally { await host.close(); await f.cleanup(); }
});

test('SQLite symlink alias cannot bypass the owner lock', async () => {
  const { symlink } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { openSqliteSubagents } = await import('../src/sqlite.js');
  const f = await setup();
  try {
    const alias = join(f.directory, 'alias.sqlite'); await symlink(f.path, alias);
    await assert.rejects(() => openSqliteSubagents(alias, f.options), /already owned/);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('a new halt operation on an already-confirmed hold never repeats cancellation', { timeout: 10000 }, async () => {
  const f = await setup(); const host = f.host;
  try {
    await f.spawn('worker'); await host.halt('worker', 'halt:confirmed');
    const original = host.harness.conversation.bind(host.harness);
    let lookups = 0;
    host.harness.conversation = async (...args) => { lookups++; return original(...args); };
    await host.halt('worker', 'halt:redundant'); assert.equal(lookups, 0);
    await host.release('worker');
    const busy = unanswered(); f.faux.setResponses([busy.step]);
    await host.send({ name: 'worker', message: 'new', operationId: 'after-confirmed' }); await busy.reached;
    await host.halt('worker', 'halt:redundant'); assert.equal((await host.list()).agents[0]!.status, 'working');
    await host.halt('worker', 'halt:cleanup');
  } finally { await host.close(); await f.cleanup(); }
});

test('dangling SQLite aliases and hard links fail closed', async () => {
  const { symlink, link, unlink } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { openSqliteSubagents } = await import('../src/sqlite.js'); const f = await setup();
  try {
    const dangling = join(f.directory, 'dangling.sqlite'); await symlink(join(f.directory, 'not-created.sqlite'), dangling);
    await assert.rejects(() => openSqliteSubagents(dangling, f.options), /Dangling/);
    await f.host.close(); // Creating hard links to an active WAL database is outside SQLite's supported file contract.
    const hard = join(f.directory, 'hard.sqlite'); await link(f.path, hard);
    await assert.rejects(() => openSqliteSubagents(hard, f.options), /Hard-linked/);
    await unlink(hard);
    const reopened = await f.open(); await reopened.close();
  } finally { await f.host.close(); await f.cleanup(); }
});

test('reordered logical send arguments reuse the same operation receipt', async () => {
  const f = await setup();
  try {
    await f.spawn('worker'); f.faux.setResponses([answer('ok')]);
    const original = await f.host.send({ name: 'worker', message: 'x', operationId: 'ordered' });
    const retry = await f.host.send({ mode: 'followUp', operationId: 'ordered', message: 'x', name: 'worker' });
    assert.equal(original.taskId, retry.taskId); await f.host.wait(original.taskId);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('SQLite database and sidecars are private even in an existing shared-readable directory', async () => {
  const { chmod, stat } = await import('node:fs/promises');
  const f = await setup();
  try {
    await chmod(f.directory, 0o755);
    await f.spawn('worker');
    for (const path of [f.path, `${f.path}-wal`, `${f.path}-shm`]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await f.host.close(); await f.cleanup(); }
});

test('native parent tools are usable but human supervision and management never leak to children', { timeout: 10000 }, async () => {
  const { fauxAssistantMessage, fauxToolCall } = await import('@durable-subagents/pi-ai');
  const f = await setup(); const host = f.host;
  try {
    await host.root.configure({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off' }, C);
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent_spawn', { name: 'native', cwd: f.directory, tools: [], model, operationId: 'native-tool-spawn' })], { stopReason: 'toolUse' }),
      answer('created'),
    ]);
    await (await host.root.submit({ type: 'input', content: 'create a child' }, C)).wait(C);
    const child = await host.child('native');
    const agent = await (await host.harness.conversation(child.conversationId, C))!.agent(C);
    assert.deepEqual(agent.tools, []);
    const tools = (await host.root.agent(C)).tools.map(t => t.name);
    assert.ok(tools.includes('subagent_spawn')); assert.ok(!tools.some(t => /halt|release|approve/.test(t)));
    await assert.rejects(() => host.peerSend(host.root.id, { recipient: 'native', message: 'spoof', operationId: 'spoof' }), /not a registered child/);
  } finally { await host.close(); await f.cleanup(); }
});

test('integrated host workflow uses native delivery tasks and human approval', { timeout: 10000 }, async () => {
  const { until } = await import('./helpers.js');
  const f = await setup(); const host = f.host;
  try {
    await f.spawn('worker'); f.faux.setResponses([answer('research'), answer('writeup')]);
    const id = await host.workflows.startWorkflow(host.root, { version: 1, name: 'integrated', limits: { concurrency: 2, maxAttempts: 3 }, steps: [
      { id: 'research', kind: 'task', agent: 'worker', instructions: 'research' },
      { id: 'approval', kind: 'approval', instructions: 'Review research', dependsOn: ['research'] },
      { id: 'writeup', kind: 'task', agent: 'worker', instructions: 'writeup', dependsOn: ['approval'] },
    ] }, 'workflow:integrated', C);
    host.harness.resume();
    await until(async () => Boolean((await host.workflows.inspectWorkflow(host.harness, id, C)).nodeAttempts.approval));
    assert.equal((await host.readReports({ acknowledge: false })).reports.length, 1);
    await host.workflows.approveWorkflow(host.root, id, 'approval', C);
    const settled = await host.harness.waitForTask(id, C);
    assert.equal(settled.state.outcome.status, 'completed');
    assert.equal((await host.readReports()).reports.length, 2);
  } finally { await host.close(); await f.cleanup(); }
});
