import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type, fauxAssistantMessage, fauxToolCall } from '@durable-subagents/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { setup, answer } from './helpers.js';

for (const replay of ['unsafe', 'safe'] as const) {
  test(`${replay} interrupted tool obeys native replay contract on real SQLite reopen`, { timeout: 10000 }, async () => {
    let effects = 0, entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const tool = defineTool({ name: 'effect', description: 'Deterministic local test effect', parameters: Type.Object({}), replay,
      execute: async (_args, _api, context) => {
        effects++; entered();
        if (effects === 1) await new Promise<void>((_resolve, reject) => {
          const signal = context.abortSignal!;
          if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { content: [{ type: 'text', text: 'effect done' }] };
      },
    });
    const f = await setup({ tools: [tool] }, { allowedTools: ['effect'] }); let host = f.host;
    try {
      f.faux.setResponses([fauxAssistantMessage([fauxToolCall('effect', {})], { stopReason: 'toolUse' })]);
      await f.spawn('worker', ['effect']);
      const job = await host.send({ name: 'worker', message: 'use effect', operationId: 'effect-job' }); await reached;
      await host.close();
      f.faux.setResponses([answer('after interruption')]); host = await f.open();
      await host.wait(job.taskId);
      assert.equal(effects, replay === 'safe' ? 2 : 1);
    } finally { await host.close(); await f.cleanup(); }
  });
}

test('revoked safe tool is held before recovery and cannot replay committed intent', { timeout: 10000 }, async () => {
  let effects = 0, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const tool = defineTool({ name: 'effect', description: 'Local fake safe effect', parameters: Type.Object({}), replay: 'safe',
    execute: async (_args, _api, context) => {
      effects++; entered();
      return new Promise((_resolve, reject) => {
        const signal = context.abortSignal!;
        if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const f = await setup({ tools: [tool] }, { allowedTools: ['effect'] }); let host = f.host;
  try {
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall('effect', {})], { stopReason: 'toolUse' })]);
    await f.spawn('worker', ['effect']);
    const job = await host.send({ name: 'worker', message: 'effect', operationId: 'revoked' }); await reached;
    await host.close();
    let requests = 0; f.faux.setResponses([() => { requests++; return answer('forbidden'); }]);
    host = await f.open({ policy: { ...f.policy, allowedTools: [] } });
    assert.equal((await host.wait(job.taskId)).status, 'aborted');
    assert.equal((await host.child('worker')).hold!.confirmed, true);
    assert.equal(effects, 1); assert.equal(requests, 0);
    await host.release('worker');
    await assert.rejects(() => host.send({ name: 'worker', message: 'try', operationId: 'still-revoked' }), /not allowed/);
  } finally { await host.close(); await f.cleanup(); }
});
