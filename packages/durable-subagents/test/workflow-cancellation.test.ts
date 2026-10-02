import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';
import { setup, answer, until } from './helpers.js';

test('aborting a workflow observer preserves its already-admitted background delivery', { timeout: 10000 }, async () => {
  const f = await setup();
  let finish!: () => void, entered!: () => void, signal: AbortSignal | undefined;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  f.faux.setResponses([(_request, options) => new Promise((resolve, reject) => {
    signal = options!.signal!;
    finish = () => resolve(answer('independently owned work finished'));
    entered();
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
  })]);
  try {
    await f.spawn('worker');
    const id = await f.host.workflows.startWorkflow(f.host.root, {
      version: 1, name: 'observer ownership', limits: { concurrency: 1, maxAttempts: 2 },
      steps: [{ id: 'work', kind: 'task', agent: 'worker', instructions: 'wait for synthetic completion' }],
    }, 'workflow:observer', C);
    f.host.harness.resume(); await reached;
    await f.host.harness.abortTask(id, C);
    assert.equal((await f.host.harness.waitForTask(id, C)).state.outcome.status, 'aborted');
    assert.equal(signal!.aborted, false);
    assert.equal((await f.host.list()).agents[0]!.status, 'working');
    finish();
    await until(async () => (await f.host.list()).unreadReports === 1);
    assert.equal((await f.host.readReports()).reports[0]!.text, 'independently owned work finished');
    assert.equal((await f.host.list()).agents[0]!.status, 'idle');
  } finally { finish?.(); await f.host.close(); await f.cleanup(); }
});
