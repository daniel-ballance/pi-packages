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

test('sampling tools are proposals only, require release approval, and validate arguments', async () => {
  const enabled = { ...config, samplingTools: true };
  const request = {
    ...params,
    tools: [
      {
        name: 'weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    toolChoice: { mode: 'required' },
  };
  const h = context();
  let approvals = 0,
    calls = 0;
  h.ctx.ui.confirm = async () => {
    approvals++;
    return true;
  };
  h.ctx.modelRegistry.complete = async (_model: unknown, context: any) => {
    calls++;
    assert.equal(context.tools[0].name, 'weather');
    return {
      content: [
        { type: 'thinking', thinking: 'never released' },
        { type: 'toolCall', id: 'call1', name: 'weather', arguments: { city: 'Paris' } },
      ],
      stopReason: 'toolUse',
      usage,
    };
  };
  const result = await sample('s', enabled, h.ctx, request, undefined, () => {});
  assert.deepEqual(result.content, [
    { type: 'tool_use', id: 'call1', name: 'weather', input: { city: 'Paris' } },
  ]);
  assert.equal(result.stopReason, 'toolUse');
  assert.equal(approvals, 2);
  assert.equal(calls, 1);
  await assert.rejects(
    sample('s', enabled, h.ctx, { ...request, toolChoice: { mode: 'none' } }, undefined, () => {}),
    /Invalid sampled/,
  );
});

test('sampling converts balanced server tool transcripts without exposing Pi tools or running a loop', async () => {
  const h = context();
  h.ctx.modelRegistry.complete = async (_model: unknown, context: any) => {
    assert.deepEqual(
      context.messages.map((m: any) => m.role),
      ['user', 'assistant', 'toolResult'],
    );
    assert.deepEqual(context.messages[1].content, [
      {
        type: 'toolCall',
        id: 'one',
        name: 'weather',
        arguments: { city: 'Paris', options: { units: ['metric'], alerts: false }, limit: null },
      },
    ]);
    assert.equal(context.messages[2].toolName, 'weather');
    return { content: [{ type: 'text', text: 'sunny' }], stopReason: 'stop', usage };
  };
  const request = {
    ...params,
    messages: [
      params.messages[0],
      {
        role: 'assistant',
        content: {
          type: 'tool_use',
          id: 'one',
          name: 'weather',
          input: { city: 'Paris', options: { units: ['metric'], alerts: false }, limit: null },
        },
      },
      {
        role: 'user',
        content: {
          type: 'tool_result',
          toolUseId: 'one',
          content: [{ type: 'text', text: 'sunny' }],
        },
      },
    ],
  };
  const result = await sample(
    's',
    { ...config, samplingTools: true },
    h.ctx,
    request,
    undefined,
    () => {},
  );
  assert.equal(result.content.text, 'sunny');
  await assert.rejects(
    sample(
      's',
      { ...config, samplingTools: true },
      h.ctx,
      { ...request, messages: request.messages.slice(0, 2) },
      undefined,
      () => {},
    ),
    /Missing sampling tool results/,
  );
});
