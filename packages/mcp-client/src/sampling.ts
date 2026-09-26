import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { Type } from 'typebox';
import { validator } from './validation.js';
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
const ToolUse = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.json()),
});
const ToolResult = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string().min(1),
  content: z.array(z.union([Text, Image])),
  isError: z.boolean().optional(),
});
const Block = z.union([Text, Image, ToolUse, ToolResult]);
const Schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.union([Block, z.array(Block)]),
      }),
    )
    .min(1),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  includeContext: z.literal('none').optional(),
  stopSequences: z.array(z.string().min(1)).optional(),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(64)
    .optional(),
  toolChoice: z.object({ mode: z.enum(['auto', 'required', 'none']) }).optional(),
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
  if (
    !config.samplingTools &&
    (request.tools !== undefined ||
      request.toolChoice !== undefined ||
      request.messages.some((m) =>
        (Array.isArray(m.content) ? m.content : [m.content]).some(
          (b) => b.type === 'tool_use' || b.type === 'tool_result',
        ),
      ))
  )
    throw new RpcError(-32602, 'Sampling tools are not enabled');
  const validators = new Map(
    (request.tools ?? []).map((tool) => [tool.name, validator(tool.inputSchema)]),
  );
  if (validators.size !== (request.tools?.length ?? 0))
    throw new RpcError(-32602, 'Duplicate sampling tools');
  const model = ctx.model;
  const context: Parameters<ExtensionContext['modelRegistry']['complete']>[1] = {
    systemPrompt: request.systemPrompt,
    messages: [],
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? tool.name,
            parameters: Type.Unsafe({ ...tool.inputSchema, type: 'object' }),
          })),
        }
      : {}),
  };
  const zero: SamplingUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const pending = new Map<string, string>();
  const used = new Set<string>();
  for (const message of request.messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (
      pending.size &&
      (message.role !== 'user' ||
        results.length !== blocks.length ||
        results.length !== pending.size)
    )
      throw new RpcError(
        -32602,
        'Sampling tool uses require matching results immediately afterward',
      );
    if (message.role === 'user') {
      if (blocks.some((b) => b.type === 'tool_use'))
        throw new RpcError(-32602, 'Invalid user tool use');
      if (results.length) {
        if (results.length !== blocks.length)
          throw new RpcError(-32602, 'Mixed sampling tool results');
        for (const result of results) {
          const name = pending.get(result.toolUseId);
          if (!name) throw new RpcError(-32602, 'Unmatched sampling tool result');
          if (result.content.some((b) => b.type === 'image') && !model.input.includes('image'))
            throw new RpcError(-32602, 'Selected model cannot accept images');
          context.messages.push({
            role: 'toolResult',
            toolCallId: result.toolUseId,
            toolName: name,
            content: result.content,
            isError: result.isError ?? false,
            timestamp: Date.now(),
          });
          pending.delete(result.toolUseId);
        }
      } else {
        if (blocks.some((b) => b.type === 'image') && !model.input.includes('image'))
          throw new RpcError(-32602, 'Selected model cannot accept images');
        context.messages.push({
          role: 'user',
          content: blocks.filter((b) => b.type === 'text' || b.type === 'image'),
          timestamp: Date.now(),
        });
      }
    } else {
      if (blocks.some((b) => b.type === 'image' || b.type === 'tool_result'))
        throw new RpcError(-32602, 'Unsupported assistant sampling content');
      const content = blocks
        .filter((b) => b.type === 'text' || b.type === 'tool_use')
        .map((b) => {
          if (b.type === 'text') return b;
          if (used.has(b.id)) throw new RpcError(-32602, 'Duplicate sampling tool-use ID');
          used.add(b.id);
          pending.set(b.id, b.name);
          return { type: 'toolCall' as const, id: b.id, name: b.name, arguments: b.input };
        });
      context.messages.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zero,
        stopReason: pending.size ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      });
    }
  }
  if (pending.size) throw new RpcError(-32602, 'Missing sampling tool results');
  const maxTokens = Math.min(request.maxTokens, config.samplingMaxTokens, model.maxTokens);
  signal?.throwIfAborted();
  if (
    !(await ctx.ui.confirm(
      `MCP ${name}: allow billed sampling with ${model.provider}/${model.id}?`,
      `Maximum output tokens: ${maxTokens}. Only this server-supplied input and tool definitions are sent; no Pi session context or Pi tools. Proposed tool calls are NOT executed by Pi.\n\n${JSON.stringify(request, null, 2)}`,
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
    toolChoice: request.toolChoice?.mode === 'none' ? 'none' : 'auto',
  });
  record(response.usage, `${model.provider}/${model.id}`);
  if (!['stop', 'length', 'toolUse'].includes(response.stopReason))
    throw new RpcError(-32603, 'Sampling failed or was cancelled');
  const calls = response.content.filter((b) => b.type === 'toolCall');
  if (calls.length) {
    if (
      !config.samplingTools ||
      request.toolChoice?.mode === 'none' ||
      new Set(calls.map((c) => c.id)).size !== calls.length ||
      calls.some((call) => !validators.get(call.name)?.(call.arguments))
    )
      throw new RpcError(-32603, 'Invalid sampled tool calls');
    const content = response.content
      .filter((b) => b.type === 'text' || b.type === 'toolCall')
      .map((b) =>
        b.type === 'text'
          ? { type: 'text', text: b.text }
          : { type: 'tool_use', id: b.id, name: b.name, input: b.arguments },
      );
    signal?.throwIfAborted();
    if (
      !(await ctx.ui.confirm(
        `MCP ${name}: release proposed tool calls for SERVER execution?`,
        JSON.stringify(content, null, 2),
        { signal, timeout: config.timeout },
      ))
    )
      throw new RpcError(-32603, 'Sample release declined');
    return { role: 'assistant', content, model: model.id, stopReason: 'toolUse' };
  }
  if (request.toolChoice?.mode === 'required')
    throw new RpcError(-32603, 'Selected model did not provide required tool use');
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
