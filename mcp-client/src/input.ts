import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ServerConfig } from './config.js';
import { RpcError } from './peer.js';
import { validator } from './validation.js';
import type { ObjectValue } from './headers.js';
import { sample, type SamplingUsage } from './sampling.js';

export function inputHandler(
  name: string,
  config: ServerConfig,
  context: ExtensionContext | (() => ExtensionContext),
  recordSampling: (usage: SamplingUsage, model: string) => void = () => {},
) {
  // Serialize dialogs; sibling tool calls may elicit concurrently.
  let queue: Promise<unknown> = Promise.resolve();
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
        `MCP ${name}: ${params.message}\nNever enter passwords, tokens or other secrets.`,
        ['Provide JSON', 'Decline'],
        { signal, timeout: config.timeout },
      );
      if (choice === undefined) return { action: 'cancel' };
      if (choice === 'Decline') return { action: 'decline' };
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        const value = await ctx.ui.input(
          `MCP ${name}: JSON matching ${JSON.stringify(params.requestedSchema)}`,
          '{}',
          { signal, timeout: config.timeout },
        );
        if (value === undefined) return { action: 'cancel' };
        try {
          const content = JSON.parse(value);
          if (validate(content)) return { action: 'accept', content };
        } catch {
          /* retry without logging entered values */
        }
        ctx.ui.notify('Input does not match the requested JSON schema.', 'warning');
      }
      return { action: 'cancel' };
    });
    queue = run.catch(() => {});
    return run;
  };
}
