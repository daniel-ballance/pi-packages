import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ServerConfig } from './config.js';
import { RpcError } from './peer.js';
import { validator, validationIssue } from './validation.js';
import { canGuide, fillFields, formSummary } from './forms.js';
import { displayText } from './diagnostics.js';
import type { ObjectValue } from './headers.js';
import { sample, type SamplingUsage } from './sampling.js';

// Pi has one dialog surface, not one per MCP server.
let queue: Promise<unknown> = Promise.resolve();
export function withMcpDialog<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

export function inputHandler(
  name: string,
  config: ServerConfig,
  context: ExtensionContext | (() => ExtensionContext),
  recordSampling: (usage: SamplingUsage, model: string) => void = () => {},
  openUrl?: (url: string) => Promise<void>,
) {
  return async (
    method: string,
    params: ObjectValue,
    signal?: AbortSignal,
  ): Promise<ObjectValue> => {
    const ctx = typeof context === 'function' ? context() : context;
    signal = AbortSignal.any([
      AbortSignal.timeout(config.timeout),
      ...(signal ? [signal] : []),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
    signal.throwIfAborted();
    if (method === 'sampling/createMessage') {
      const run = queue.then(() => sample(name, config, ctx, params, signal, recordSampling));
      queue = run.catch(() => {});
      return run;
    }
    if (method === 'roots/list' && config.roots !== undefined)
      return {
        roots: config.roots.map((path) => ({ uri: pathToFileURL(resolve(ctx.cwd, path)).href })),
      };
    if (
      method === 'elicitation/create' &&
      params.mode === 'url' &&
      config.elicitationUrl &&
      ctx.hasUI &&
      openUrl
    ) {
      const run = queue.then(async () => {
        signal?.throwIfAborted();
        if (
          typeof params.message !== 'string' ||
          typeof params.elicitationId !== 'string' ||
          typeof params.url !== 'string' ||
          Buffer.byteLength(JSON.stringify(params)) > 50 * 1024
        )
          throw new RpcError(-32602, 'Invalid URL elicitation');
        const url = new URL(params.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new RpcError(-32602, 'Unsafe elicitation URL');
        const choice = await ctx.ui.select(
          `MCP ${name}: ${params.message}\nOpen in your browser: ${url.href}\nOnly continue if you trust this site.`,
          ['Open URL', 'Decline'],
          { signal, timeout: config.timeout },
        );
        if (choice === undefined) return { action: 'cancel' };
        if (choice !== 'Open URL') return { action: 'decline' };
        signal?.throwIfAborted();
        await openUrl(url.href);
        return { action: 'accept' };
      });
      queue = run.catch(() => {});
      return run;
    }
    if (
      method !== 'elicitation/create' ||
      !config.elicitation ||
      !ctx.hasUI ||
      params.mode === 'url'
    )
      throw new RpcError(-32601, 'Client capability not enabled');
    const run = queue.then(async () => {
      signal?.throwIfAborted();
      if (
        !params.requestedSchema ||
        typeof params.message !== 'string' ||
        Buffer.byteLength(JSON.stringify(params)) > 50 * 1024
      )
        throw new RpcError(-32602, 'Invalid or oversized elicitation');
      const validate = validator(params.requestedSchema);
      const choice = await ctx.ui.select(
        `MCP ${displayText(name, 80)}: ${displayText(params.message, 600)}\nNever enter passwords, tokens or other secrets.`,
        [
          ...(canGuide(params.requestedSchema) ? ['Fill in fields'] : []),
          'Provide JSON',
          'Decline',
        ],
        { signal, timeout: config.timeout },
      );
      if (choice === undefined) return { action: 'cancel' };
      if (choice === 'Decline') return { action: 'decline' };
      if (choice === 'Fill in fields') {
        const content = await fillFields(ctx, `MCP ${name}`, params.requestedSchema, {
          signal,
          timeout: config.timeout,
        });
        if (content === undefined) return { action: 'cancel' };
        if (validate(content)) {
          const release = await ctx.ui.select(
            `MCP ${displayText(name, 80)}: review answers before sending\n${formSummary(content)}`,
            ['Send answers', 'Cancel'],
            { signal, timeout: config.timeout },
          );
          signal?.throwIfAborted();
          return release === 'Send answers' ? { action: 'accept', content } : { action: 'cancel' };
        }
        ctx.ui.notify(
          `Answers do not satisfy the complete schema (${validationIssue(validate)}). Use JSON instead.`,
          'warning',
        );
      } else if (choice !== 'Provide JSON') return { action: 'cancel' };
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        const value = await ctx.ui.input(
          `MCP ${displayText(name, 80)}: JSON matching ${displayText(JSON.stringify(params.requestedSchema), 4000)}`,
          '{}',
          { signal, timeout: config.timeout },
        );
        if (value === undefined) return { action: 'cancel' };
        signal?.throwIfAborted();
        let content: ObjectValue;
        try {
          content = JSON.parse(value);
        } catch {
          ctx.ui.notify('Input must be valid JSON. Entered values are not logged.', 'warning');
          continue;
        }
        if (validate(content)) return { action: 'accept', content };
        ctx.ui.notify(
          `Input does not match the requested schema (${validationIssue(validate)}).`,
          'warning',
        );
      }
      return { action: 'cancel' };
    });
    queue = run.catch(() => {});
    return run;
  };
}
