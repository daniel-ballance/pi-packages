// Deterministic UI driver, loaded by Pi (which supplies the pi-ai import).
// No network calls, credentials, or model reasoning; only fixture MCP calls.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { toolName } from '../../src/index.ts';

export default function (pi) {
  pi.registerProvider('mcp-ui-fixture', {
    baseUrl: 'http://unused.invalid',
    apiKey: 'fixture-only',
    api: 'openai-completions',
    models: [
      {
        id: 'offline',
        name: 'Offline MCP UI fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const lastUser = context.messages.findLastIndex((m) => m.role === 'user');
      const prompt = JSON.stringify(context.messages[lastUser]?.content ?? '');
      const answered = context.messages.slice(lastUser + 1).some((m) => m.role === 'toolResult');
      const name = prompt.includes('form')
        ? 'ask_form'
        : prompt.includes('fail')
          ? 'fail'
          : 'slow_preview';
      const output = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        if (options?.signal?.aborted) {
          output.stopReason = 'aborted';
          output.errorMessage = 'Fixture cancelled';
          stream.push({ type: 'error', reason: 'aborted', error: output });
          stream.end();
          return;
        }
        stream.push({ type: 'start', partial: output });
        if (!answered) {
          const toolCall = {
            type: 'toolCall',
            id: `fixture-${Date.now()}`,
            name: toolName('demo', name),
            arguments:
              name === 'slow_preview'
                ? {
                    target: 'fixture:notes',
                    enabled: false,
                    options: { token: 'fixture-secret', count: 2 },
                  }
                : {},
          };
          output.content.push(toolCall);
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output });
          stream.push({
            type: 'toolcall_delta',
            contentIndex: 0,
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: output });
          output.stopReason = 'toolUse';
        } else {
          const text = 'Offline fixture finished. No paid model or external service was used.';
          output.content.push({ type: 'text', text });
          stream.push({ type: 'text_start', contentIndex: 0, partial: output });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output });
        }
        stream.push({ type: 'done', reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
}
