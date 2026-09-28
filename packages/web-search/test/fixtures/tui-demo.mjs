/** Manual TUI fixture. Load explicitly alongside web-search; never installed as an extension.
 * No model requests. Searches are mocked except the explicit `live` scenario.
 * Prompts: success, empty, blocked, unexpected, network, slow, live.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function (pi) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://html.duckduckgo.com') throw new Error('Demo only supports DuckDuckGo');
    const query = url.searchParams.get('q');
    if (query === 'site:typescriptlang.org satisfies operator') return realFetch(input, init);
    await delay(query === 'slow' ? 30_000 : 3_000, undefined, { signal: init?.signal });
    if (query === 'network') throw new TypeError('Mock connection failure');
    if (query === 'blocked') return new Response('', { status: 429 });
    if (query === 'empty') return new Response('<div class="no-results"/>');
    if (query === 'unexpected') return new Response('<html>Changed markup</html>');
    return new Response(Array.from({ length: 5 }, (_, i) =>
      `<div class="result"><a class="result__a" href="https://example.com/docs/${i}">Documentation ${i + 1} — 日本語 🧪</a><div class="result__snippet">Example snippet ${i + 1}. ${'Bounded source text. '.repeat(30)}</div></div>`).join(''));
  };
  pi.on('session_shutdown', () => { globalThis.fetch = realFetch; });
  pi.registerProvider('search-demo', {
    baseUrl: 'http://unused.invalid', apiKey: 'fixture-only', api: 'openai-completions',
    models: [{ id: 'stub', name: 'Search display fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const last = context.messages.at(-1);
      const finished = last?.role === 'toolResult';
      const prompt = context.messages.findLast(m => m.role === 'user');
      const scenario = typeof prompt?.content === 'string' ? prompt.content : prompt?.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
      const query = scenario === 'live' ? 'site:typescriptlang.org satisfies operator' : scenario || 'success';
      const content = finished ? [{ type: 'text', text: 'Display fixture complete (no model inference).' }]
        : [{ type: 'toolCall', id: `search-${Date.now()}`, name: 'web_search', arguments: { query, limit: 5 } }];
      const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content, stopReason: finished ? 'stop' : 'toolUse', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: output });
        if (!finished) {
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: output });
        }
        stream.push({ type: 'done', reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
}
