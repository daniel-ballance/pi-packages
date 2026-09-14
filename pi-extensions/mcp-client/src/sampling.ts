import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { RpcError } from './peer.js';
import type { ObjectValue } from './headers.js';

type Completion = Awaited<ReturnType<ExtensionContext['modelRegistry']['complete']>>;
export type SamplingUsage = Completion['usage'];
const Text = z.object({ type: z.literal('text'), text: z.string() });
const Image = z.object({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
});
const Schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.union([Text, Image, z.array(z.union([Text, Image]))]),
      }),
    )
    .min(1),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  includeContext: z.literal('none').optional(),
  stopSequences: z.array(z.string().min(1)).optional(),
  tools: z.never().optional(),
  toolChoice: z.never().optional(),
});

/** A separately approved completion, not an agent run and never a session-context export. */
export async function sample(
  name: string,
  config: ServerConfig,
  ctx: ExtensionContext,
  params: ObjectValue,
  signal: AbortSignal | undefined,
  record: (usage: SamplingUsage, model: string) => void,
): Promise<ObjectValue> {
  if (!config.sampling || !ctx.hasUI || !ctx.model)
    throw new RpcError(-32601, 'Sampling is not enabled');
  if (Buffer.byteLength(JSON.stringify(params)) > 50 * 1024)
    throw new RpcError(-32602, 'Sampling input exceeds 50 KiB');
  const request = Schema.parse(params);
  const model = ctx.model;
  const context: Parameters<ExtensionContext['modelRegistry']['complete']>[1] = {
    systemPrompt: request.systemPrompt,
    messages: [],
  };
  const zero: SamplingUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const message of request.messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    if (message.role === 'user') {
      if (blocks.some((b) => b.type === 'image') && !model.input.includes('image'))
        throw new RpcError(-32602, 'Selected model cannot accept images');
      context.messages.push({ role: 'user', content: blocks, timestamp: Date.now() });
    } else {
      if (blocks.some((b) => b.type !== 'text'))
        throw new RpcError(-32602, 'Pi cannot represent assistant image input');
      context.messages.push({
        role: 'assistant',
        content: blocks.filter((b) => b.type === 'text'),
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zero,
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    }
  }
  const maxTokens = Math.min(request.maxTokens, config.samplingMaxTokens, model.maxTokens);
  signal?.throwIfAborted();
  if (
    !(await ctx.ui.confirm(
      `MCP ${name}: allow billed sampling with ${model.provider}/${model.id}?`,
      `Maximum output tokens: ${maxTokens}. Only this server-supplied input is sent; no Pi session context or tools.\n\n${JSON.stringify(request, null, 2)}`,
      { signal, timeout: config.timeout },
    ))
  )
    throw new RpcError(-32603, 'Sampling declined');
  signal?.throwIfAborted();
  const response = await ctx.modelRegistry.complete(model, context, {
    signal,
    maxTokens,
    temperature: request.temperature,
    cacheRetention: 'none',
  });
  record(response.usage, `${model.provider}/${model.id}`);
  if (!['stop', 'length'].includes(response.stopReason))
    throw new RpcError(-32603, 'Sampling failed or was cancelled');
  let text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  let stopReason = response.stopReason === 'length' ? 'maxTokens' : 'endTurn';
  const stops = (request.stopSequences ?? []).map((s) => text.indexOf(s)).filter((i) => i >= 0);
  if (stops.length) {
    text = text.slice(0, Math.min(...stops));
    stopReason = 'stopSequence';
  }
  // Reasoning, provider metadata, errors and credentials are never returned to the server.
  signal?.throwIfAborted();
  if (
    !(await ctx.ui.confirm(
      `MCP ${name}: send sampled text to server?`,
      text || '(Empty response)',
      { signal, timeout: config.timeout },
    ))
  )
    throw new RpcError(-32603, 'Sample release declined');
  return { role: 'assistant', content: { type: 'text', text }, model: model.id, stopReason };
}
