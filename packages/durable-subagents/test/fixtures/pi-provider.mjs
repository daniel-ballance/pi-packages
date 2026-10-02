import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function (pi) {
  let calls = 0;
  pi.registerProvider('durable-fixture', {
    baseUrl: 'http://unused.invalid', apiKey: 'fixture-only', api: 'openai-completions',
    models: [{ id: 'scripted', name: 'Scripted offline fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      if (++calls > 12) throw new Error('Fixture inference call limit exceeded');
      const child = context.messages.some(m => m.role === 'system' && JSON.stringify(m).includes('You are subagent'));
      const results = context.messages.filter(m => m.role === 'toolResult');
      const report = context.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('Durable subagent reports'));
      let content = [{ type: 'text', text: child ? 'CHILD RESULT' : report ? 'PARENT REPORT RECEIVED' : 'PARENT FINISHED' }], stopReason = 'stop';
      if (!child && !report) {
        let tool;
        if (!results.some(m => m.toolName === 'durable_subagent_spawn')) tool = { name: 'durable_subagent_spawn', arguments: { name: 'worker', cwd: process.cwd(), model: { provider: 'durable-fixture', model: 'scripted', thinking: 'off' }, tools: [], operationId: 'fixture-spawn' } };
        else if (!results.some(m => m.toolName === 'durable_subagent_send')) tool = { name: 'durable_subagent_send', arguments: { name: 'worker', message: 'Return CHILD RESULT.', operationId: 'fixture-send' } };
        if (tool) { content = [{ type: 'toolCall', id: `fixture-${calls}`, ...tool }]; stopReason = 'toolUse'; }
      }
      const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: output }); stream.push({ type: 'done', reason: stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
  pi.registerCommand('fixture-exit', { description: 'Offline fixture shutdown', handler: async (_args, ctx) => ctx.shutdown() });
}
