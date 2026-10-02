import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT as C, awaitWithContext } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type Conversation, type TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createWorkflowTask, parseWorkflow, type WorkflowDefinition, type WorkflowDeliveryResult, type WorkflowSendRequest } from '../src/workflows.js';

const definition = (steps: WorkflowDefinition['steps'], concurrency = 2, maxAttempts = 20): WorkflowDefinition => ({ version: 1, name: 'Test workflow', limits: { concurrency, maxAttempts }, steps });
const work = (id: string, dependsOn: string[] = []) => ({ id, kind: 'task' as const, agent: id, instructions: `Do ${id}`, dependsOn });
const FakeDeliveries = defineDoc<{ operations: Record<string, TaskId<WorkflowDeliveryResult>> }>({ kind: 'test.workflow-deliveries', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ operations: {} }) });
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(options: { failFirst?: string; interruptAfterAdmission?: boolean; beforeAdmission?: (request: WorkflowSendRequest) => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'native-workflow-test-'));
  let harness!: Harness, root!: Conversation;
  const admitted: string[] = [], finished: string[] = [];
  let active = 0, maxActive = 0, interrupt = options.interruptAfterAdmission ?? false;
  const unavailable = new Set<string>();
  const Delivery = defineTask<{ agent: string; message: string; operationId: string }, { phase: 'execute' }, WorkflowDeliveryResult>({
    name: 'test.workflow-delivery', version: 1, initial: () => ({ phase: 'execute' }), phases: {
      execute: async (task, runtime, context) => {
        active++; maxActive = Math.max(maxActive, active);
        try {
          await runtime.sleep(runtime.now() + 15, context);
          const fail = options.failFirst === task.input.agent && task.input.operationId.endsWith(':1');
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: fail ? { status: 'failed', reason: 'scripted failure' } : { status: 'completed', output: `output ${task.input.agent}` } } }), context);
          finished.push(task.input.agent);
        } finally { active--; }
      },
    }, abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const workflows = createWorkflowTask({
    assertCanDispatch: async agent => { if (unavailable.has(agent)) throw new Error('agent held'); },
    send: async (request, context) => {
      await options.beforeAdmission?.(request);
      const taskId = await root.commit(async tx => {
        const state = await tx.doc(FakeDeliveries, root.id);
        if (Object.hasOwn(state.operations, request.operationId)) return state.operations[request.operationId];
        await request.guard(tx);
        if (unavailable.has(request.agent)) throw new Error('agent held at admission');
        const taskId = await tx.createTask(Delivery, { agent: request.agent, message: request.message, operationId: request.operationId }, { ownership: { kind: 'conversation' }, background: true });
        state.operations[request.operationId] = taskId;
        admitted.push(request.operationId);
        return taskId;
      }, context);
      if (interrupt) {
        interrupt = false;
        await awaitWithContext(new Promise<void>(() => {}), context);
      }
      return { taskId };
    },
  });
  const open = async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'test.workflows', tasks: [...workflows.tasks, Delivery] }));
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')), { models: createModels(), registry }, C);
    root = await harness.root(C);
  };
  await open();
  return {
    workflows, admitted, finished, unavailable, get harness() { return harness; }, get root() { return root; }, get maxActive() { return maxActive; },
    start: (value: WorkflowDefinition, operationId = 'workflow-start') => workflows.startWorkflow(root, value, operationId, C),
    inspect: (id: TaskId) => workflows.inspectWorkflow(harness, id as Parameters<typeof workflows.inspectWorkflow>[1], C),
    reopen: async () => { await harness.close(C); await open(); },
    close: async () => { await harness.close(C); await rm(dir, { recursive: true, force: true }); },
  };
}

test('strict DSL rejects cycles, missing nodes, duplicate IDs, unsupported legacy features and impossible attempt budgets', () => {
  assert.throws(() => parseWorkflow(definition([work('a', ['b']), work('b', ['a'])])), /DAG/);
  assert.throws(() => parseWorkflow(definition([work('a', ['missing'])])), /Unknown dependency/);
  assert.throws(() => parseWorkflow(definition([work('a'), work('a')])), /unique/);
  assert.throws(() => parseWorkflow({ ...definition([work('a')]), peers: [] }), /unsupported/);
  assert.throws(() => parseWorkflow(definition([{ ...work('a'), kind: 'loop' } as never])), /unsupported/);
  assert.throws(() => parseWorkflow(definition([work('a'), work('b')], 2, 1)), /accommodate/);
});

test('native DAG joins dependencies, bounds concurrency and deduplicates starts', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const def = definition([work('a'), work('b'), work('c'), work('merge', ['a', 'b', 'c'])]);
    const id = await f.start(def);
    assert.equal(await f.start(def), id);
    await assert.rejects(f.start({ ...def, name: 'changed' }), /different definition/);
    const settled = await f.harness.waitForTask(id, C);
    assert.equal(settled.state.outcome.status, 'completed');
    assert.equal(f.admitted.length, 4);
    assert.equal(f.maxActive, 2);
    assert.equal(f.finished.at(-1), 'merge');
    const inspection = await f.inspect(id);
    assert.equal(Object.keys(inspection.nodeAttempts).length, 4);
    assert.ok(Object.values(inspection.nodeAttempts).every(attempts => attempts.length === 1 && attempts[0].outcome?.status === 'completed'));
  } finally { await f.close(); }
});

test('approval gate requires explicit approval after dependencies complete', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const id = await f.start(definition([work('draft'), { id: 'review', kind: 'approval', instructions: 'Review draft', dependsOn: ['draft'] }, work('publish', ['review'])]));
    await assert.rejects(f.workflows.approveWorkflow(f.root, id, 'review', C), /not ready/);
    f.harness.resume();
    await until(() => f.inspect(id), value => Boolean(value.nodeAttempts.review));
    assert.equal(f.admitted.length, 1);
    await f.workflows.approveWorkflow(f.root, id, 'review', C);
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    assert.equal(f.admitted.length, 2);
  } finally { await f.close(); }
});

test('persisted hold and release never implicitly restart; explicit resume does', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const id = await f.start(definition([work('a')]));
    await f.workflows.holdWorkflow(f.root, id, C);
    await f.reopen();
    f.harness.resume();
    await until(() => f.inspect(id), value => value.phase === 'control');
    assert.equal(f.admitted.length, 0);
    await assert.rejects(f.workflows.resumeWorkflow(f.root, id, C), /Release/);
    await f.workflows.releaseWorkflow(f.root, id, C);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.admitted.length, 0);
    assert.equal((await f.inspect(id)).control?.resumeRequired, true);
    await f.workflows.resumeWorkflow(f.root, id, C);
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    assert.equal(f.admitted.length, 1);
  } finally { await f.close(); }
});

test('failed steps need named retries and preserve successful dependencies across reopen', { timeout: 10000 }, async () => {
  const f = await fixture({ failFirst: 'b' });
  try {
    const id = await f.start(definition([work('a'), work('b', ['a']), work('c', ['b'])]));
    f.harness.resume();
    await until(() => f.inspect(id), value => value.phase === 'control' && value.nodeAttempts.b?.[0].outcome?.status === 'failed');
    const firstA = (await f.inspect(id)).nodeAttempts.a[0].taskId;
    await f.reopen(); f.harness.resume();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.admitted.length, 2);
    await assert.rejects(f.workflows.retryWorkflow(f.root, id, 'a', C), /completed nodes cannot/);
    await f.workflows.retryWorkflow(f.root, id, 'b', C);
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    const inspection = await f.inspect(id);
    assert.equal(inspection.nodeAttempts.a.length, 1);
    assert.equal(inspection.nodeAttempts.a[0].taskId, firstA);
    assert.equal(inspection.nodeAttempts.b.length, 2);
    assert.equal(f.admitted.length, 4);
  } finally { await f.close(); }
});

test('native maxAttempts prevents automatic retries or exhausted explicit retries', { timeout: 10000 }, async () => {
  const f = await fixture({ failFirst: 'a' });
  try {
    const id = await f.start(definition([work('a')], 1, 1));
    const outcome = (await f.harness.waitForTask(id, C)).state.outcome;
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.match(outcome.error.message, /maxAttempts/);
    assert.equal(f.admitted.length, 1);
    await assert.rejects(f.workflows.retryWorkflow(f.root, id, 'a', C), /already settled/);
  } finally { await f.close(); }
});

test('crash after native admission before checkpoint reuses exactly one delivery operation', { timeout: 10000 }, async () => {
  const f = await fixture({ interruptAfterAdmission: true });
  try {
    const id = await f.start(definition([work('a')]));
    f.harness.resume();
    await until(async () => f.admitted.length, value => value === 1);
    await f.reopen();
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    assert.equal(f.admitted.length, 1);
    assert.equal((await f.inspect(id)).nodeAttempts.a.length, 1);
  } finally { await f.close(); }
});

test('agent hold preflight blocks workflow until explicit resume even after agent release', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    f.unavailable.add('a');
    const id = await f.start(definition([work('a')]));
    f.harness.resume();
    await until(() => f.inspect(id), value => value.control?.resumeRequired === true);
    f.unavailable.delete('a');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.admitted.length, 0);
    await f.workflows.resumeWorkflow(f.root, id, C);
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
  } finally { await f.close(); }
});

test('atomic admission guard closes hold racing between preflight and delivery admission', { timeout: 10000 }, async () => {
  let entered!: () => void, unblock!: () => void;
  const admissionEntered = new Promise<void>(resolve => { entered = resolve; });
  const admissionBlocked = new Promise<void>(resolve => { unblock = resolve; });
  let first = true;
  const f = await fixture({ beforeAdmission: async () => { if (first) { first = false; entered(); await admissionBlocked; } } });
  try {
    const id = await f.start(definition([work('a')]));
    f.harness.resume();
    await admissionEntered;
    await f.workflows.holdWorkflow(f.root, id, C);
    unblock();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.admitted.length, 0);
    await f.workflows.releaseWorkflow(f.root, id, C);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.admitted.length, 0);
    await f.workflows.resumeWorkflow(f.root, id, C);
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    assert.equal((await f.inspect(id)).nodeAttempts.a.length, 1);
  } finally { unblock(); await f.close(); }
});

test('hold lets an admitted delivery finish while fencing all later dependent dispatch', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const id = await f.start(definition([work('a'), work('b', ['a'])], 1));
    f.harness.resume();
    await until(async () => f.admitted.length, value => value === 1);
    await f.workflows.holdWorkflow(f.root, id, C);
    await until(() => f.inspect(id), value => value.phase === 'control');
    assert.deepEqual(f.finished, ['a']);
    assert.equal(f.admitted.length, 1);
    await f.workflows.releaseWorkflow(f.root, id, C);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.admitted.length, 1);
    await f.workflows.resumeWorkflow(f.root, id, C);
    assert.equal((await f.harness.waitForTask(id, C)).state.outcome.status, 'completed');
    assert.deepEqual(f.finished, ['a', 'b']);
  } finally { await f.close(); }
});
