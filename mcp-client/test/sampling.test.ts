import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sample } from '../src/sampling.js';
import { ServerSchema } from '../src/config.js';

const config = ServerSchema.parse({
  transport: 'stdio',
  command: 'unused',
  sampling: true,
  samplingMaxTokens: 100,
});
const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};
const params = {
  messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
  maxTokens: 500,
  stopSequences: ['STOP'],
};
function context(approvals = [true, true]) {
  let called = 0;
  const ctx: any = {
    hasUI: true,
    model: {
      id: 'fixture',
      provider: 'test',
      api: 'openai-completions',
      maxTokens: 1000,
      input: ['text'],
    },
    ui: { confirm: async () => approvals.shift() },
    modelRegistry: {
      complete: async (_model: unknown, context: any, options: any) => {
        called++;
        assert.equal(context.tools, undefined);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0].content[0].text, 'hello');
        assert.equal(options.maxTokens, 100);
        return {
          content: [
            { type: 'thinking', thinking: 'private reasoning' },
            { type: 'text', text: 'answerSTOPextra' },
          ],
          stopReason: 'stop',
          usage,
        };
      },
    },
  };
  return { ctx, calls: () => called };
}

test('sampling is separately approved, bounded, metered and releases text only', async () => {
  const h = context(),
    recorded: unknown[] = [];
  const result = await sample('s', config, h.ctx, params, undefined, (u) => recorded.push(u));
  assert.equal(h.calls(), 1);
  assert.deepEqual(recorded, [usage]);
  assert.deepEqual(result, {
    role: 'assistant',
    content: { type: 'text', text: 'answer' },
    model: 'fixture',
    stopReason: 'stopSequence',
  });
});

test('declined sampling never invokes the model; declined release still accounts for usage', async () => {
  const declined = context([false]);
  await assert.rejects(
    sample('s', config, declined.ctx, params, undefined, () => {}),
    /declined/,
  );
  assert.equal(declined.calls(), 0);
  const release = context([true, false]),
    recorded: unknown[] = [];
  await assert.rejects(
    sample('s', config, release.ctx, params, undefined, (u) => recorded.push(u)),
    /declined/,
  );
  assert.equal(release.calls(), 1);
  assert.equal(recorded.length, 1);
});

test('sampling refuses unsupported context sharing, tools, disabled and headless requests', async () => {
  const h = context();
  for (const extra of [{ includeContext: 'allServers' }, { tools: [] }])
    await assert.rejects(sample('s', config, h.ctx, { ...params, ...extra }, undefined, () => {}));
  await assert.rejects(
    sample('s', { ...config, sampling: false }, h.ctx, params, undefined, () => {}),
  );
  h.ctx.hasUI = false;
  await assert.rejects(sample('s', config, h.ctx, params, undefined, () => {}));
  assert.equal(h.calls(), 0);
});
